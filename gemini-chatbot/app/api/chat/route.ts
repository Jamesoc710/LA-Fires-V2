import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { loadAllContextFiles } from "../../utils/contextLoader";
import { lookupZoning, lookupAssessor, lookupOverlays } from "@/lib/la/fetchers";

export const runtime = "nodejs";

/* ------------------------------- helpers ------------------------------- */

function wantsParcelLookup(s: string) {
  const digits = s.replace(/\D/g, "");
  return digits.length >= 9 || /apn|ain|zoning|overlay|assessor|parcel/i.test(s);
}
function wantsOverlay(s: string) {
  return /overlay|sea|csd|flood|tod|ridgeline|coastal|lup|community\s*plan/i.test(s || "");
}

// Policy/Title 22 questions should NOT require APN/tools
function isPolicyQuestion(s: string) {
  return /title\s*22|rebuild|10%\s*rebuild|nonconform|22\.18|zoning\s*code/i.test(s || "");
}

// Accept “5843-004-015”, “5843 004 015”, or “5843004015”; return 10 digits
function extractApn(s: string): string | undefined {
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  const m = s.match(/\b(\d{4}[-\s]?\d{3}[-\s]?\d{3})\b/);
  return m ? m[1].replace(/\D/g, "") : undefined;
}

// Get the most recent valid APN across the whole conversation
function latestApnFromMessages(messages: Array<{ role: string; content: string }>) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const apn = extractApn(messages[i]?.content || "");
    if (apn && apn.length === 10) return apn;
  }
  return undefined;
}

function extractAddress(s: string): string | undefined {
  if (/\d{3,5}\s+\w+/.test(s || "")) return s.trim();
  return undefined;
}

/* ---------------- OpenRouter primary + fallback (no extra files) ---------------- */

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

async function callOpenRouter(model: string, geminiStyleContents: any[]) {
  const apiKey = process.env.OPENROUTER_API_KEY!;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  const messages = geminiStyleContents.map((c: any) => ({
    role: c.role === "model" ? "assistant" : c.role,
    content: (c.parts || []).map((p: any) => p.text).join(""),
  }));

  const body = JSON.stringify({ model, messages });

  const t0 = Date.now();
  let r: Response | undefined;
  try {
    r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // optional analytics (helps OR support if needed)
        "HTTP-Referer": "https://la-fires-v2.vercel.app",
        "X-Title": "LA-Fires V2",
      },
      body,
    });
  } catch (netErr: any) {
    console.error("[OpenRouter] network error:", netErr?.message || netErr);
    throw netErr;
  }

  const ms = Date.now() - t0;
  if (!r.ok) {
    const errText = await r.text().catch(() => "(no body)");
    console.error("[OpenRouter] HTTP", r.status, "model:", model, "in", ms + "ms", "body:", errText.slice(0, 800));
    throw new Error(`OpenRouter ${r.status}: ${errText}`);
  }

  const j = await r.json().catch((e) => {
    console.error("[OpenRouter] JSON parse error:", e);
    throw e;
  });

  const text = j?.choices?.[0]?.message?.content ?? "";
  if (!text) {
    console.error("[OpenRouter] empty content for model:", model, "raw:", JSON.stringify(j).slice(0, 800));
    throw new Error("Empty response from OpenRouter");
  }

  console.log("[OpenRouter] OK", model, "in", ms + "ms");
  return text.trim();
}

async function orWithRetryAndFallback(contents: any[]) {
  const PRIMARY  = process.env.OR_PRIMARY_MODEL   || "google/gemini-2.0-flash";
  const FALLBACK = process.env.OR_FALLBACK_MODEL  || "anthropic/claude-3.5-sonnet";
  console.log("[ENV] OR key:", !!process.env.OPENROUTER_API_KEY, "primary:", PRIMARY, "fallback:", FALLBACK);

  const plans: [string, number][] = [[PRIMARY, 3], [FALLBACK, 2]];

  for (const [model, tries] of plans) {
    for (let i = 1; i <= tries; i++) {
      try {
        console.log("[OpenRouter] attempt", i, "model:", model);
        return await callOpenRouter(model, contents);
      } catch (e: any) {
        console.error("[OpenRouter] attempt failed (", model, "try", i, "):", e?.message || e);
        const retriable = /(?:429|503|5\d\d|network|timeout|fetch|rate)/i.test(String(e?.message || e));
        if (!retriable || i === tries) break;
        const delay = Math.min(8000, Math.round(500 * 2 ** (i - 1) * (0.5 + Math.random())));
        console.log("[OpenRouter] backoff", delay, "ms before retry");
        await sleep(delay);
      }
    }
  }

  throw new Error("All OpenRouter attempts failed");
}

function friendlyFallbackMessage() {
  return "The AI service is busy right now. I still fetched your zoning/overlays/assessor links—try the AI summary again in a moment.";
}

/* --------------------------------- POST -------------------------------- */

