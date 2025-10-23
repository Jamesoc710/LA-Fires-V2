import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { loadAllContextFiles } from "../../utils/contextLoader";
import { lookupZoning, lookupAssessor, lookupOverlays } from "@/lib/la/fetchers";

export const runtime = "nodejs";
const OR_API_KEY = process.env.OPENROUTER_API_KEY;
const OR_PRIMARY_MODEL = process.env.OR_PRIMARY_MODEL || "google/gemini-2.0-flash-001";
const OR_FALLBACK_MODEL = process.env.OR_FALLBACK_MODEL || "anthropic/claude-3.5-sonnet";

if (!OR_API_KEY) {
  console.warn("[WARN] Missing OPENROUTER_API_KEY — OpenRouter requests will fail");
}

/* ------------------------------- helpers ------------------------------- */

function wantsParcelLookup(s: string) {
  const digits = s.replace(/\D/g, "");
  // include both singular and plural overlay tokens
  return digits.length >= 9 || /apn|ain|zoning|overlay|overlays|assessor|parcel/i.test(s);
}
function wantsOverlay(s: string) {
  // accept 'overlay' and 'overlays'
  return /\boverlays?\b|sea|csd|flood|tod|ridgeline|coastal|lup|community\s*plan/i.test(s || "");
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

function wantsZoningSection(s: string) {
  const q = s.toLowerCase();
  return /\bzoning\b|\bzone\b|r-\d{1,5}|\btitle\s*22\b|\bplng\b|\bplanning\s*area\b/.test(q);
}
function wantsOverlaysSection(s: string) {
  const q = s.toLowerCase();
  // broader matcher, accept overlay(s) term and other overlay-like tokens
  return /\boverlays?\b|\bcsd\b|\bsea\b|\bridgeline\b|\btod\b|\bhpoz\b|\bspecific\s*plan\b|\bplan[_\s-]?leg\b/.test(q);
}
function wantsAssessorSection(s: string) {
  // Narrowed: do NOT trigger on APN/AIN. Only real assessor-related keywords.
  const q = s.toLowerCase();
  return /\bassessor\b|\bsitus\b|\bliving\s*area\b|\byear\s*built\b|\bunits?\b|\bbedrooms?\b|\bbathrooms?\b|\buse\b|\bsq\s*ft\b|\bsquare\s*feet\b/.test(q);
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


// in orWithRetryAndFallback signature + call sites
async function orWithRetryAndFallback(contents: any[], req: NextRequest, temperature = 0.2) {
  const PRIMARY  = process.env.OR_PRIMARY_MODEL  || "google/gemini-2.0-flash-001";
  const FALLBACK = process.env.OR_FALLBACK_MODEL || "anthropic/claude-3.5-sonnet";
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

/* --------------------------------- POST -------------------------------- */

export async function POST(request: NextRequest) {
  try {
    noStore();
    console.log("[ENV] OR key:", !!process.env.OPENROUTER_API_KEY,
            "primary:", process.env.OR_PRIMARY_MODEL,
            "fallback:", process.env.OR_FALLBACK_MODEL);


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
try { intent = await orWithRetryAndFallback(intentPrompt, request, 0.1); } catch { intent = ""; }

// --- Step 1b: decide which sections to render based on intent+query ---
const lastUser = messages[messages.length - 1]?.content || "";
const qForIntent = `${intent} ${lastUser}`.trim();

let SHOW_ZONING   = wantsZoningSection(qForIntent);
let SHOW_OVERLAYS = wantsOverlaysSection(qForIntent);
let SHOW_ASSESSOR = wantsAssessorSection(qForIntent);

// If none matched, treat as a broad question => show everything
if (!SHOW_ZONING && !SHOW_OVERLAYS && !SHOW_ASSESSOR) {
  SHOW_ZONING = SHOW_OVERLAYS = SHOW_ASSESSOR = true;
}

console.log("[CHAT] hasZoning:", SHOW_ZONING, "hasOverlays:", SHOW_OVERLAYS, "hasAssessor:", SHOW_ASSESSOR);

// --- Step 2: live lookups (TOOL OUTPUTS) ---
let toolContext = "";
try {
  const lastUser = messages[messages.length - 1]?.content || "";
  if (wantsParcelLookup(lastUser)) {
    const apn = extractApn(lastUser);
    const address = extractAddress(lastUser);

    if (apn) {
      // only call the fetchers if the SHOW_* flags are true
      const [zRes, aRes, oRes] = await Promise.allSettled([
        SHOW_ZONING   ? lookupZoning(apn)   : Promise.resolve(null),
        SHOW_ASSESSOR ? lookupAssessor(apn) : Promise.resolve(null),
        SHOW_OVERLAYS ? lookupOverlays(apn) : Promise.resolve(null),
      ]);

      console.log("[CHAT] fetch results:",
        "zoning:", SHOW_ZONING ? (zRes as any).status : "skipped",
        "assessor:", SHOW_ASSESSOR ? (aRes as any).status : "skipped",
        "overlays:", SHOW_OVERLAYS ? (oRes as any).status : "skipped"
      );

      if (SHOW_ZONING && (zRes as any).status === "fulfilled" && (zRes as any).value) {
        toolContext += `\n[TOOL:zoning]\n${JSON.stringify((zRes as any).value, null, 2)}`;
      } else if (SHOW_ZONING && (zRes as any).status === "rejected") {
        toolContext += `\n[TOOL_ERROR:zoning] ${String((zRes as any).reason)}`;
      }

      if (SHOW_ASSESSOR && (aRes as any).status === "fulfilled" && (aRes as any).value) {
        toolContext += `\n[TOOL:assessor]\n${JSON.stringify((aRes as any).value, null, 2)}`;
      } else if (SHOW_ASSESSOR && (aRes as any).status === "rejected") {
        toolContext += `\n[TOOL_ERROR:assessor] ${String((aRes as any).reason)}`;
      }

      if (SHOW_OVERLAYS && (oRes as any).status === "fulfilled" && (oRes as any).value) {
        toolContext += `\n[TOOL:overlays]\n${JSON.stringify((oRes as any).value, null, 2)}`;
      } else if (SHOW_OVERLAYS && (oRes as any).status === "rejected") {
        toolContext += `\n[TOOL_ERROR:overlays] ${String((oRes as any).reason)}`;
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

Rules:
- Use TOOL OUTPUTS as the single source of truth when present.
- Render ONLY the sections whose flags are true.
- If a flagged section has no tool data, output exactly:
Zoning
Section: Unknown
(or the appropriate section heading, e.g., Overlays / Assessor)
- Never include any section that is not flagged.
- Output plain text only (no Markdown, no **bold**, no lists, no code fences).
- Valid section headings are exactly: "Zoning", "Overlays", "Assessor".
- Inside each shown section, print concise KEY: VALUE lines.
- Recommended order: Zoning, Overlays, Assessor.
- For Zoning, include ZONE, Z_DESC, Z_CATEGORY, PLNG_AREA, and TITLE_22 when available.
`.trim();

const customSystemPrompt = {
  role: "user",
  parts: [{
    text:
`If a section has no data in TOOL OUTPUTS, print "Section: Unknown" and continue.
Do NOT include any section whose SHOW_* flag is false.
Do NOT use Markdown formatting.
Focus on the most relevant facts only (e.g., zoning code, description, category, planning area; assessor situs address, living area, year built).`
  }],
};


const combinedPrompt = [
  { role: "user", parts: [{ text: systemPreamble }] },
  customSystemPrompt,

  // NEW: explicit control flags
  { role: "user", parts: [{ text:
`CONTROL FLAGS
SHOW_ZONING: ${String(SHOW_ZONING)}
SHOW_OVERLAYS: ${String(SHOW_OVERLAYS)}
SHOW_ASSESSOR: ${String(SHOW_ASSESSOR)}`
  }] },

  // Keep intent (helps disambiguate)
  { role: "user", parts: [{ text: `Intent: ${intent}` }] },

  // Tools and context (unchanged)
  { role: "user", parts: [{ text:
`=== TOOL OUTPUTS (authoritative) ===
${toolContext || "(none)"}

=== STATIC CONTEXT (supporting) ===
${contextData}`.trim() }] },

  // Original user message
  { role: "user", parts: [{ text: messages[messages.length - 1].content }] },
];


    // --- Step 4: final model call via OpenRouter with fallback ---
   let text = "";
   try { 
     // lower temperature to 0.1 to reduce creative drift
     text = await orWithRetryAndFallback(combinedPrompt, request, 0.1); 
   }
   catch { 
     text = "Zoning/overlays/assessor results are below.\n\n" + friendlyFallbackMessage(); 
   }

   // Defensive post-filter: remove any section the model produced that wasn't flagged
   try {
     if (text) {
       const removeSection = (input: string, heading: string) => {
         const re = new RegExp(`(^|\\n)${heading}\\b[\\s\\S]*?(?=\\n(?:Zoning|Overlays|Assessor)\\b|$)`, "gi");
         return input.replace(re, "");
       };
       if (!SHOW_ZONING) text = removeSection(text, "Zoning");
       if (!SHOW_OVERLAYS) text = removeSection(text, "Overlays");
       if (!SHOW_ASSESSOR) text = removeSection(text, "Assessor");
       text = text.trim();
     }
   } catch (e) {
     console.warn("[CHAT] post-filter failed:", e);
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
