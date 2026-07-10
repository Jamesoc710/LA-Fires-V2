
import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { loadAllContextFiles, loadMunicodeContext } from "../../utils/contextLoader";
import { runParcelLookup } from "@/lib/la/parcelLookup";
import { createRequestLogger, logRequestMetrics, createTimer } from "@/lib/la/logger";
import { checkRateLimit, getClientIdentifier, getRateLimitHeaders, RATE_LIMITS } from "@/lib/la/rateLimit";
import type { StreamFrame } from "@/app/types/chat";

export const runtime = "nodejs";
const OR_API_KEY = process.env.OPENROUTER_API_KEY;

if (!OR_API_KEY) {
  console.warn("[WARN] Missing OPENROUTER_API_KEY — OpenRouter requests will fail");
}

/* ---------------- OpenRouter primary + fallback ---------------- */

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

function toOpenAIStyleMessages(geminiStyleContents: any[]) {
  return geminiStyleContents.map((c: any) => ({
    role: c.role === "model" ? "assistant" : c.role,
    content: (c.parts || []).map((p: any) => p.text).join(""),
  }));
}

async function callOpenRouter(
  model: string,
  contents: any[],
  req?: NextRequest,
  temperature = 0.2
) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  const messages = toOpenAIStyleMessages(contents);
  const refHost = req?.headers.get("host") || "la-fires-v2.vercel.app";
  const referer = `https://${refHost}`;

  console.log("[OpenRouter] attempt", model);
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": referer,
      "X-Title": "LA-Fires V2",
    },
    body: JSON.stringify({ model, messages, temperature }),
  });

  if (!r.ok) {
    const body = await r.text().catch(() => "");
    console.error("[OpenRouter] HTTP", r.status, "model:", model, "body:", body.slice(0, 400));
    throw new Error(`OpenRouter ${r.status}: ${body}`);
  }

  const json = await r.json();
  const text = json?.choices?.[0]?.message?.content ?? "";
  console.log("[OpenRouter] OK", model, "len:", text.length);
  if (!text) throw new Error("Empty response from OpenRouter");
  return text.trim();
}

async function orWithRetryAndFallback(contents: any[], req: NextRequest, temperature = 0.2) {
  const PRIMARY  = process.env.OR_PRIMARY_MODEL  || "google/gemini-3.1-flash-lite";
  const FALLBACK = process.env.OR_FALLBACK_MODEL || "anthropic/claude-sonnet-4.6";
  const plans: [string, number][] = [[PRIMARY, 2], [FALLBACK, 1]];

  for (const [model, tries] of plans) {
    for (let i = 1; i <= tries; i++) {
      try {
        return await callOpenRouter(model, contents, req, temperature);
      } catch (e: any) {
        const msg = String(e?.message || e);
        const retriable = /(?:429|5\d\d|timeout|network|fetch|rate|busy)/i.test(msg);
        console.warn(`[OpenRouter] attempt failed (${model} try ${i}):`, msg.slice(0, 200));
        if (!retriable || i === tries) break;
        await sleep(Math.min(6000, 600 * 2 ** (i - 1)));
      }
    }
  }
  throw new Error("All OpenRouter attempts failed");
}

function friendlyFallbackMessage() {
  return "The AI service is busy right now. I still fetched your zoning/overlays/assessor links—try the AI summary again in a moment.";
}

/* --------------- Streaming variant of the OpenRouter call --------------- */

