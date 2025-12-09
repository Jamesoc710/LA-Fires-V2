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
  lookupCityZoning,
  lookupCityOverlays
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
  return /\bzoning\b|\bzone\b|apn|ain|r-\d{1,5}|\btitle\s*22\b|\bplng\b|\bplanning\s*area\b/.test(q);
}

function wantsOverlaysSection(s: string) {
  const q = s.toLowerCase();
  return /\boverlays?\b|\bcsd\b|\bsea\b|\bridgeline\b|\btod\b|\bhpoz\b|\bspecific\s*plan\b|\bplan[_\s-]?leg\b/.test(q);
}

function wantsAssessorSection(s: string) {
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
    const intent = lastUser;

    // --- Step 1b: decide which sections to render based on intent ---
    const qForIntent = intent.toLowerCase();

    let SHOW_ZONING   = false;
    let SHOW_OVERLAYS = false;
    let SHOW_ASSESSOR = false;

    const hasSpecificTerm = /\b(zoning|zone|overlays?|assessor)\b/i.test(qForIntent);

    if (hasSpecificTerm) {
      SHOW_ZONING = /\b(zoning|zone)\b/i.test(qForIntent);
      SHOW_OVERLAYS = /\boverlays?\b/i.test(qForIntent);
      SHOW_ASSESSOR = wantsAssessorSection(qForIntent);
    } else {
      if (wantsParcelLookup(qForIntent)) {
        SHOW_ZONING = true;
      }
    }

    console.log("[CHAT] Flags:", { SHOW_ZONING, SHOW_OVERLAYS, SHOW_ASSESSOR });

    // --- Step 2: live lookups (TOOL OUTPUTS) ---
    let toolContext = "";
    
    // Track jurisdiction for consistent output
    let detectedJurisdiction: string | null = null;
    let jurisdictionSource: "CITY" | "COUNTY" | "ERROR" | null = null;
    
    // Track status for each section to provide clear messaging
    type SectionStatus = "success" | "no_data" | "error" | "not_configured" | "not_implemented";
    let zoningStatus: SectionStatus = "no_data";
    let overlaysStatus: SectionStatus = "no_data";
    let assessorStatus: SectionStatus = "no_data";
    let zoningMessage: string | null = null;
    let overlaysMessage: string | null = null;
    let assessorMessage: string | null = null;
    
    try {
      if (wantsParcelLookup(lastUser)) {
        const apn = extractApn(lastUser);
        const address = extractAddress(lastUser);

        if (apn) {
          // 1) Get parcel + centroid (for jurisdiction + city services)
          const parcel = await getParcelByAINorAPN(apn);
          if (!parcel?.geometry) {
            // Parcel not found - this affects all sections
            zoningStatus = "error";
            overlaysStatus = "error";
            assessorStatus = "error";
            const errMsg = `Parcel with APN/AIN ${apn} not found in LA County records. Please verify the APN is correct.`;
            zoningMessage = errMsg;
            overlaysMessage = errMsg;
            assessorMessage = errMsg;
            toolContext += `\n[TOOL_ERROR] ${errMsg}`;
          } else {
            const centroid = makeCentroidFromGeom(parcel.geometry);
            if (!centroid) {
              zoningStatus = "error";
              overlaysStatus = "error";
              const errMsg = `Could not compute location for APN/AIN ${apn}. The parcel geometry may be invalid.`;
              zoningMessage = errMsg;
              overlaysMessage = errMsg;
              toolContext += `\n[TOOL_ERROR] ${errMsg}`;
            } else {
              // 2) Jurisdiction lookup (point in 102100)
              const j = await lookupJurisdictionPoint102100(centroid.x, centroid.y);
              
              detectedJurisdiction = j.jurisdiction || "Unknown";
              jurisdictionSource = j.source;
              
              toolContext += `\n[TOOL:jurisdiction]\n${JSON.stringify(j, null, 2)}`;

              debugProvidersLog(j.jurisdiction);

              if (j?.source === "CITY") {
                const cityName = j.jurisdiction || "";
                const provider = getCityProvider(cityName);

                // --- CITY ZONING ---
                if (SHOW_ZONING) {
                  if (provider) {
                    try {
                      const cityZ = await lookupCityZoning(apn, provider);
                      const hasZoningData = cityZ?.card?.raw && Object.keys(cityZ.card.raw).length > 0;
                      
                      if (hasZoningData) {
                        zoningStatus = "success";
                        const cardWithJurisdiction = {
                          status: "success",
                          ...(cityZ.card ?? cityZ),
                          jurisdiction: detectedJurisdiction,
                        };
                        toolContext += `\n[TOOL:city_zoning]\n${JSON.stringify(cardWithJurisdiction, null, 2)}`;
                      } else {
                        zoningStatus = "no_data";
                        zoningMessage = `No zoning data found for this parcel in ${cityName}. Check the city's official zoning viewer.`;
                        toolContext += `\n[TOOL:city_zoning]\n${JSON.stringify({
                          status: "no_data",
                          jurisdiction: detectedJurisdiction,
                          message: zoningMessage,
                          viewer: provider.viewer
                        }, null, 2)}`;
                      }
                    } catch (e) {
                      zoningStatus = "error";
                      zoningMessage = `Error retrieving zoning data. Try again or check the city's GIS viewer.`;
                      toolContext += `\n[TOOL:city_zoning]\n${JSON.stringify({
                        status: "error",
                        jurisdiction: detectedJurisdiction,
                        message: zoningMessage,
                        viewer: provider.viewer
                      }, null, 2)}`;
                    }
                  } else {
                    zoningStatus = "not_configured";
                    zoningMessage = `Zoning lookup for ${cityName} is not yet configured. County zoning does not apply to city parcels.`;
                    toolContext += `\n[TOOL:city_zoning]\n${JSON.stringify({
                      status: "not_configured",
                      jurisdiction: detectedJurisdiction,
                      city: cityName,
                      message: zoningMessage,
                    }, null, 2)}`;
                  }
                }

                // --- CITY OVERLAYS ---
                if (SHOW_OVERLAYS) {
                  if (
                    provider &&
                    provider.method === "arcgis_query" &&
                    Array.isArray(provider.overlays) &&
                    provider.overlays.length > 0
                  ) {
                    const centroidForOverlays = makeCentroidFromGeom(parcel.geometry);

                    if (centroidForOverlays) {
                      try {
                        const { overlays, note } = await lookupCityOverlays(
                          centroidForOverlays,
                          provider.overlays
                        );

                        if (overlays && overlays.length > 0) {
                          overlaysStatus = "success";
                          toolContext += `\n[TOOL:city_overlays]\n${JSON.stringify({
                            status: "success",
                            jurisdiction: detectedJurisdiction,
                            city: cityName,
                            overlays,
                            note: note ?? undefined
                          }, null, 2)}`;
                        } else {
                          overlaysStatus = "no_data";
                          overlaysMessage = "No special overlays, specific plans, or hazard zones found for this parcel.";
                          toolContext += `\n[TOOL:city_overlays]\n${JSON.stringify({
                            status: "no_data",
                            jurisdiction: detectedJurisdiction,
                            city: cityName,
                            message: overlaysMessage,
                            viewer: "viewer" in provider ? provider.viewer : null
                          }, null, 2)}`;
                        }
                      } catch (e) {
                        overlaysStatus = "error";
                        overlaysMessage = `Error retrieving overlays. Try again or check the city's GIS viewer.`;
                        toolContext += `\n[TOOL:city_overlays]\n${JSON.stringify({
                          status: "error",
                          jurisdiction: detectedJurisdiction,
                          city: cityName,
                          message: overlaysMessage,
                          viewer: "viewer" in provider ? provider.viewer : null
                        }, null, 2)}`;
                      }
                    } else {
                      overlaysStatus = "error";
                      overlaysMessage = "Could not compute parcel location for overlay lookup.";
                      toolContext += `\n[TOOL:city_overlays]\n${JSON.stringify({
                        status: "error",
                        jurisdiction: detectedJurisdiction,
                        city: cityName,
                        message: overlaysMessage,
                        viewer: "viewer" in provider ? provider.viewer : null
                      }, null, 2)}`;
                    }
                  } else {
                    overlaysStatus = "not_configured";
                    overlaysMessage = `Overlay lookup for ${cityName} is not yet configured. Use the city's official GIS viewer.`;
                    toolContext += `\n[TOOL:city_overlays]\n${JSON.stringify({
                      status: "not_configured",
                      jurisdiction: detectedJurisdiction,
                      city: cityName,
                      message: overlaysMessage,
                      viewer: provider && "viewer" in provider ? provider.viewer : null
                    }, null, 2)}`;
                  }
                }

                // --- ASSESSOR (still County-wide) ---
                if (SHOW_ASSESSOR) {
                  try {
                    const a = await lookupAssessor(apn);
                    if (a && (a.ain || a.situs || a.use)) {
                      assessorStatus = "success";
                      toolContext += `\n[TOOL:assessor]\n${JSON.stringify({
                        status: "success",
                        ...a
                      }, null, 2)}`;
                    } else {
                      assessorStatus = "no_data";
                      assessorMessage = "No assessor details found. The parcel may be new or records may not be digitized.";
                      toolContext += `\n[TOOL:assessor]\n${JSON.stringify({
                        status: "no_data",
                        message: assessorMessage,
                        links: a?.links
                      }, null, 2)}`;
                    }
                  } catch (e) {
                    assessorStatus = "error";
                    assessorMessage = "Error retrieving assessor data. Try the LA County Assessor portal directly.";
                    toolContext += `\n[TOOL:assessor]\n${JSON.stringify({
                      status: "error",
                      message: assessorMessage
                    }, null, 2)}`;
                  }
                }

              } else {
                // --- COUNTY / UNINCORPORATED FLOW ---
                
                if (!detectedJurisdiction || detectedJurisdiction === "Unknown") {
                  detectedJurisdiction = "Unincorporated LA County";
                }
                
                const [zRes, aRes, oRes] = await Promise.allSettled([
                  SHOW_ZONING   ? lookupZoning(apn)   : Promise.resolve(null),
                  SHOW_ASSESSOR ? lookupAssessor(apn) : Promise.resolve(null),
                  SHOW_OVERLAYS ? lookupOverlays(apn) : Promise.resolve(null),
                ]);

                // Handle zoning result
                if (SHOW_ZONING) {
                  if (zRes.status === "fulfilled" && zRes.value) {
                    if (zRes.value.zoning) {
                      zoningStatus = "success";
                      const zoningWithJurisdiction = {
                        status: "success",
                        jurisdiction: detectedJurisdiction,
                        ...zRes.value,
                      };
                      toolContext += `\n[TOOL:zoning]\n${JSON.stringify(zoningWithJurisdiction, null, 2)}`;
                    } else {
                      zoningStatus = "no_data";
                      zoningMessage = zRes.value.note || "No zoning data found for this parcel.";
                      toolContext += `\n[TOOL:zoning]\n${JSON.stringify({
                        status: "no_data",
                        jurisdiction: detectedJurisdiction,
                        message: zoningMessage,
                        links: zRes.value.links
                      }, null, 2)}`;
                    }
                  } else if (zRes.status === "rejected") {
                    zoningStatus = "error";
                    zoningMessage = `Error retrieving zoning data. Try again later.`;
                    toolContext += `\n[TOOL:zoning]\n${JSON.stringify({
                      status: "error",
                      jurisdiction: detectedJurisdiction,
                      message: zoningMessage
                    }, null, 2)}`;
                  }
                }
                
                // Handle assessor result
                if (SHOW_ASSESSOR) {
                  if (aRes.status === "fulfilled" && aRes.value) {
                    if (aRes.value.ain || aRes.value.situs || aRes.value.use) {
                      assessorStatus = "success";
                      toolContext += `\n[TOOL:assessor]\n${JSON.stringify({
                        status: "success",
                        ...aRes.value
                      }, null, 2)}`;
                    } else {
                      assessorStatus = "no_data";
                      assessorMessage = "No assessor details found for this parcel.";
                      toolContext += `\n[TOOL:assessor]\n${JSON.stringify({
                        status: "no_data",
                        message: assessorMessage,
                        links: aRes.value.links
                      }, null, 2)}`;
                    }
                  } else if (aRes.status === "rejected") {
                    assessorStatus = "error";
                    assessorMessage = `Error retrieving assessor data. Try the LA County Assessor portal.`;
                    toolContext += `\n[TOOL:assessor]\n${JSON.stringify({
                      status: "error",
                      message: assessorMessage
                    }, null, 2)}`;
                  }
                }
                
                // Handle overlays result
                if (SHOW_OVERLAYS) {
                  if (oRes.status === "fulfilled" && oRes.value) {
                    if (oRes.value.overlays && oRes.value.overlays.length > 0) {
                      overlaysStatus = "success";
                      const overlaysWithJurisdiction = {
                        status: "success",
                        jurisdiction: detectedJurisdiction,
                        ...oRes.value,
                      };
                      toolContext += `\n[TOOL:overlays]\n${JSON.stringify(overlaysWithJurisdiction, null, 2)}`;
                    } else {
                      overlaysStatus = "no_data";
                      overlaysMessage = "No special overlays, CSDs, SEAs, or hazard zones found for this parcel.";
                      toolContext += `\n[TOOL:overlays]\n${JSON.stringify({
                        status: "no_data",
                        jurisdiction: detectedJurisdiction,
                        message: overlaysMessage,
                        links: oRes.value.links
                      }, null, 2)}`;
                    }
                  } else if (oRes.status === "rejected") {
                    overlaysStatus = "error";
                    overlaysMessage = `Error retrieving overlays. Try again later.`;
                    toolContext += `\n[TOOL:overlays]\n${JSON.stringify({
                      status: "error",
                      jurisdiction: detectedJurisdiction,
                      message: overlaysMessage
                    }, null, 2)}`;
                  }
                }
              }
            }
          }
        } else if (address) {
          // Address lookup not yet implemented
          zoningStatus = "not_implemented";
          overlaysStatus = "not_implemented";
          assessorStatus = "not_implemented";
          const msg = "Address-to-parcel lookup is coming soon. For now, please provide an APN (e.g., 5843-004-015) which you can find on your property tax bill or at the LA County Assessor website.";
          zoningMessage = msg;
          overlaysMessage = msg;
          assessorMessage = msg;
          toolContext += `\n[TOOL_NOTE] ${msg}`;
        } else {
          toolContext += `\n[TOOL_NOTE] No APN/AIN or address detected in the query.`;
        }
      }
    } catch (e) {
      // Unexpected error - mark all sections as error
      zoningStatus = "error";
      overlaysStatus = "error";
      assessorStatus = "error";
      const errMsg = `Unexpected error: ${String(e)}`;
      zoningMessage = errMsg;
      overlaysMessage = errMsg;
      assessorMessage = errMsg;
      toolContext += `\n[TOOL_ERROR] ${errMsg}`;
    }
    
    // Add section status summary for the LLM
    toolContext += `\n\n[SECTION_STATUS]
ZONING_STATUS: ${zoningStatus}${zoningMessage ? `\nZONING_MESSAGE: ${zoningMessage}` : ''}
OVERLAYS_STATUS: ${overlaysStatus}${overlaysMessage ? `\nOVERLAYS_MESSAGE: ${overlaysMessage}` : ''}
ASSESSOR_STATUS: ${assessorStatus}${assessorMessage ? `\nASSESSOR_MESSAGE: ${assessorMessage}` : ''}`;

    console.log("[CHAT] toolContext length:", toolContext.length);

    // --- Step 3: build prompts with tools first ---

const systemPreamble = `
You are LA-Fires Assistant.

You answer for a single parcel at a time and you only use the TOOL OUTPUTS provided.

RULES
- Treat TOOL OUTPUTS as the only source of facts. Do not invent data.
- Only include a section if its SHOW_* flag is true.
- Use plain text only (no Markdown, no bullets, no tables).
- Inside each section, use concise "KEY: VALUE" lines.
- Prefer human-friendly fields such as: jurisdiction, zone, category, community plan,
  plan designation, program, name, description, SEA_NAME, HAZ_CLASS, CSD_NAME, etc.
- Do NOT show low-level technical fields such as SHAPE*, geometry, OBJECTID,
  internal IDs, URLs, or status fields.
- Do not mention tools, JSON, or APIs in the final answer.

HANDLING SECTION STATUS
Check the [SECTION_STATUS] block for each section's status:
- "success": Show the data from tool outputs normally.
- "no_data": Show the section heading, then: "None found for this parcel."
- "error": Show the section heading, then: "Could not retrieve data. Please try again or check the official viewer."
- "not_configured": Show the section heading, then: "Not yet available for this city. Use the city's official GIS viewer."
- "not_implemented": Show the section heading, then the message from SECTION_STATUS.

IMPORTANT - JURISDICTION
- The Zoning section MUST always include JURISDICTION as the first field.
- Use the jurisdiction value from the tool outputs (e.g., "Los Angeles", "Pasadena", "Unincorporated LA County").
- This tells the user which city or county rules apply to their parcel.

FORMAT
- Structure your answer into up to three sections, in this order:
  Zoning
  Overlays
  Assessor
- Put each section heading alone on its own line, exactly as written above.
- Under each heading, only write KEY: VALUE lines.
- For the Zoning section, always start with JURISDICTION: <value>
- Never include a section whose SHOW_* flag is false.
`.trim();

    
const combinedPrompt = [
  { role: "system", parts: [{ text: systemPreamble }] },
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
        `${contextData}`.trim()
    }],
  },
  { role: "user", parts: [{ text: messages[messages.length - 1].content }] },
];


    // --- Step 4: final model call via OpenRouter with fallback ---
    let text = "";
    try {
      text = await orWithRetryAndFallback(combinedPrompt, request, 0.05);
    } catch {
      text = "Zoning/overlays/assessor results are below.\n\n" + friendlyFallbackMessage();
    }

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
            if (/^\s*(SHAPE[_A-Z0-9]*|shape[_a-z0-9]*)\s*:/i.test(line)) {
              return false;
            }
            // Also filter out status fields that might leak through
            if (/^\s*STATUS\s*:\s*(success|no_data|error|not_configured|not_implemented)\s*$/i.test(line)) {
              return false;
            }
            return true;
          });

        text = cleanedLines.join("\n").trim();
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
