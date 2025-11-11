import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { loadAllContextFiles } from "../../utils/contextLoader";
import { 
  lookupZoning, 
  lookupAssessor, 
  lookupOverlays, 
  getParcelByAINorAPN,
  makeCentroidFromGeom,
  lookupJurisdictionPoint102100,
  lookupCityZoning
} from "@/lib/la/fetchers";
import { resolveCityProvider, getCityProvider, debugProvidersLog } from "@/lib/la/providers";

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
  // If they mention a parcel ID, they almost always want the zoning for it.
  return /\bzoning\b|\bzone\b|apn|ain|r-\d{1,5}|\btitle\s*22\b|\bplng\b|\bplanning\s*area\b/.test(q);
}

function wantsOverlaysSection(s: string) {
  const q = s.toLowerCase();
  // broader matcher, accept overlay(s) term and other overlay-like tokens
  return /\boverlays?\b|\bcsd\b|\bsea\b|\bridgeline\b|\btod\b|\bhpoz\b|\bspecific\s*plan\b|\bplan[_\s-]?leg\b/.test(q);
}

function wantsAssessorSection(s: string) {
  // Narrowed: do NOT trigger on APN/AIN alone. Only real assessor-related keywords.
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
    const { messages } = await request.json();
    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: "Invalid request. Messages must be an array." }, { status: 400 });
    }

    const contextData = await loadAllContextFiles();
    const lastUser = messages[messages.length - 1]?.content || "";
    const intent = lastUser; // Use raw user input for intent

    // --- Step 1b: decide which sections to render based on intent ---
    const qForIntent = intent.toLowerCase();

    let SHOW_ZONING   = false;
    let SHOW_OVERLAYS = false;
    let SHOW_ASSESSOR = false;

    // More precise intent detection:
    const hasSpecificTerm = /\b(zoning|zone|overlays?|assessor)\b/i.test(qForIntent);

    if (hasSpecificTerm) {
      // If a specific keyword is used, only show that section.
      SHOW_ZONING = /\b(zoning|zone)\b/i.test(qForIntent);
      SHOW_OVERLAYS = /\boverlays?\b/i.test(qForIntent);
      SHOW_ASSESSOR = wantsAssessorSection(qForIntent); // This one is already specific
    } else {
      // If no specific term, check for broader indicators.
      // A query with an APN/AIN and no other specifier implies zoning.
      if (wantsParcelLookup(qForIntent)) {
        SHOW_ZONING = true;
      }
    }

    console.log("[CHAT] Flags:", { SHOW_ZONING, SHOW_OVERLAYS, SHOW_ASSESSOR });

    // --- Step 2: live lookups (TOOL OUTPUTS) ---
    let toolContext = "";
    try {
      if (wantsParcelLookup(lastUser)) {
        const apn = extractApn(lastUser);
        const address = extractAddress(lastUser);

if (apn) {
  // 1) Get parcel + centroid (for jurisdiction + city services)
  const parcel = await getParcelByAINorAPN(apn);
  if (!parcel?.geometry) {
    throw new Error(`Parcel with APN/AIN ${apn} not found or missing geometry.`);
  }

  const centroid = makeCentroidFromGeom(parcel.geometry);
  if (!centroid) {
    throw new Error(`Could not compute centroid for APN/AIN ${apn}.`);
  }

  // 2) Jurisdiction lookup (point in 102100)
  const j = await lookupJurisdictionPoint102100(centroid.x, centroid.y);
  toolContext += `\n[TOOL:jurisdiction]\n${JSON.stringify(j, null, 2)}`;

  // Log what providers we have vs what came back from DPW
  debugProvidersLog(j.jurisdiction);

  if (j?.source === "CITY") {
    const cityName = j.jurisdiction || "";
    const provider = getCityProvider(cityName);

    // --- CITY ZONING ---
    if (SHOW_ZONING) {
      if (provider) {
        const cityZ = await lookupCityZoning(apn, provider);
        // cityZ already has a 'card' shape; stringify that for the model
        toolContext += `\n[TOOL:city_zoning]\n${JSON.stringify(cityZ.card ?? cityZ, null, 2)}`;
      } else {
        // City parcel but not in CITY_PROVIDERS_JSON
        toolContext += `\n[TOOL:city_zoning]\n${JSON.stringify(
          {
            note: "Parcel is in a city not yet configured; county zoning does not apply.",
            city: cityName,
          },
          null,
          2
        )}`;
      }
    }

    // --- CITY OVERLAYS (placeholder / viewer-based for now) ---
    if (SHOW_OVERLAYS) {
      toolContext += `\n[TOOL:city_overlays]\n${JSON.stringify(
        {
          note: "City parcel; use the city's GIS for overlays/specific plans.",
          city: cityName,
          viewer: provider && "viewer" in provider ? provider.viewer : null,
        },
        null,
        2
      )}`;
    }

    // --- ASSESSOR (still County-wide) ---
    if (SHOW_ASSESSOR) {
      const a = await lookupAssessor(apn).catch(() => null);
      if (a) {
        toolContext += `\n[TOOL:assessor]\n${JSON.stringify(a, null, 2)}`;
      }
    }

    // NOTE: For CITY parcels we intentionally skip County zoning/overlay layers.
  } else {
    // --- COUNTY / UNINCORPORATED FLOW ---
    const [zRes, aRes, oRes] = await Promise.allSettled([
      SHOW_ZONING   ? lookupZoning(apn)   : Promise.resolve(null),
      SHOW_ASSESSOR ? lookupAssessor(apn) : Promise.resolve(null),
      SHOW_OVERLAYS ? lookupOverlays(apn) : Promise.resolve(null),
    ]);

    if (SHOW_ZONING && zRes.status === "fulfilled" && zRes.value) {
      toolContext += `\n[TOOL:zoning]\n${JSON.stringify(zRes.value, null, 2)}`;
    }
    if (SHOW_ASSESSOR && aRes.status === "fulfilled" && aRes.value) {
      toolContext += `\n[TOOL:assessor]\n${JSON.stringify(aRes.value, null, 2)}`;
    }
    if (SHOW_OVERLAYS && oRes.status === "fulfilled" && oRes.value) {
      toolContext += `\n[TOOL:overlays]\n${JSON.stringify(oRes.value, null, 2)}`;
    }
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

    // --- Step 3: build prompts with tools first ---
    const systemPreamble = `
You are LA-Fires Assistant.
Rules:
- Use TOOL OUTPUTS as the single source of truth when present.
- Render ONLY the sections whose flags are true.
- If a flagged section has no tool data, output exactly: <Section Heading>\nSection: Unknown
- Never include any section that is not flagged.
- Output plain text only (no Markdown).
- Valid headings: Zoning, Overlays, Assessor.
- Inside a section, print concise KEY: VALUE lines.
- Order: Zoning, Overlays, Assessor.
`.trim();

    const customSystemPrompt = {
      role: "user",
      parts: [{
        text: `Do NOT include any section whose SHOW_* flag is false. If all flags are false, ask the user to be more specific.`
      }],
    };

    const combinedPrompt = [
      { role: "user", parts: [{ text: systemPreamble }] },
      customSystemPrompt,
      { role: "user", parts: [{ text: `CONTROL FLAGS\nSHOW_ZONING: ${SHOW_ZONING}\nSHOW_OVERLAYS: ${SHOW_OVERLAYS}\nSHOW_ASSESSOR: ${SHOW_ASSESSOR}` }] },
      { role: "user", parts: [{ text: `Intent: ${intent}` }] },
      { role: "user", parts: [{ text: `=== TOOL OUTPUTS (authoritative) ===\n${toolContext || "(none)"}\n\n=== STATIC CONTEXT (supporting) ===\n${contextData}`.trim() }] },
      { role: "user", parts: [{ text: messages[messages.length - 1].content }] },
    ];

    // --- Step 4: final model call via OpenRouter with fallback ---
    let text = "";
    try {
      // **FIX**: Lower temperature for more consistent output
      text = await orWithRetryAndFallback(combinedPrompt, request, 0.05);
    } catch {
      text = "Zoning/overlays/assessor results are below.\n\n" + friendlyFallbackMessage();
    }

    // Defensive post-filter
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
    return NextResponse.json({ response: friendlyFallbackMessage(), intent: "" }, { status: 200 });
  }
}