// Stream a single model attempt, yielding content deltas parsed from the
// OpenAI-style SSE `data:` frames OpenRouter returns when `stream: true`.
async function* streamOpenRouterOnce(
  model: string,
  contents: any[],
  req: NextRequest,
  temperature: number
): AsyncGenerator<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  const messages = toOpenAIStyleMessages(contents);
  const refHost = req?.headers.get("host") || "la-fires-v2.vercel.app";
  const referer = `https://${refHost}`;

  console.log("[OpenRouter] stream attempt", model);
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": referer,
      "X-Title": "LA-Fires V2",
    },
    body: JSON.stringify({ model, messages, temperature, stream: true }),
  });

  if (!r.ok) {
    const body = await r.text().catch(() => "");
    console.error("[OpenRouter] HTTP", r.status, "model:", model, "body:", body.slice(0, 400));
    throw new Error(`OpenRouter ${r.status}: ${body}`);
  }
  if (!r.body) throw new Error("Empty stream body from OpenRouter");

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line || line.startsWith(":")) continue; // blank / SSE comment (keepalive)
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data);
        const delta = json?.choices?.[0]?.delta?.content ?? "";
        if (delta) yield delta as string;
      } catch {
        // ignore partial / non-JSON keepalive frames
      }
    }
  }
}

// Streaming primary→fallback ladder. Failures BEFORE the first token retry and
// fall back silently (same semantics as orWithRetryAndFallback). A failure AFTER
// the first token has been yielded is propagated so the caller can emit an error
// frame (the meta/cards frame is already delivered by then).
async function* orStreamWithRetryAndFallback(
  contents: any[],
  req: NextRequest,
  temperature = 0.2
): AsyncGenerator<string> {
  const PRIMARY  = process.env.OR_PRIMARY_MODEL  || "google/gemini-3.1-flash-lite";
  const FALLBACK = process.env.OR_FALLBACK_MODEL || "anthropic/claude-sonnet-4.6";
  const plans: [string, number][] = [[PRIMARY, 2], [FALLBACK, 1]];

  let lastErr: unknown = null;

  for (const [model, tries] of plans) {
    for (let i = 1; i <= tries; i++) {
      let yielded = false;
      try {
        for await (const delta of streamOpenRouterOnce(model, contents, req, temperature)) {
          yielded = true;
          yield delta;
        }
        return; // stream completed successfully
      } catch (e: any) {
        lastErr = e;
        if (yielded) throw e; // mid-stream failure — cards already delivered
        const msg = String(e?.message || e);
        const retriable = /(?:429|5\d\d|timeout|network|fetch|rate|busy)/i.test(msg);
        console.warn(`[OpenRouter] stream attempt failed (${model} try ${i}):`, msg.slice(0, 200));
        if (!retriable || i === tries) break;
        await sleep(Math.min(6000, 600 * 2 ** (i - 1)));
      }
    }
  }
  throw lastErr || new Error("All OpenRouter attempts failed");
}

/* ---------------------- Shared LLM prompt assembly ---------------------- */

const SYSTEM_PREAMBLE = `
You are LA-Fires Assistant.

You answer for a single parcel at a time and you only use the TOOL OUTPUTS provided.

RULES
- Treat TOOL OUTPUTS as the only source of facts. Do not invent data.
- Only include a section if its SHOW_* flag is true.
- Use plain text only (no Markdown, no bullets, no tables) EXCEPT for the Overlays section.
- Inside Zoning and Assessor sections, use concise "KEY: VALUE" lines.
- Do NOT show low-level technical fields such as SHAPE*, geometry, OBJECTID,
  internal IDs, URLs, status fields, or TITLE22 codes.
- Do not mention tools, JSON, or APIs in the final answer.

HANDLING SECTION STATUS
Check the [SECTION_STATUS] block for each section's status:
- "success": Show the data from tool outputs normally.
- "no_data": Show the section heading, then: "None found for this parcel."
- "error": Show the section heading, then: "Could not retrieve data. Please try again or check the official viewer."
- "not_configured": Show the section heading, then: "Not yet available for this city. Use the city's official GIS viewer."
- "not_implemented": Show the section heading, then the message from SECTION_STATUS.

ADDRESS RESOLUTION
- If [TOOL:address_resolved] is present, briefly mention the address was found and matched to a parcel, then show the data normally.
- Example: "Found parcel at [address]. Here's the zoning information:"

CRITICAL - ZONING SECTION (FIX #32, #33, #34)
When the zoning tool output contains a "formatted" field, output its contents EXACTLY as provided.
The formatted zoning uses STANDARDIZED field names that are consistent across all jurisdictions:
- JURISDICTION (always first)
- ZONE (the zone code like R1-1VL, RS-4, R-1-10000)
- ZONE DESCRIPTION (human-readable name like "Single Family Residential")
- GENERAL PLAN (if available)
- GENERAL PLAN DESCRIPTION (if available)
- COMMUNITY/PLANNING AREA (if available)
- SPECIFIC PLAN (if available)

Do NOT use jurisdiction-specific field names like:
- GEN CODE (use ZONE DESCRIPTION instead)
- GEN PLAN (use GENERAL PLAN instead)
- CATEGORY (use ZONE DESCRIPTION instead)
- PLANNINGAREA (use COMMUNITY/PLANNING AREA instead)
- TITLE22 (never show this)

CRITICAL - OVERLAYS SECTION
- When the overlay tool output contains a "formatted" field, output its contents EXACTLY as provided.
- Do not reformat, reorganize, or summarize the formatted overlays.
- Just copy the "formatted" field content directly after the "Overlays" heading.

FIX #10 - EMPTY OVERLAY CATEGORIES
When showing overlays, ALWAYS include these three key categories even if they have no items:
- HAZARDS
- HISTORIC PRESERVATION
- LAND USE & PLANNING

If a category has no results, show it with "None found for this parcel".

FORMAT
- Structure your answer into up to three sections, in this order:
  Zoning
  Overlays
  Assessor
- Put each section heading alone on its own line.
- For Zoning and Assessor, use KEY: VALUE lines.
- For Overlays, copy the pre-formatted text exactly.
- For the Zoning section, always start with JURISDICTION: <value>
- Never include a section whose SHOW_* flag is false.
`.trim();

