// app/api/chat/route.ts
// Phase 5A: Standardized Zoning Fields Across Jurisdictions
// Includes Phase 4 Performance Optimizations: Deduplication, Parallel Queries, Rate Limiting, Structured Logging
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
import { getCityProvider, debugProvidersLog } from "@/lib/la/providers";
import { createRequestLogger, logRequestMetrics, createTimer, type RequestLogger } from "@/lib/la/logger";
import { checkRateLimit, getClientIdentifier, getRateLimitHeaders, RATE_LIMITS } from "@/lib/la/rateLimit";
import { 
  normalizeZoningData, 
  formatZoningForContext, 
  createZoningCard,
  type NormalizedZoning 
} from "@/lib/la/fieldNormalizer";

export const runtime = "nodejs";
const OR_API_KEY = process.env.OPENROUTER_API_KEY;

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

function wantsAssessorSection(s: string) {
  const q = s.toLowerCase();
  return /\bassessor\b|\bsitus\b|\bliving\s*area\b|\byear\s*built\b|\bunits?\b|\bbedrooms?\b|\bbathrooms?\b|\buse\b|\bsq\s*ft\b|\bsquare\s*feet\b/.test(q);
}

/* ---------------- Grouped Overlay Formatter ---------------- */

interface OverlayCard {
  source: "City" | "County";
  program: "SUD" | "HPOZ" | "CSD" | "SEA" | "Other";
  name: string;
  details?: string;
  attributes?: Record<string, any>;
}

type OverlayCategory = 
  | "Hazards"
  | "Environmental Protection"
  | "Development Regulations"
  | "Historic Preservation"
  | "Supplemental Use Districts"
  | "Community Standards"
  | "Land Use & Planning"
  | "Additional Overlays";

const NOISE_ITEMS = ["county overlay", "city overlay", "overlay"];

function isNoiseItem(name: string, details?: string): boolean {
  const combined = `${name} ${details || ""}`.toLowerCase().trim();
  return NOISE_ITEMS.some(noise => combined === noise || name.toLowerCase().trim() === noise);
}