export async function POST(request: NextRequest) {
  try {
    noStore(); // avoid route-level caching while testing

    const { messages } = await request.json();
    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json(
        { error: "Invalid request. Messages must be an array." },
        { status: 400 }
      );
    }

    const lastUser = messages[messages.length - 1]?.content || "";
    const isPolicy = isPolicyQuestion(lastUser);

    // Conversation-wide APN memory
    let apn = extractApn(lastUser) || latestApnFromMessages(messages);
    if (apn && apn.length !== 10) apn = undefined; // guard invalid like "123"

    // Load static context (files)
    const contextData = await loadAllContextFiles();

    // --- Step 1: refine intent with Flash Lite via OpenRouter ---
    const customLiteSystemPrompt = {
      role: "user",
      parts: [
        {
          text: `You are tasked with refining the user's inputted question about Los Angeles building codes.

Your goal is to:
- Make the question as clear, specific, and precise as possible.
- Keep the original intent and meaning.
- Eliminate vague or ambiguous wording.
- If necessary, add brief clarifications to make it easier for a code reviewer to understand the request.

Important:
- Do not change the meaning of the user's original question.
- Do not answer the question.
- Only return the refined and clarified version of the question.

Respond with only the improved question, nothing else.`,
        },
      ],
    };

    const intentPrompt = [
      customLiteSystemPrompt,
      { role: "user", parts: [{ text: lastUser }] },
    ];

    let intent = "";
    try {
      intent = await orWithRetryAndFallback(intentPrompt);
    } catch {
      intent = ""; // non-fatal; continue
    }

    // --- Step 2: live lookups (TOOL OUTPUTS) ---
    let toolContext = "";
    try {
      if (!isPolicy && (wantsParcelLookup(lastUser) || apn)) {
        const address = extractAddress(lastUser);
        if (apn) {
          const [zRes, aRes, oRes] = await Promise.allSettled([
            lookupZoning(apn),
            lookupAssessor(apn),
            lookupOverlays(apn),
          ]);

          if (zRes.status === "fulfilled") {
            toolContext += `\n[TOOL:zoning]\n${JSON.stringify(zRes.value, null, 2)}`;
          } else {
            toolContext += `\n[TOOL_ERROR:zoning] ${String(zRes.reason)}`;
          }

          if (aRes.status === "fulfilled") {
            toolContext += `\n[TOOL:assessor]\n${JSON.stringify(aRes.value, null, 2)}`;
          } else {
            toolContext += `\n[TOOL_ERROR:assessor] ${String(aRes.reason)}`;
          }

          if (oRes.status === "fulfilled") {
            toolContext += `\n[TOOL:overlays]\n${JSON.stringify(oRes.value, null, 2)}`;
          } else {
            toolContext += `\n[TOOL_ERROR:overlays] ${String(oRes.reason)}`;
          }
        } else if (address) {
          toolContext += `\n[TOOL_NOTE] Address detected but address→parcel is not implemented yet. Provide an APN/AIN to fetch zoning/assessor details.`;
        } else {
          toolContext += `\n[TOOL_NOTE] No APN/AIN detected in conversation. Provide a 10-digit APN like 5843-004-015.`;
        }
      } else if (isPolicy) {
        toolContext += `\n[TOOL_NOTE] Policy/Title 22 question detected — answering from static context; parcel tools not required.`;
      }
    } catch (e) {
      toolContext += `\n[TOOL_ERROR] ${String(e)}`;
    }
    console.log("[CHAT] toolContext length:", toolContext.length);

    // --- Step 3: build prompts with tools first ---
    const systemPreamble = `
You are LA-Fires Assistant.

Decision rules:
- If the user asks a policy/code question (Title 22, 10% rebuild, nonconforming use), answer directly from STATIC CONTEXT. Do NOT require an APN.
- If the user asks parcel-specific info (zoning/overlays/assessor), prefer TOOL OUTPUTS when present; otherwise ask for a 10-digit APN.
- Never refuse when tool data is present.
`.trim();

    const customSystemPrompt = {
      role: "user",
      parts: [
        {
          text: `
Formatting rules:
- Sections in this order when applicable: Zoning, Overlays, Assessor.
- Do not repeat items across sections.
- Assessor: show only situs, livingArea (append "sqft"), yearBuilt, bedrooms, bathrooms, and a portal link if provided. Omit missing fields (no "null"/"N/A").
- If the question is policy-only, omit parcel sections unless the user also asked parcel-specific info.
`.trim(),
        },
      ],
    };

    const combinedPrompt = [
      // Make tools authoritative and visible early
      { role: "user", parts: [{ text: systemPreamble }] },
      customSystemPrompt,
      { role: "user", parts: [{ text: `Intent: ${intent}` }] },
      {
        role: "user",
        parts: [
          {
            text:
              `=== TOOL OUTPUTS (authoritative) ===
${toolContext || "(none)"}

=== STATIC CONTEXT (supporting) ===
${contextData}
`.trim(),
          },
        ],
      },
      // last user question last
      {
        role: "user",
        parts: [{ text: lastUser }],
      },
    ];

    // --- Step 4: final model call via OpenRouter with fallback ---
    let text = "";
    try {
      text = await orWithRetryAndFallback(combinedPrompt);
    } catch {
      text = "Zoning/overlays/assessor results are below.\n\n" + friendlyFallbackMessage();
    }

    return NextResponse.json({ response: text, intent }, { status: 200 });
  } catch (error: any) {
    console.error("Error in chat API:", error);
    // Last resort: never show a red 500 bubble for transient model issues
    return NextResponse.json(
      { response: friendlyFallbackMessage(), intent: "" },
      { status: 200 }
    );
  }
}
