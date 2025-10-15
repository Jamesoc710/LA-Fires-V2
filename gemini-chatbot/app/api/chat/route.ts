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
function extractApn(s: string): string | undefined {
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  const m = s.match(/\b(\d{4}[-\s]?\d{3}[-\s]?\d{3})\b/);
  return m ? m[1].replace(/\D/g, "") : undefined;
}
function extractAddress(s: string): string | undefined {
  if (/\d{3,5}\s+\w+/.test(s || "")) return s.trim();
  return undefined;
}

/* ---------------- OpenRouter primary + fallback ---------------- */

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

function toOpenAIStyleMessages(geminiStyleContents: any[]) {
  return geminiStyleContents.map((c: any) => ({
    role: c.role === "model" ? "assistant" : c.role,
    content: (c.parts || []).map((p: any) => p.text).join(""),
  }));
}

async function callOpenRouter(model: string, contents: any[]) {
  const apiKey = process.env.OPENROUTER_API_KEY!;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  const messages = toOpenAIStyleMessages(contents);
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://la-fires-v2.vercel.app",
      "X-Title": "LA-Fires V2",
    },
    body: JSON.stringify({ model, messages }),
  });

  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`OpenRouter ${r.status}: ${body}`);
  }
  const j = await r.json();
  const text = j?.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("Empty response from OpenRouter");
  return text.trim();
}

async function orWithRetryAndFallback(contents: any[]) {
  const PRIMARY  = process.env.OR_PRIMARY_MODEL  || "google/gemini-2.0-flash-001";
  const FALLBACK = process.env.OR_FALLBACK_MODEL || "anthropic/claude-3.5-sonnet";
  const plans: [string, number][] = [[PRIMARY, 3], [FALLBACK, 2]];

  for (const [model, tries] of plans) {
    for (let i = 1; i <= tries; i++) {
      try {
        return await callOpenRouter(model, contents);
      } catch (e: any) {
        const retriable = /(?:429|503|5\d\d|network|timeout|fetch|rate)/i.test(String(e?.message || e));
        if (!retriable || i === tries) break;
        const delay = Math.min(8000, Math.round(500 * 2 ** (i - 1) * (0.5 + Math.random())));
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
    noStore();

    const { messages } = await request.json();
    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: "Invalid request. Messages must be an array." }, { status: 400 });
    }

    const contextData = await loadAllContextFiles();

    // --- Step 1: refine intent (OpenRouter, Gemini 2.0 Flash Lite) ---
    const customLiteSystemPrompt = {
      role: "user",
      parts: [{ text:
`You are tasked with refining the user's inputted question about Los Angeles building codes.

Your goal is to:
- Make the question as clear, specific, and precise as possible.
- Keep the original intent and meaning.
- Eliminate vague or ambiguous wording.
- If necessary, add brief clarifications.

Important:
- Do not change the meaning of the user's original question.
- Do not answer the question.
- Only return the refined and clarified version of the question.

Respond with only the improved question, nothing else.` }],
    };
    const intentPrompt = [
      customLiteSystemPrompt,
      { role: "user", parts: [{ text: messages[messages.length - 1].content }] },
    ];
    let intent = "";
    try { intent = await orWithRetryAndFallback(intentPrompt); } catch { intent = ""; }

    // --- Step 2: live lookups (TOOL OUTPUTS) ---
    let toolContext = "";
    try {
      const lastUser = messages[messages.length - 1]?.content || "";
      if (wantsParcelLookup(lastUser)) {
        const apn = extractApn(lastUser);
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
          toolContext += `\n[TOOL_NOTE] No APN/AIN or address detected.`;
        }
      }
    } catch (e) {
      toolContext += `\n[TOOL_ERROR] ${String(e)}`;
    }
    console.log("[CHAT] toolContext length:", toolContext.length);

    // --- Step 3: build prompts with tools first (unchanged) ---
    const systemPreamble = `
You are LA-Fires Assistant.
If TOOL OUTPUTS exist, you MUST answer using them. Do NOT refuse when tool data is present.
Prefer TOOL OUTPUTS over any other text. If they are missing, say "**Section: Unknown**" and ask for an APN/AIN if needed.
For zoning, summarize ZONE, Z_DESC, Z_CATEGORY, PLNG_AREA, and include TITLE_22 when available.
`.trim();

    const customSystemPrompt = {
      role: "user",
      parts: [{ text:
`You must include a section heading **only if present** in the provided materials.
If no section exists (e.g., ArcGIS zoning / assessor results), write "**Section: Unknown**" and continue.

Instructions:
- Use TOOL OUTPUTS when provided. They have priority over everything else.
- Get straight to the relevant facts (zoning code, description, category, planning area; assessor situs address, year built, area).
- Do not add disclaimers or refuse when tool data is present.` }],
    };

    const combinedPrompt = [
      { role: "user", parts: [{ text: systemPreamble }] },
      customSystemPrompt,
      { role: "user", parts: [{ text: `Intent: ${intent}` }] },
      { role: "user", parts: [{ text:
`=== TOOL OUTPUTS (authoritative) ===
${toolContext || "(none)"}

=== STATIC CONTEXT (supporting) ===
${contextData}`.trim() }] },
      { role: "user", parts: [{ text: messages[messages.length - 1].content }] },
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
    return NextResponse.json(
      { response: friendlyFallbackMessage(), intent: "" },
      { status: 200 }
    );
  }
}