function buildCombinedPrompt(opts: {
  SHOW_ZONING: boolean;
  SHOW_OVERLAYS: boolean;
  SHOW_ASSESSOR: boolean;
  intent: string;
  toolContext: string;
  combinedContext: string;
  userText: string;
}) {
  const { SHOW_ZONING, SHOW_OVERLAYS, SHOW_ASSESSOR, intent, toolContext, combinedContext, userText } = opts;
  return [
    { role: "system", parts: [{ text: SYSTEM_PREAMBLE }] },
    {
      role: "user",
      parts: [{
        text:
          `CONTROL FLAGS\n` +
          `SHOW_ZONING: ${SHOW_ZONING}\n` +
          `SHOW_OVERLAYS: ${SHOW_OVERLAYS}\n` +
          `SHOW_ASSESSOR: ${SHOW_ASSESSOR}`
      }],
    },
    { role: "user", parts: [{ text: `Intent: ${intent}` }] },
    {
      role: "user",
      parts: [{
        text:
          `=== TOOL OUTPUTS (authoritative) ===\n` +
          `${toolContext || "(none)"}\n\n` +
          `=== STATIC CONTEXT (supporting) ===\n` +
          `${combinedContext}`.trim()
      }],
    },
    { role: "user", parts: [{ text: userText }] },
  ];
}

/* --------------------------------- POST -------------------------------- */