function cleanRedundantDescription(name: string, details: string | undefined): string {
  if (!details) return '';
  const nameLower = name.toLowerCase();
  const detailsLower = details.toLowerCase();
  const redundantPatterns = [
    'parcel is inside the', 'parcel is within the', 'parcel is in the',
    'located in', 'located within', 'falls within', 'is in the', 'is inside the',
  ];
  for (const pattern of redundantPatterns) {
    if (detailsLower.includes(pattern)) {
      const nameWords = nameLower.split(/\s+/).filter(w => w.length > 3);
      for (const word of nameWords) {
        if (detailsLower.includes(word)) return '';
      }
    }
  }
  return details;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function categorizeOverlay(card: OverlayCard): OverlayCategory {
  const name = (card.name || "").toLowerCase();
  const details = (card.details || "").toLowerCase();
  const combined = `${name} ${details}`;
  
  if (card.program === "SEA" || combined.includes("sea:") || combined.includes("sea ordinance") || combined.includes("significant ecological")) {
    return "Environmental Protection";
  }
  
  if (combined.includes("hillside management") || combined.includes("hillside area") || 
      (combined.includes("hma") && !combined.includes("hazard")) ||
      combined.includes("ridgeline") || combined.includes("grading") ||
      (combined.includes("slope") && !combined.includes("landslide"))) {
    return "Development Regulations";
  }
  
  if (combined.includes("sign district") || combined.includes("sign_dist")) {
    return "Development Regulations";
  }
  
  if (card.program === "CSD" || combined.includes("csd") || combined.includes("community standards")) {
    return "Community Standards";
  }
  
  if (combined.includes("fire") || combined.includes("hazard") || combined.includes("flood") ||
      combined.includes("fema") || combined.includes("sfha") || combined.includes("floodplain") ||
      combined.includes("floodway") || combined.includes("evacuation") || combined.includes("evac zone") ||
      combined.includes("ready set go") || combined.includes("landslide") || combined.includes("fault") ||
      combined.includes("liquefaction") || combined.includes("tsunami") || combined.includes("seismic")) {
    return "Hazards";
  }
  
  if (card.program === "HPOZ" || combined.includes("historic") || combined.includes("hpoz") ||
      combined.includes("landmark") || combined.includes("national register") ||
      combined.includes("monument") || combined.includes("hcm")) {
    return "Historic Preservation";
  }
  
  if (card.program === "SUD" || combined.includes("sud") || combined.includes("supplemental use")) {
    return "Supplemental Use Districts";
  }
  
  if (combined.includes("general plan") || combined.includes("specific plan") ||
      combined.includes("community plan") || combined.includes("transit") ||
      combined.includes("gplu") || combined.includes("land use") || combined.includes("cpa") ||
      combined.includes("redevelopment") || combined.includes("density residential") ||
      combined.includes("low density") || combined.includes("medium density") ||
      combined.includes("high density") || combined.includes("residential —") ||
      combined.includes("commercial —") || combined.includes("industrial —")) {
    return "Land Use & Planning";
  }
  
  return "Additional Overlays";
}

function formatGroupedOverlays(overlays: OverlayCard[], jurisdiction: string): string {
  const safeOverlays = overlays || [];
  
  const groups: Record<OverlayCategory, OverlayCard[]> = {
    "Hazards": [],
    "Environmental Protection": [],
    "Development Regulations": [],
    "Historic Preservation": [],
    "Supplemental Use Districts": [],
    "Community Standards": [],
    "Land Use & Planning": [],
    "Additional Overlays": [],
  };

  for (const card of safeOverlays) {
    if (isNoiseItem(card.name, card.details)) continue;
    const category = categorizeOverlay(card);
    groups[category].push(card);
  }

  const lines: string[] = [];
  lines.push(`JURISDICTION: ${jurisdiction}`);

  const categoryOrder: OverlayCategory[] = [
    "Hazards", "Environmental Protection", "Development Regulations",
    "Historic Preservation", "Supplemental Use Districts",
    "Land Use & Planning", "Community Standards", "Additional Overlays",
  ];

  const keyCategories: OverlayCategory[] = ["Hazards", "Historic Preservation", "Land Use & Planning"];

  for (const category of categoryOrder) {
    const items = groups[category];
    const isKeyCategory = keyCategories.includes(category);
    
    if (items.length === 0 && !isKeyCategory) continue;

    lines.push("");
    lines.push(`${category.toUpperCase()}:`);

    if (items.length === 0) {
      lines.push(`  • None found for this parcel`);
      continue;
    }

    const seen = new Set<string>();
    
    for (const card of items) {
      let itemLine = `  • ${card.name}`;
      
      if (card.details && card.details !== card.name) {
        let detailsClean = cleanRedundantDescription(card.name, card.details);
        if (detailsClean) {
          const namePattern = new RegExp(`^${escapeRegex(card.name)}\\s*[-—]?\\s*`, 'i');
          detailsClean = detailsClean.replace(namePattern, '').trim();
          if (detailsClean && detailsClean !== '—' && detailsClean.length > 2) {
            itemLine += ` — ${detailsClean}`;
          }
        }
      }
      
      const normalized = itemLine.toLowerCase().replace(/\s+/g, " ").trim();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      
      lines.push(itemLine);
    }
  }

  return lines.join("\n");
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

  let detectedJurisdiction: string | null = null;
  let jurisdictionSource: "CITY" | "COUNTY" | "ERROR" | null = null;
  let cacheHits = 0;
  let cacheMisses = 0;
  let overlayCount = 0;
  let communityName: string | null = null;

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

    // Determine which sections to show
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

    log.log('CHAT', 'Flags determined', { SHOW_ZONING, SHOW_OVERLAYS, SHOW_ASSESSOR });

    // --- Step 2: live lookups (TOOL OUTPUTS) ---
    let toolContext = "";
    
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
          log.log('CHAT', 'APN extracted', { apn });
          
          // Get parcel data once (FIX #26 deduplication)
          const parcelTimer = createTimer('parcel_lookup');
          const parcel = await getParcelByAINorAPN(apn);
          parcelTimer.stopAndLog(log);
          
          if (!parcel?.geometry) {
            zoningStatus = "error";
            overlaysStatus = "error";
            assessorStatus = "error";
            const errMsg = `Parcel with APN/AIN ${apn} not found in LA County records.`;
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
              // Jurisdiction lookup
              const jurisdictionTimer = createTimer('jurisdiction_lookup');
              const j = await lookupJurisdictionPoint102100(centroid.x, centroid.y);
              jurisdictionTimer.stopAndLog(log);
              
              detectedJurisdiction = j.jurisdiction || "Unknown";
              jurisdictionSource = j.source;
              
              toolContext += `\n[TOOL:jurisdiction]\n${JSON.stringify(j, null, 2)}`;
              debugProvidersLog(j.jurisdiction);

              if (j?.source === "CITY") {
                // ─────────────────────────────────────────────
                // CITY FLOW
                // ─────────────────────────────────────────────
                const cityName = j.jurisdiction || "";
                const provider = getCityProvider(cityName);

                // FIX #29: Run city queries in parallel
                const dataTimer = createTimer('city_data_queries');
                
                const [zoningResult, overlaysResult, assessorResult] = await Promise.allSettled([
                  SHOW_ZONING && provider
                    ? lookupCityZoning(apn, provider, parcel)
                    : Promise.resolve(null),
                  SHOW_OVERLAYS && provider?.method === "arcgis_query" && provider.overlays?.length
                    ? lookupCityOverlays(centroid, provider.overlays)
                    : Promise.resolve(null),
                  SHOW_ASSESSOR
                    ? lookupAssessor(apn)
                    : Promise.resolve(null),
                ]);
                
                dataTimer.stopAndLog(log);

                // Process zoning result with NORMALIZATION (FIX #32, #33, #34)
                if (SHOW_ZONING) {
                  if (provider) {
                    if (zoningResult.status === "fulfilled" && zoningResult.value) {
                      const cityZ = zoningResult.value as any;
                      const hasZoningData = cityZ?.card?.raw && Object.keys(cityZ.card.raw).length > 0;
                      
                      // DEBUG: Log raw zoning data from city endpoint
                      log.log('ZONING', 'City zoning raw data', {
                        city: cityName,
                        hasData: hasZoningData,
                        fields: hasZoningData ? Object.keys(cityZ.card.raw) : [],
                        sample: hasZoningData ? JSON.stringify(cityZ.card.raw).slice(0, 500) : 'none'
                      });
                      
                      if (hasZoningData) {
                        zoningStatus = "success";
                        
                        // FIX #32, #33, #34: Normalize zoning data
                        const normalized = normalizeZoningData(cityZ.card.raw, detectedJurisdiction!);
                        const formattedZoning = formatZoningForContext(normalized);
                        
                        toolContext += `\n[TOOL:city_zoning]\n${JSON.stringify({
                          status: "success",
                          formatted: formattedZoning,
                          card: createZoningCard(normalized),
                        }, null, 2)}`;
                      } else {
                        zoningStatus = "no_data";
                        zoningMessage = `No zoning data found for this parcel in ${cityName}.`;
                        toolContext += `\n[TOOL:city_zoning]\n${JSON.stringify({
                          status: "no_data",
                          jurisdiction: detectedJurisdiction,
                          message: zoningMessage,
                        }, null, 2)}`;
                      }
                    } else if (zoningResult.status === "rejected") {
                      zoningStatus = "error";
                      zoningMessage = `Error retrieving zoning data.`;
                      toolContext += `\n[TOOL:city_zoning]\n${JSON.stringify({
                        status: "error",
                        jurisdiction: detectedJurisdiction,
                        message: zoningMessage,
                      }, null, 2)}`;
                    }
                  } else {
                    zoningStatus = "not_configured";
                    zoningMessage = `Zoning lookup for ${cityName} is not yet configured.`;
                    toolContext += `\n[TOOL:city_zoning]\n${JSON.stringify({
                      status: "not_configured",
                      jurisdiction: detectedJurisdiction,
                      message: zoningMessage,
                    }, null, 2)}`;
                  }
                }

                // Process overlays result
                if (SHOW_OVERLAYS) {
                  if (provider?.method === "arcgis_query" && provider.overlays?.length) {
                    if (overlaysResult.status === "fulfilled" && overlaysResult.value) {
                      const oData = overlaysResult.value as any;
                      if (oData.overlays && oData.overlays.length > 0) {
                        overlaysStatus = "success";
                        overlayCount = oData.overlays.length;
                        const formattedOverlays = formatGroupedOverlays(oData.overlays, detectedJurisdiction!);
                        toolContext += `\n[TOOL:city_overlays]\n${JSON.stringify({
                          status: "success",
                          formatted: formattedOverlays,
                        }, null, 2)}`;
                      } else {
                        overlaysStatus = "no_data";
                        overlaysMessage = "No special overlays found for this parcel.";
                        toolContext += `\n[TOOL:city_overlays]\n${JSON.stringify({
                          status: "no_data",
                          jurisdiction: detectedJurisdiction,
                          message: overlaysMessage,
                        }, null, 2)}`;
                      }
                    } else if (overlaysResult.status === "rejected") {
                      overlaysStatus = "error";
                      overlaysMessage = `Error retrieving overlays.`;
                      toolContext += `\n[TOOL:city_overlays]\n${JSON.stringify({
                        status: "error",
                        jurisdiction: detectedJurisdiction,
                        message: overlaysMessage,
                      }, null, 2)}`;
                    }
                  } else {
                    overlaysStatus = "not_configured";
                    overlaysMessage = `Overlay lookup for ${cityName} is not yet configured.`;
                    toolContext += `\n[TOOL:city_overlays]\n${JSON.stringify({
                      status: "not_configured",
                      jurisdiction: detectedJurisdiction,
                      message: overlaysMessage,
                    }, null, 2)}`;
                  }
                }

                // Process assessor result
                if (SHOW_ASSESSOR) {
                  if (assessorResult.status === "fulfilled" && assessorResult.value) {
                    const a = assessorResult.value as any;
                    if (a.ain || a.situs || a.use) {
                      assessorStatus = "success";
                      toolContext += `\n[TOOL:assessor]\n${JSON.stringify({
                        status: "success",
                        ...a
                      }, null, 2)}`;
                    } else {
                      assessorStatus = "no_data";
                      assessorMessage = "No assessor details found.";
                      toolContext += `\n[TOOL:assessor]\n${JSON.stringify({
                        status: "no_data",
                        message: assessorMessage,
                        links: a?.links
                      }, null, 2)}`;
                    }
                  } else if (assessorResult.status === "rejected") {
                    assessorStatus = "error";
                    assessorMessage = "Error retrieving assessor data.";
                    toolContext += `\n[TOOL:assessor]\n${JSON.stringify({
                      status: "error",
                      message: assessorMessage
                    }, null, 2)}`;
                  }
                }

              } else {
                // ─────────────────────────────────────────────
                // COUNTY / UNINCORPORATED FLOW
                // ─────────────────────────────────────────────
                if (!detectedJurisdiction || detectedJurisdiction === "Unknown") {
                  detectedJurisdiction = "Unincorporated LA County";
                }
                
                // FIX #29: Run ALL county queries in PARALLEL, pass parcel to avoid re-fetch
                const dataTimer = createTimer('county_data_queries');
                
                const [zRes, aRes, oRes] = await Promise.allSettled([
                  SHOW_ZONING   ? lookupZoning(apn, parcel)   : Promise.resolve(null),
                  SHOW_ASSESSOR ? lookupAssessor(apn, parcel) : Promise.resolve(null),
                  SHOW_OVERLAYS ? lookupOverlays(apn, parcel) : Promise.resolve(null),
                ]);
                
                dataTimer.stopAndLog(log);

                // Extract community name from assessor
                if (aRes.status === "fulfilled" && (aRes.value as any)?.city) {
                  const assessorCity = (aRes.value as any).city;
                  if (assessorCity && !assessorCity.toLowerCase().includes('unincorporated')) {
                    communityName = assessorCity;
                    const titleCaseCommunity = assessorCity
                      .split(' ')
                      .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
                      .join(' ')
                      .replace(/ Ca$/i, '');
                    detectedJurisdiction = `Unincorporated LA County (${titleCaseCommunity})`;
                  }
                }

                // Handle zoning result with NORMALIZATION (FIX #32, #33, #34)
                if (SHOW_ZONING) {
                  if (zRes.status === "fulfilled" && zRes.value) {
                    const zData = zRes.value as any;
                    if (zData.zoning) {
                      zoningStatus = "success";
                      
                      // FIX #32, #33, #34: Build raw data object from county response
                      const rawZoningData: Record<string, any> = {
                        ZONE: zData.zoning,
                        ...(zData.details || {}),
                      };
                      
                      const normalized = normalizeZoningData(rawZoningData, detectedJurisdiction!);
                      const formattedZoning = formatZoningForContext(normalized);
                      
                      toolContext += `\n[TOOL:zoning]\n${JSON.stringify({
                        status: "success",
                        formatted: formattedZoning,
                        card: createZoningCard(normalized),
                        links: zData.links,
                      }, null, 2)}`;
                    } else {
                      zoningStatus = "no_data";
                      zoningMessage = zData.note || "No zoning data found for this parcel.";
                      toolContext += `\n[TOOL:zoning]\n${JSON.stringify({
                        status: "no_data",
                        jurisdiction: detectedJurisdiction,
                        message: zoningMessage,
                        links: zData.links
                      }, null, 2)}`;
                    }
                  } else if (zRes.status === "rejected") {
                    zoningStatus = "error";
                    zoningMessage = `Error retrieving zoning data.`;
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
                    const aData = aRes.value as any;
                    if (aData.ain || aData.situs || aData.use) {
                      assessorStatus = "success";
                      const assessorData: Record<string, any> = { ...aData };
                      if (communityName && assessorData.city) {
                        assessorData.area = assessorData.city;
                        delete assessorData.city;
                      }
                      toolContext += `\n[TOOL:assessor]\n${JSON.stringify({
                        status: "success",
                        ...assessorData
                      }, null, 2)}`;
                    } else {
                      assessorStatus = "no_data";
                      assessorMessage = "No assessor details found for this parcel.";
                      toolContext += `\n[TOOL:assessor]\n${JSON.stringify({
                        status: "no_data",
                        message: assessorMessage,
                        links: aData.links
                      }, null, 2)}`;
                    }
                  } else if (aRes.status === "rejected") {
                    assessorStatus = "error";
                    assessorMessage = `Error retrieving assessor data.`;
                    toolContext += `\n[TOOL:assessor]\n${JSON.stringify({
                      status: "error",
                      message: assessorMessage
                    }, null, 2)}`;
                  }
                }
                
                // Handle overlays result
                if (SHOW_OVERLAYS) {
                  if (oRes.status === "fulfilled" && oRes.value) {
                    const oData = oRes.value as any;
                    if (oData.overlays && oData.overlays.length > 0) {
                      overlaysStatus = "success";
                      overlayCount = oData.overlays.length;
                      const formattedOverlays = formatGroupedOverlays(oData.overlays, detectedJurisdiction!);
                      toolContext += `\n[TOOL:overlays]\n${JSON.stringify({
                        status: "success",
                        formatted: formattedOverlays,
                        links: oData.links
                      }, null, 2)}`;
                    } else {
                      overlaysStatus = "no_data";
                      overlaysMessage = "No special overlays found for this parcel.";
                      toolContext += `\n[TOOL:overlays]\n${JSON.stringify({
                        status: "no_data",
                        jurisdiction: detectedJurisdiction,
                        message: overlaysMessage,
                        links: oData.links
                      }, null, 2)}`;
                    }
                  } else if (oRes.status === "rejected") {
                    overlaysStatus = "error";
                    overlaysMessage = `Error retrieving overlays.`;
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
          zoningStatus = "not_implemented";
          overlaysStatus = "not_implemented";
          assessorStatus = "not_implemented";
          const msg = "Address-to-parcel lookup is coming soon. For now, please provide an APN (e.g., 5843-004-015).";
          zoningMessage = msg;
          overlaysMessage = msg;
          assessorMessage = msg;
          toolContext += `\n[TOOL_NOTE] ${msg}`;
        } else {
          toolContext += `\n[TOOL_NOTE] No APN/AIN or address detected in the query.`;
        }
      }
    } catch (e) {
      zoningStatus = "error";
      overlaysStatus = "error";
      assessorStatus = "error";
      const errMsg = `Unexpected error: ${String(e)}`;
      zoningMessage = errMsg;
      overlaysMessage = errMsg;
      assessorMessage = errMsg;
      toolContext += `\n[TOOL_ERROR] ${errMsg}`;
      log.error('CHAT', 'Unexpected error in data lookup', { error: String(e) });
    }
    
    toolContext += `\n\n[SECTION_STATUS]
ZONING_STATUS: ${zoningStatus}${zoningMessage ? `\nZONING_MESSAGE: ${zoningMessage}` : ''}
OVERLAYS_STATUS: ${overlaysStatus}${overlaysMessage ? `\nOVERLAYS_MESSAGE: ${overlaysMessage}` : ''}
ASSESSOR_STATUS: ${assessorStatus}${assessorMessage ? `\nASSESSOR_MESSAGE: ${assessorMessage}` : ''}`;

    log.log('CHAT', 'Tool context ready', { length: toolContext.length });
    log.benchmark('tool_context_ready');

    // --- Step 3: Build prompts ---
    // FIX #32, #33, #34: Updated system prompt with standardized field names
    const systemPreamble = `
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
            // FIX #32: Filter out old inconsistent field names that shouldn't appear
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
      apn: extractApn(lastUser),
      jurisdiction: detectedJurisdiction || undefined,
      totalTime,
      cacheHits,
      cacheMisses,
      overlayCount,
      benchmarks: log.getBenchmarks(),
      timestamp: new Date().toISOString(),
    });

    return NextResponse.json(
      { response: text, intent },
      { 
        status: 200,
        headers: getRateLimitHeaders(rateCheck)
      }
    );
  } catch (error: any) {
    log.error('CHAT', 'Fatal error', { error: String(error) });
    return NextResponse.json(
      { response: friendlyFallbackMessage(), intent: "" },
      { 
        status: 200,
        headers: getRateLimitHeaders(rateCheck)
      }
    );
  }
}
