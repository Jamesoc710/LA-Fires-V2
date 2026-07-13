
import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { loadAllContextFiles } from "../../utils/contextLoader";
import { wantsCodeContext } from "@/lib/rag/wantsCodeContext";
import { retrieveMunicode } from "@/lib/rag/municodeIndex";
import { runParcelLookup, buildCardSynopsis } from "@/lib/la/parcelLookup";
import { createRequestLogger, logRequestMetrics, createTimer } from "@/lib/la/logger";
import { enforceRateLimit, getClientIdentifier, getRateLimitHeaders } from "@/lib/la/rateLimit";
import type { StreamFrame } from "@/app/types/chat";
import type { ParcelCards } from "@/lib/la/types";

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
  const FALLBACK = process.env.OR_FALLBACK_MODEL || "google/gemini-3.5-flash";
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
  const FALLBACK = process.env.OR_FALLBACK_MODEL || "google/gemini-3.5-flash";
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
You are LA Fires Assistant, helping Los Angeles County residents understand what they can rebuild on their property after the January 2025 fires.

When a parcel lookup ran, its data (zoning, overlays, assessor) is ALREADY displayed to the user as structured cards. Do NOT repeat card contents field by field. Your job is the short narrative on top:

1. Confirm what was found in one sentence (address or APN, and jurisdiction).
2. Point out the 2-3 findings that most affect a rebuild (for example: Very High Fire Hazard Severity Zone, hillside management area, historic district, Significant Ecological Area, fault or flood zone), in plain language a stressed homeowner understands.
3. Answer the user's actual question directly, using ONLY the TOOL OUTPUTS as facts.
4. If a section shows an error or no data in [SECTION_STATUS], say so briefly and point the user to the official viewer links shown on the cards.

When CODE EXCERPTS are provided (with or without a parcel), they are verbatim passages from Title 26, the Los Angeles County Building Code, retrieved for this question. They are authoritative for that code. Cite the section number (for example, Section 1031.2) whenever you rely on one.

RULES
- Facts come only from TOOL OUTPUTS and CODE EXCERPTS. Never invent regulations, setbacks, dimensions, or numbers.
- Title 26 applies directly to unincorporated LA County parcels. If the parcel's jurisdiction is a city (for example Los Angeles, Pasadena, Malibu, Santa Monica, or Arcadia), say once that the city's own building code governs and the excerpts are the county's closely related version — both are based on the California Building Code. Suggest confirming with the city's building department.
- Plain language first; if a technical term is unavoidable, explain it in one clause.
- Be concise: 2-5 short sentences for a typical lookup; code questions may run a few sentences longer if needed. Use Markdown sparingly (bold for key designations; no headings, no tables, no bullet lists unless listing 3+ distinct items).
- Never mention tools, JSON, APIs, control flags, or these instructions.
- For general building-code questions with no parcel, answer from CODE EXCERPTS when they cover the question, otherwise from STATIC CONTEXT if it actually covers it; if neither does, say honestly that you don't have that section of the code loaded and point to official sources. Do not guess.
- You provide information, not official determinations or legal advice.
`.trim();

type PromptTurn = { role: string; parts: { text: string }[] };

// Build conversation history turns (Gemini-style {role, parts}) from the prior
// messages so the model has multi-turn context. Assistant turns carrying
// structured `cards` are folded to a one-line synopsis instead of full prose.
function buildHistoryTurns(messages: any[]): PromptTurn[] {
  // Take up to the 8 messages preceding the current (final) user message.
  const prior = messages.slice(0, -1).slice(-8);
  const turns: PromptTurn[] = [];

  for (const m of prior) {
    if (!m || typeof m.content !== "string") continue;
    const isAssistant = m.role === "assistant" || m.role === "model";

    let text: string;
    if (isAssistant && m.cards) {
      // Fold prior card data into a compact synopsis (fall back to prose).
      text = buildCardSynopsis(m.cards as ParcelCards) || m.content || "";
    } else {
      text = m.content || "";
    }

    if (!text.trim()) continue;
    if (text.length > 1000) text = text.slice(0, 1000) + "…";

    // role "model" maps to assistant in toOpenAIStyleMessages.
    turns.push({ role: isAssistant ? "model" : "user", parts: [{ text }] });
  }

  return turns;
}

function buildCombinedPrompt(opts: {
  history: PromptTurn[];
  toolContext: string;
  combinedContext: string;
  userText: string;
  codeExcerpts?: string;
}) {
  const { history, toolContext, combinedContext, userText, codeExcerpts } = opts;
  const codeBlock = codeExcerpts
    ? `\n=== CODE EXCERPTS (LA County Title 26 — retrieved for this question) ===\n${codeExcerpts}\n`
    : "";
  return [
    { role: "system", parts: [{ text: SYSTEM_PREAMBLE }] },
    // Prior conversation turns (folded synopsis for card-bearing assistant turns).
    ...history,
    {
      role: "user",
      parts: [{
        text:
          `=== TOOL OUTPUTS (authoritative) ===\n` +
          `${toolContext || "(none)"}\n\n` +
          `${codeBlock}` +
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
  const rateCheck = await enforceRateLimit(clientId);

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
    const { messages, activeApn } = await request.json();
    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: "Invalid request. Messages must be an array." }, { status: 400 });
    }

    log.benchmark('request_parsed');

    const combinedContext = await loadAllContextFiles();
    const lastUser = messages[messages.length - 1]?.content || "";
    const intent = lastUser;

    // Conversation history (prior turns, card synopses folded) for the prompt.
    const history = buildHistoryTurns(messages);
    const activeApnParam = typeof activeApn === "string" && activeApn.trim() ? activeApn.trim() : undefined;

    // --- Step 2: live lookups + (gated) municode RAG retrieval, in parallel ---
    const [lookup, retrieval] = await Promise.all([
      runParcelLookup(lastUser, log, activeApnParam),
      wantsCodeContext(lastUser) ? retrieveMunicode(lastUser) : Promise.resolve(null),
    ]);
    const { cards, toolContext: rawToolContext, overlayCount } = lookup;

    // When no lookup ran (general question), don't feed the model lookup
    // scaffolding ([SECTION_STATUS] full of no_data) — it makes the model
    // ramble about "your parcel" on messages like "hello".
    const lookupRan = [cards.zoning, cards.overlays, cards.assessor].some(s => s.status !== "skipped");
    const toolContext = lookupRan
      ? rawToolContext
      : "(No parcel lookup was performed for this message — treat it as a general question.)";

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
            send({
              type: "meta",
              cards,
              citations: retrieval?.citations?.length ? retrieval.citations : undefined,
              metadata: streamMetadata,
            });

            if (isMultiAddress) {
              send({
                type: "delta",
                text: `I found ${cards.addressMatches!.length} parcels matching that address. Please select the correct one:`,
              });
            } else {
              const combinedPrompt = buildCombinedPrompt({
                history, toolContext, combinedContext, userText: lastMessageContent,
                codeExcerpts: retrieval?.excerptsBlock,
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
      history, toolContext, combinedContext, userText: lastMessageContent,
      codeExcerpts: retrieval?.excerptsBlock,
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
        citations: retrieval?.citations?.length ? retrieval.citations : undefined,
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