export async function POST(request: NextRequest) {
  // Create request logger
  const log = createRequestLogger();
  log.log('CHAT', 'Request started');

  // Rate limiting check
  const clientId = getClientIdentifier(request.headers);
  const rateCheck = checkRateLimit(clientId, RATE_LIMITS.chat.maxRequests, RATE_LIMITS.chat.windowMs);

  if (!rateCheck.allowed) {
    log.warn('RATELIMIT', 'Rate limit exceeded', { clientId, resetIn: rateCheck.resetIn });
    return NextResponse.json(
      {
        error: 'Rate limit exceeded',
        message: `Too many requests. Please wait ${Math.ceil(rateCheck.resetIn / 1000)} seconds.`,
        retryAfter: Math.ceil(rateCheck.resetIn / 1000)
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil(rateCheck.resetIn / 1000)),
          ...getRateLimitHeaders(rateCheck)
        }
      }
    );
  }

  try {
    noStore();
    const { messages } = await request.json();
    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: "Invalid request. Messages must be an array." }, { status: 400 });
    }

    log.benchmark('request_parsed');

    const contextData = await loadAllContextFiles();
    const lastUser = messages[messages.length - 1]?.content || "";
    const intent = lastUser;
    const municodeContext = await loadMunicodeContext(lastUser);
    const combinedContext = contextData + municodeContext;

    // --- Step 2: live lookups producing structured cards + LLM tool context ---
    const { cards, toolContext, flags, overlayCount } = await runParcelLookup(lastUser, log);
    const { SHOW_ZONING, SHOW_OVERLAYS, SHOW_ASSESSOR } = flags;

    const isMultiAddress = !!(cards.addressMatches && cards.addressMatches.length > 1);
    const lastMessageContent = messages[messages.length - 1].content;

    // Metadata shared by the streamed meta frame (StreamFrame shape).
    const streamMetadata = {
      queriedAt: new Date().toISOString(),
      jurisdiction: cards.jurisdiction,
      sources: ['LA County GIS', 'LA County Assessor', cards.jurisdiction ? `City of ${cards.jurisdiction} GIS` : null].filter(Boolean) as string[],
    };

    // ─────────────────────────────────────────────────────────────────────
    // Step 4: NDJSON streaming path (opt-in via `Accept: application/x-ndjson`)
    // Emits the cards immediately (meta frame), then streams the LLM answer.
    // ─────────────────────────────────────────────────────────────────────
    const wantsStream = (request.headers.get('accept') || '').includes('application/x-ndjson');

    if (wantsStream) {
      log.log('CHAT', 'Streaming NDJSON response', { isMultiAddress });
      const encoder = new TextEncoder();

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (frame: StreamFrame) =>
            controller.enqueue(encoder.encode(JSON.stringify(frame) + "\n"));

          let streamError: string | null = null;
          const llmTimer = createTimer('llm_call');

          try {
            // First frame: cards paint instantly, before the LLM call.
            send({ type: "meta", cards, metadata: streamMetadata });

            if (isMultiAddress) {
              send({
                type: "delta",
                text: `I found ${cards.addressMatches!.length} parcels matching that address. Please select the correct one:`,
              });
            } else {
              const combinedPrompt = buildCombinedPrompt({
                SHOW_ZONING, SHOW_OVERLAYS, SHOW_ASSESSOR,
                intent, toolContext, combinedContext, userText: lastMessageContent,
              });
              try {
                for await (const delta of orStreamWithRetryAndFallback(combinedPrompt, request, 0.05)) {
                  send({ type: "delta", text: delta });
                }
              } catch (e: any) {
                // Cards are already delivered; surface a recoverable error frame.
                streamError = String(e?.message || e);
                log.warn('CHAT', 'LLM stream failed', { error: streamError });
                send({ type: "error", message: friendlyFallbackMessage() });
              }
            }
          } catch (e: any) {
            streamError = String(e?.message || e);
            log.error('CHAT', 'Fatal stream error', { error: streamError });
            try { send({ type: "error", message: friendlyFallbackMessage() }); } catch {}
          } finally {
            llmTimer.stopAndLog(log);
            try { send({ type: "done" }); } catch {}

            const totalTime = log.elapsed();
            log.log('CHAT', 'Request complete (stream)', { totalTime, streamError });
            logRequestMetrics({
              requestId: log.getRequestId(),
              apn: cards.apn,
              jurisdiction: cards.jurisdiction,
              totalTime,
              overlayCount,
              benchmarks: log.getBenchmarks(),
              timestamp: new Date().toISOString(),
            });

            controller.close();
          }
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': 'application/x-ndjson',
          'Cache-Control': 'no-cache, no-transform',
          ...getRateLimitHeaders(rateCheck),
        },
      });
    }

    // ─────────────────────────────────────────────────────────────────────
    // Legacy JSON path (requests without the NDJSON Accept header)
    // ─────────────────────────────────────────────────────────────────────

    // PHASE 6B: Handle multiple address matches - return early with picker data
    if (isMultiAddress) {
      log.log('CHAT', 'Returning address picker data', { count: cards.addressMatches!.length });

      return NextResponse.json(
        {
          response: `I found ${cards.addressMatches!.length} parcels matching that address. Please select the correct one:`,
          intent,
          addressMatches: cards.addressMatches,
          cards,
          metadata: {
            queriedAt: new Date().toISOString(),
            type: 'address_picker',
          }
        },
        {
          status: 200,
          headers: getRateLimitHeaders(rateCheck)
        }
      );
    }

    // --- Step 3: Build prompts ---
    const combinedPrompt = buildCombinedPrompt({
      SHOW_ZONING, SHOW_OVERLAYS, SHOW_ASSESSOR,
      intent, toolContext, combinedContext, userText: lastMessageContent,
    });

    // --- Step 4: LLM call ---
    const llmTimer = createTimer('llm_call');
    let text = "";
    try {
      text = await orWithRetryAndFallback(combinedPrompt, request, 0.05);
    } catch {
      text = "Zoning/overlays/assessor results are below.\n\n" + friendlyFallbackMessage();
    }
    llmTimer.stopAndLog(log);

    // Defensive post-filter
    try {
      if (text) {
        const removeSection = (input: string, heading: string) => {
          const re = new RegExp(
            `(^|\\n)${heading}\\b[\\s\\S]*?(?=\\n(?:Zoning|Overlays|Assessor)\\b|$)`,
            "gi"
          );
          return input.replace(re, "");
        };

        if (!SHOW_ZONING)   text = removeSection(text, "Zoning");
        if (!SHOW_OVERLAYS) text = removeSection(text, "Overlays");
        if (!SHOW_ASSESSOR) text = removeSection(text, "Assessor");

        const cleanedLines = text
          .split(/\r?\n/)
          .filter(line => {
            if (!line.trim()) return true;
            if (/^\s*(SHAPE[_A-Z0-9]*|shape[_a-z0-9]*)\s*:/i.test(line)) return false;
            if (/^\s*STATUS\s*:\s*(success|no_data|error|not_configured|not_implemented)\s*$/i.test(line)) return false;
            if (/^\s*TITLE[_\s]?22\s*:/i.test(line)) return false;
            if (/^\s*GEN[_\s]?CODE\s*:/i.test(line)) return false;
            if (/^\s*CODE[_\s]?LABEL\s*:/i.test(line)) return false;
            if (/^\s*PLANNINGAREA\s*:/i.test(line)) return false;
            if (/^\s*Z_CATEGORY\s*:/i.test(line)) return false;
            return true;
          });

        text = cleanedLines.join("\n").trim();
      }
    } catch (e) {
      log.warn('CHAT', 'Post-filter failed', { error: String(e) });
    }

    // FIX #31: Log metrics
    const totalTime = log.elapsed();
    log.log('CHAT', 'Request complete', { totalTime });

    logRequestMetrics({
      requestId: log.getRequestId(),
      apn: cards.apn,
      jurisdiction: cards.jurisdiction,
      totalTime,
      overlayCount,
      benchmarks: log.getBenchmarks(),
      timestamp: new Date().toISOString(),
    });

    // FIX #38: Include metadata in response
    return NextResponse.json(
      {
        response: text,
        intent,
        resolvedAddress: cards.resolvedAddress ?? null,
        cards,
        metadata: {
          queriedAt: new Date().toISOString(),
          jurisdiction: cards.jurisdiction,
          sources: ['LA County GIS', 'LA County Assessor', cards.jurisdiction ? `City of ${cards.jurisdiction} GIS` : null].filter(Boolean),
        }
      },
      {
        status: 200,
        headers: getRateLimitHeaders(rateCheck)
      }
    );
  } catch (error: any) {
    log.error('CHAT', 'Fatal error', { error: String(error) });
    return NextResponse.json(
      {
        response: friendlyFallbackMessage(),
        intent: "",
        metadata: {
          queriedAt: new Date().toISOString(),
        }
      },
      {
        status: 200,
        headers: getRateLimitHeaders(rateCheck)
      }
    );
  }
}
