// lib/la/parcelLookup.ts
// Phase 1: parcel lookup orchestration extracted from app/api/chat/route.ts.
// Produces BOTH the structured cards returned to the client and the text
// tool-context handed to the LLM, from the same underlying data.

import {
  lookupZoning,
  lookupAssessor,
  lookupOverlays,
  getParcelByAINorAPN,
  makeCentroidFromGeom,
  lookupJurisdictionPoint102100,
  lookupCityZoning,
  lookupCityOverlays,
  searchParcelsByAddress,
  looksLikeAddress,
  type AddressSearchResult,
  lookupUniversalHazards,
} from "./fetchers";
import { getCityProvider, debugProvidersLog } from "./providers";
import { createTimer, type RequestLogger } from "./logger";
import {
  normalizeZoningData,
  formatZoningForContext,
  createZoningCard,
} from "./fieldNormalizer";
import type {
  OverlayCard,
  OverlayCategory,
  OverlayGroupCard,
  OverlayGroupItem,
  ParcelCards,
  SectionStatus,
  StandardizedZoningCard,
  AssessorCard,
} from "./types";

/* ------------------------- intent/extraction helpers ------------------------- */

// APN/AIN as an explicit 4-3-3 pattern with dashes, spaces, or dots (e.g. 5843-004-015)
const APN_DASHED_REGEX = /\b\d{4}[-\s.]\d{3}[-\s.]\d{3}\b/;
// Bare 10-digit run only counts as an APN when paired with a parcel-related keyword,
// so phone numbers and other incidental 9-10 digit strings don't trigger a lookup.
const PARCEL_KEYWORD_REGEX = /\b(apn|ain|parcel|assessor|property\s*id)\b/i;

export function extractApn(s: string): string | undefined {
  const dashed = s.match(APN_DASHED_REGEX);
  if (dashed) return dashed[0].replace(/\D/g, "");

  if (PARCEL_KEYWORD_REGEX.test(s)) {
    const bare = s.match(/\b\d{10}\b/);
    if (bare) return bare[0];
  }

  return undefined;
}

// Parcel-flavored keywords: the query is asking about a parcel/zoning/overlay/assessor.
const PARCEL_FLAVOR_REGEX = /apn|ain|zoning|overlay|overlays|assessor|parcel/i;

export function wantsParcelLookup(s: string) {
  // Either a recognizable APN signal, parcel-related keywords, or an address
  return !!extractApn(s) || PARCEL_FLAVOR_REGEX.test(s) || looksLikeAddress(s);
}

// Does the message clearly refer to a previously selected ("active") parcel
// without naming an APN/address of its own? e.g. "is it in a fire zone",
// "can I rebuild", "the parcel", "this property".
export function refersToActiveParcel(s: string): boolean {
  return /\b(it|this|the)\s+(parcel|property|lot|house)\b/i.test(s)
    || /\bis\s+it\b/i.test(s)
    || /\bcan\s+i\b/i.test(s)
    || /\brebuild\b/i.test(s)
    || /\bfire\s*zone\b/i.test(s);
}

/**
 * One-line synopsis of the data a prior assistant turn already showed, folded
 * into conversation history so the model has context without the full card text.
 * e.g. "[Data shown: APN 5843004015, Unincorporated LA County, zone R-1-10000,
 * 6 overlays, assessor: built 1948, 1240 sqft]"
 */
export function buildCardSynopsis(cards: ParcelCards): string {
  const parts: string[] = [];
  if (cards.apn) parts.push(`APN ${cards.apn}`);
  if (cards.jurisdiction) parts.push(cards.jurisdiction);

  const zone = cards.zoning?.card?.zone;
  if (zone) parts.push(`zone ${zone}`);

  const overlayItemCount = (cards.overlays?.groups || [])
    .reduce((n, g) => n + (g.items?.length || 0), 0);
  if (overlayItemCount > 0) parts.push(`${overlayItemCount} overlay${overlayItemCount === 1 ? '' : 's'}`);

  const assessor = cards.assessor?.card;
  if (assessor) {
    const bits: string[] = [];
    if (assessor.yearBuilt != null && String(assessor.yearBuilt).trim() !== '') bits.push(`built ${assessor.yearBuilt}`);
    if (assessor.livingArea != null) bits.push(`${assessor.livingArea} sqft`);
    if (bits.length) parts.push(`assessor: ${bits.join(', ')}`);
  }

  return parts.length ? `[Data shown: ${parts.join(', ')}]` : '';
}

export function extractAddress(s: string): string | undefined {
  // Try to extract a street address from the user's input
  // This handles queries like "zoning for 3652 Monterosa Dr Altadena"

  // Common street type suffixes (comprehensive list)
  const streetTypes = '(?:st|street|ave|avenue|blvd|boulevard|dr|drive|ln|lane|rd|road|ct|court|cir|circle|pl|place|ter|terrace|pkwy|parkway|hwy|highway|way|cres|crescent|trl|trail|loop|pass|row|walk|path|xing|crossing|aly|alley|sq|square)';

  // Pattern: street number + street name words + street type + optional city/state/zip
  // Examples: "3652 Monterosa Dr", "3652 Monterosa Drive Altadena", "123 N Main St Los Angeles CA"
  const addressRegex = new RegExp(
    `(\\d{1,5}\\s+` +                           // Street number (1-5 digits)
    `(?:[NSEW]\\.?\\s+)?` +                     // Optional directional (N, S, E, W)
    `[A-Za-z]+(?:\\s+[A-Za-z]+)*\\s+` +         // Street name (one or more words)
    `${streetTypes}\\.?` +                      // Street type
    `(?:\\s+[A-Za-z]+)*` +                      // Optional city name (one or more words)
    `(?:\\s+(?:CA|California))?` +              // Optional state
    `(?:\\s+\\d{5}(?:-\\d{4})?)?)`,             // Optional ZIP
    'i'
  );

  const match = s.match(addressRegex);

  if (match) {
    let extracted = match[1].trim();

    // Clean up: remove any trailing command words that might have been captured
    extracted = extracted
      .replace(/\s+(?:zoning|overlays?|assessor|details?|info|information|data)$/gi, '')
      .trim();

    // Verify we still have something that looks like an address
    if (/^\d{1,5}\s+[a-zA-Z]/.test(extracted)) {
      console.log(`[ADDRESS_EXTRACT] Extracted "${extracted}" from "${s}"`);
      return extracted;
    }
  }

  // Fallback: If no match with street type, try simpler pattern for short inputs
  // This handles cases like "2013 Lemoyne St" entered directly
  if (/^\d{1,5}\s+[A-Za-z]/.test(s.trim()) && s.trim().split(/\s+/).length <= 6) {
    // Short input that starts with street number - probably just an address
    const cleaned = s.trim()
      .replace(/\s+(?:zoning|overlays?|assessor|details?|info)$/gi, '')
      .trim();
    if (/^\d{1,5}\s+[a-zA-Z]/.test(cleaned)) {
      console.log(`[ADDRESS_EXTRACT] Using direct input: "${cleaned}"`);
      return cleaned;
    }
  }

  console.log(`[ADDRESS_EXTRACT] No address found in: "${s}"`);
  return undefined;
}

// Zoning-flavored keywords: development standards, allowed uses, what can be built.
// "rebuild"/"build"/"construct" are deliberately shared with the overlays gate
// too — "what can I rebuild here" should surface both rebuild-critical sections.
const ZONING_TERMS = [
  'zoning', 'zoned?', 'zones?', 'rebuild\\w*', 'build\\w*', 'construct\\w*',
  'setbacks?', 'height\\s*limits?', 'density', 'adu\\b', 'accessory\\s*dwelling',
  'allowed', 'permitt?ed', 'permit(?:s|ting)?\\b', 'lot\\s*coverage', 'land\\s*use',
  'r-?\\d',
];
const ZONING_REGEX = new RegExp(`\\b(?:${ZONING_TERMS.join('|')})`, 'i');
export function wantsZoningSection(q: string): boolean {
  return ZONING_REGEX.test(q);
}

// Overlay/hazard-flavored keywords: environmental and regulatory overlays layered
// on top of base zoning (fire/flood/seismic hazards, coastal, historic, etc.).
// Domain rule: never match bare "fire" — every message in this fire-rebuild app
// mentions fires, so only qualified forms (fire zone, fire hazard, wildfire, ...)
// count as a signal. "rebuild"/"build"/"construct" are shared with the zoning
// gate — see note there.
const OVERLAYS_TERMS = [
  'overlays?', 'hazard(?:s|ous)?', 'fire\\s*(?:zone|hazard|severity|area)s?', 'fhsz',
  'very\\s*high\\s*fire', 'wildfire', 'brush\\s*(?:zone|fire)', 'flood(?:s|ing|plain|way|\\s*zone)?',
  'fema', 'earthquakes?', 'faults?', 'seismic', 'alquist', 'liquefaction',
  'land\\s*slides?', 'landslides?', 'slope\\s*stab\\w*', 'tsunami', 'methane',
  'oil\\s*(?:well|field)s?', 'coastal\\s*(?:zone|commission)?', 'sea\\s*level',
  'airport\\s*(?:influence|noise)', 'historic\\w*', 'hpoz', 'landmark',
  'specific\\s*plan', 'community\\s*standards', 'csd', 'environmentally\\s*sensitive',
  'esa', 'risk[sy]?', 'dangers?', 'safe(?:ty)?', 'rebuild\\w*', 'build\\w*', 'construct\\w*',
];
const OVERLAYS_REGEX = new RegExp(`\\b(?:${OVERLAYS_TERMS.join('|')})`, 'i');
export function wantsOverlaysSection(q: string): boolean {
  return OVERLAYS_REGEX.test(q);
}

// Assessor-flavored keywords: property record data (size, age, value, use).
const ASSESSOR_TERMS = [
  'assessor', 'situs', 'living\\s*area', 'year\\s*built', 'units?\\b', 'bedrooms?',
  'bathrooms?', 'use\\s*(?:type|code)\\b', 'property\\s*use', 'sq\\s*ft', 'square\\s*feet', 'assessed', 'value',
  'valuation', 'worth', 'property\\s*tax(?:es)?', 'lot\\s*size', 'acreage',
  'acres?', 'how\\s*(?:big|large|old)', 'built\\s*(?:in|when)?\\b',
  'when\\s*was\\s*it\\s*built', 'improvements?', 'building\\s*size',
];
const ASSESSOR_REGEX = new RegExp(`\\b(?:${ASSESSOR_TERMS.join('|')})`, 'i');
export function wantsAssessorSection(s: string) {
  const q = s.toLowerCase();
  return ASSESSOR_REGEX.test(q);
}

/* ---------------- Grouped Overlay Formatter ---------------- */

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

  // SEA goes to Environmental Protection
  if (card.program === "SEA" || combined.includes("sea:") || combined.includes("sea ordinance") || combined.includes("significant ecological")) {
    return "Environmental Protection";
  }

  // Phase 7: Coastal Zone goes to Environmental Protection (requires Coastal Commission permits)
  if (combined.includes("coastal zone") || combined.includes("coastal commission") || combined.includes("coastal development")) {
    return "Environmental Protection";
  }

  // Hillside, ridgeline, grading -> Development Regulations
  if (combined.includes("hillside management") || combined.includes("hillside area") ||
      (combined.includes("hma") && !combined.includes("hazard")) ||
      combined.includes("ridgeline") || combined.includes("grading") ||
      (combined.includes("slope") && !combined.includes("landslide"))) {
    return "Development Regulations";
  }

  // Sign districts -> Development Regulations
  if (combined.includes("sign district") || combined.includes("sign_dist")) {
    return "Development Regulations";
  }

  // Community Standards Districts
  if (card.program === "CSD" || combined.includes("csd") || combined.includes("community standards")) {
    return "Community Standards";
  }

  // Hazards - including Phase 7 additions (fault, liquefaction, landslide, tsunami)
  if (combined.includes("fire") || combined.includes("hazard") || combined.includes("flood") ||
      combined.includes("fema") || combined.includes("sfha") || combined.includes("floodplain") ||
      combined.includes("floodway") || combined.includes("evacuation") || combined.includes("evac zone") ||
      combined.includes("ready set go") || combined.includes("landslide") || combined.includes("fault") ||
      combined.includes("liquefaction") || combined.includes("tsunami") || combined.includes("seismic") ||
      combined.includes("alquist-priolo") || combined.includes("inundation")) {
    return "Hazards";
  }

  // Historic Preservation
  if (card.program === "HPOZ" || combined.includes("historic") || combined.includes("hpoz") ||
      combined.includes("landmark") || combined.includes("national register") ||
      combined.includes("monument") || combined.includes("hcm")) {
    return "Historic Preservation";
  }

  // Supplemental Use Districts
  if (card.program === "SUD" || combined.includes("sud") || combined.includes("supplemental use")) {
    return "Supplemental Use Districts";
  }

  // Land Use & Planning
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

const CATEGORY_ORDER: OverlayCategory[] = [
  "Hazards", "Environmental Protection", "Development Regulations",
  "Historic Preservation", "Supplemental Use Districts",
  "Land Use & Planning", "Community Standards", "Additional Overlays",
];

const KEY_CATEGORIES: OverlayCategory[] = ["Hazards", "Historic Preservation", "Land Use & Planning"];

/**
 * Group, noise-filter, clean, and dedup overlay cards into structured groups.
 * This is the single source of truth for overlay presentation; the prompt text
 * is rendered from its output by renderGroupedOverlays.
 */
export function groupOverlays(overlays: OverlayCard[]): OverlayGroupCard[] {
  const buckets: Record<OverlayCategory, OverlayCard[]> = {
    "Hazards": [],
    "Environmental Protection": [],
    "Development Regulations": [],
    "Historic Preservation": [],
    "Supplemental Use Districts": [],
    "Community Standards": [],
    "Land Use & Planning": [],
    "Additional Overlays": [],
  };

  for (const card of overlays || []) {
    if (isNoiseItem(card.name, card.details)) continue;
    buckets[categorizeOverlay(card)].push(card);
  }

  const groups: OverlayGroupCard[] = [];

  for (const category of CATEGORY_ORDER) {
    const items: OverlayGroupItem[] = [];
    const seen = new Set<string>();

    for (const card of buckets[category]) {
      let details: string | undefined;

      if (card.details && card.details !== card.name) {
        let detailsClean = cleanRedundantDescription(card.name, card.details);
        if (detailsClean) {
          const namePattern = new RegExp(`^${escapeRegex(card.name)}\\s*[-—]?\\s*`, 'i');
          detailsClean = detailsClean.replace(namePattern, '').trim();
          if (detailsClean && detailsClean !== '—' && detailsClean.length > 2) {
            details = detailsClean;
          }
        }
      }

      const itemLine = details ? `  • ${card.name} — ${details}` : `  • ${card.name}`;
      const normalized = itemLine.toLowerCase().replace(/\s+/g, " ").trim();
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      items.push({ name: card.name, details, source: card.source, program: card.program });
    }

    groups.push({ category, items });
  }

  return groups;
}

/**
 * Render grouped overlays to the text block used in the LLM prompt.
 * Output is byte-identical to the pre-refactor formatGroupedOverlays.
 */
export function renderGroupedOverlays(groups: OverlayGroupCard[], jurisdiction: string): string {
  const lines: string[] = [];
  lines.push(`JURISDICTION: ${jurisdiction}`);

  for (const group of groups) {
    const isKeyCategory = KEY_CATEGORIES.includes(group.category);

    if (group.items.length === 0 && !isKeyCategory) continue;

    lines.push("");
    lines.push(`${group.category.toUpperCase()}:`);

    if (group.items.length === 0) {
      lines.push(`  • None found for this parcel`);
      continue;
    }

    for (const item of group.items) {
      lines.push(item.details ? `  • ${item.name} — ${item.details}` : `  • ${item.name}`);
    }
  }

  return lines.join("\n");
}

/* ---------------------------- lookup orchestration ---------------------------- */

// Internal statuses used for the [SECTION_STATUS] prompt block. "skipped" is a
// cards-only concept (a section the user didn't ask for), so it's excluded here.
type InternalStatus = Exclude<SectionStatus, "skipped">;

export type ParcelLookupResult = {
  cards: ParcelCards;
  toolContext: string;
  flags: { SHOW_ZONING: boolean; SHOW_OVERLAYS: boolean; SHOW_ASSESSOR: boolean };
  overlayCount: number;
};

export async function runParcelLookup(lastUser: string, log: RequestLogger, activeApn?: string): Promise<ParcelLookupResult> {
  // Determine which sections to show
  const qForIntent = lastUser.toLowerCase();

  // Each section gate is its own broadened keyword regex (see wantsZoningSection/
  // wantsOverlaysSection/wantsAssessorSection above). If none of the three fire,
  // but the message is still a generic parcel lookup (bare APN/address) or a
  // follow-up about the active parcel with no section named, default to the
  // rebuild-critical pair (zoning + overlays) rather than showing nothing.
  let SHOW_ZONING   = wantsZoningSection(qForIntent);
  let SHOW_OVERLAYS = wantsOverlaysSection(qForIntent);
  let SHOW_ASSESSOR = wantsAssessorSection(qForIntent);

  // Generic parcel lookup (bare APN/address) or a follow-up about the active
  // parcel with no specific section named: default to the rebuild-critical pair.
  if (!SHOW_ZONING && !SHOW_OVERLAYS && !SHOW_ASSESSOR &&
      (wantsParcelLookup(qForIntent) || (activeApn && refersToActiveParcel(lastUser)))) {
    SHOW_ZONING = true;
    SHOW_OVERLAYS = true;
  }

  log.log('CHAT', 'Flags determined', { SHOW_ZONING, SHOW_OVERLAYS, SHOW_ASSESSOR });

  // --- live lookups (TOOL OUTPUTS) ---
  let toolContext = "";
  let overlayCount = 0;
  let detectedJurisdiction: string | null = null;

  let zoningStatus: InternalStatus = "no_data";
  let overlaysStatus: InternalStatus = "no_data";
  let assessorStatus: InternalStatus = "no_data";
  let zoningMessage: string | null = null;
  let overlaysMessage: string | null = null;
  let assessorMessage: string | null = null;

  // Structured card data collected alongside the tool context
  let resolvedApn: string | undefined;
  let zoningCard: StandardizedZoningCard | undefined;
  let zoningLinks: Record<string, string | undefined> | undefined;
  let overlayGroups: OverlayGroupCard[] | undefined;
  let overlaysLinks: Record<string, string | undefined> | undefined;
  let assessorCard: AssessorCard | undefined;
  let assessorLinks: Record<string, string | undefined> | undefined;

  // Phase 6B: Track address search results for frontend picker
  let addressSearchResults: AddressSearchResult[] | null = null;
  let resolvedFromAddress: { address: string; apn: string } | null = null;

  try {
    let apn = extractApn(lastUser);
    const address = !apn ? extractAddress(lastUser) : undefined;

    // Active-parcel follow-up: reuse the previously selected APN when the current
    // message names no APN/address of its own but requests a data section ("what
    // year was it built?"), is parcel-flavored, or clearly refers to the active
    // parcel (e.g. "what about the overlays for it?").
    const sectionRequested = SHOW_ZONING || SHOW_OVERLAYS || SHOW_ASSESSOR;
    let reusedActiveParcel = false;
    if (!apn && !address && activeApn &&
        (sectionRequested || PARCEL_FLAVOR_REGEX.test(lastUser) || refersToActiveParcel(lastUser))) {
      apn = activeApn;
      reusedActiveParcel = true;
    }

    // No parcel in play at all (no APN, no address, no active parcel to reuse):
    // this is a general question, so suppress all section cards; the broadened
    // keyword gates must not conjure empty no_data cards without a parcel.
    if (!apn && !address) {
      SHOW_ZONING = false;
      SHOW_OVERLAYS = false;
      SHOW_ASSESSOR = false;
    }

    if (wantsParcelLookup(lastUser) || reusedActiveParcel) {
      if (reusedActiveParcel) {
        toolContext += `\n[TOOL_NOTE] Reusing previously selected parcel APN ${activeApn} from this conversation.`;
        log.log('CHAT', 'Reusing active parcel', { activeApn });
      }

      // ─────────────────────────────────────────────────────────────────────
      // PHASE 6B: ADDRESS-TO-APN LOOKUP
      // ─────────────────────────────────────────────────────────────────────
      if (!apn && address) {
        log.log('ADDRESS_SEARCH', 'Starting address search', { address });

        try {
          const { results, note } = await searchParcelsByAddress(address);

          if (results.length === 0) {
            // No matches found
            zoningStatus = "error";
            overlaysStatus = "error";
            assessorStatus = "error";
            const msg = note || "No parcels found matching that address. Please check the spelling or provide an APN (e.g., 5843-004-015).";
            zoningMessage = msg;
            overlaysMessage = msg;
            assessorMessage = msg;
            toolContext += `\n[TOOL:address_search]\n${JSON.stringify({
              status: "no_matches",
              query: address,
              message: msg,
            }, null, 2)}`;
            log.log('ADDRESS_SEARCH', 'No matches found', { address });

          } else if (results.length === 1) {
            // Single match - use it automatically
            const match = results[0];
            apn = match.ain || match.apn;
            resolvedFromAddress = { address: match.address, apn };

            log.log('ADDRESS_SEARCH', 'Single match found', {
              address: match.address,
              apn,
              city: match.city
            });

            toolContext += `\n[TOOL:address_resolved]\n${JSON.stringify({
              status: "success",
              query: address,
              resolved: {
                address: match.address,
                city: match.city,
                apn: apn,
              }
            }, null, 2)}`;

          } else {
            // Multiple matches - return them for user selection
            addressSearchResults = results;
            zoningStatus = "address_multiple";
            overlaysStatus = "address_multiple";
            assessorStatus = "address_multiple";

            log.log('ADDRESS_SEARCH', 'Multiple matches found', {
              address,
              count: results.length
            });

            toolContext += `\n[TOOL:address_multiple]\n${JSON.stringify({
              status: "multiple_matches",
              query: address,
              count: results.length,
              results: results.map(r => ({
                address: r.address,
                city: r.city,
                zip: r.zip,
                apn: r.ain || r.apn,
              })),
              note: "User must select one of these parcels to continue."
            }, null, 2)}`;
          }
        } catch (e) {
          zoningStatus = "error";
          overlaysStatus = "error";
          assessorStatus = "error";
          // Generic, user-safe copy — never expose the raw error (logged below).
          const msg = "Address search is temporarily unavailable. Please try again in a moment or enter an APN directly (e.g., 5843-004-015).";
          zoningMessage = msg;
          overlaysMessage = msg;
          assessorMessage = msg;
          toolContext += `\n[TOOL_ERROR] Address search failed.`;
          log.error('ADDRESS_SEARCH', 'Search failed', { error: String(e) });
        }
      }

      // ─────────────────────────────────────────────────────────────────────
      // STANDARD APN LOOKUP (also runs if address resolved to single match)
      // ─────────────────────────────────────────────────────────────────────
      if (apn) {
        resolvedApn = apn;
        log.log('CHAT', 'APN extracted', { apn, resolvedFromAddress: !!resolvedFromAddress });

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

                    log.log('ZONING', 'City zoning raw data', {
                      city: cityName,
                      hasData: hasZoningData,
                      fields: hasZoningData ? Object.keys(cityZ.card.raw) : [],
                    });

                    if (hasZoningData) {
                      zoningStatus = "success";

                      const normalized = normalizeZoningData(cityZ.card.raw, detectedJurisdiction!);
                      const formattedZoning = formatZoningForContext(normalized);
                      zoningCard = createZoningCard(normalized);
                      zoningLinks = cityZ.card?.links;

                      toolContext += `\n[TOOL:city_zoning]\n${JSON.stringify({
                        status: "success",
                        formatted: formattedZoning,
                        card: zoningCard,
                      }, null, 2)}`;
                    } else {
                      zoningStatus = "no_data";
                      zoningMessage = `No zoning data found for this parcel in ${cityName}.`;
                      zoningLinks = cityZ?.card?.links;
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

              // Process overlays result - PHASE 7B: Include universal hazards
              if (SHOW_OVERLAYS) {
                // Query universal hazards for ALL jurisdictions (state/federal layers)
                let universalHazards: OverlayCard[] = [];
                try {
                  const hazardResult = await lookupUniversalHazards(centroid, parcel.geometry);
                  universalHazards = hazardResult.overlays || [];
                  if (universalHazards.length > 0) {
                    console.log(`[OVERLAY] Universal hazards for city parcel: ${universalHazards.length} found`);
                  }
                } catch (e) {
                  console.warn("[OVERLAY] Universal hazard query failed:", e);
                }

                if (provider?.method === "arcgis_query" && provider.overlays?.length) {
                  if (overlaysResult.status === "fulfilled" && overlaysResult.value) {
                    const oData = overlaysResult.value as any;
                    // Merge city overlays with universal hazards
                    const cityOverlays: OverlayCard[] = oData.overlays || [];
                    const allOverlays = [...cityOverlays, ...universalHazards];

                    if (allOverlays.length > 0) {
                      overlaysStatus = "success";
                      overlayCount = allOverlays.length;
                      overlayGroups = groupOverlays(allOverlays);
                      const formattedOverlays = renderGroupedOverlays(overlayGroups, detectedJurisdiction!);
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
                    // City overlays failed, but we may still have universal hazards
                    if (universalHazards.length > 0) {
                      overlaysStatus = "success";
                      overlayCount = universalHazards.length;
                      overlayGroups = groupOverlays(universalHazards);
                      const formattedOverlays = renderGroupedOverlays(overlayGroups, detectedJurisdiction!);
                      toolContext += `\n[TOOL:city_overlays]\n${JSON.stringify({
                        status: "success",
                        formatted: formattedOverlays,
                        note: "City-specific overlays unavailable; showing state/county hazard layers only.",
                      }, null, 2)}`;
                    } else {
                      overlaysStatus = "error";
                      overlaysMessage = `Error retrieving overlays.`;
                      toolContext += `\n[TOOL:city_overlays]\n${JSON.stringify({
                        status: "error",
                        jurisdiction: detectedJurisdiction,
                        message: overlaysMessage,
                      }, null, 2)}`;
                    }
                  }
                } else {
                  // Provider not configured, but still show universal hazards if any
                  if (universalHazards.length > 0) {
                    overlaysStatus = "success";
                    overlayCount = universalHazards.length;
                    overlayGroups = groupOverlays(universalHazards);
                    const formattedOverlays = renderGroupedOverlays(overlayGroups, detectedJurisdiction!);
                    toolContext += `\n[TOOL:city_overlays]\n${JSON.stringify({
                      status: "success",
                      formatted: formattedOverlays,
                      note: "City-specific overlays not configured; showing state/county hazard layers.",
                    }, null, 2)}`;
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
              }

              // Process assessor result
              if (SHOW_ASSESSOR) {
                if (assessorResult.status === "fulfilled" && assessorResult.value) {
                  const a = assessorResult.value as any;
                  if (a.ain || a.situs || a.use) {
                    assessorStatus = "success";
                    assessorCard = a as AssessorCard;
                    assessorLinks = a?.links;
                    toolContext += `\n[TOOL:assessor]\n${JSON.stringify({
                      status: "success",
                      ...a
                    }, null, 2)}`;
                  } else {
                    assessorStatus = "no_data";
                    assessorMessage = "No assessor details found.";
                    assessorLinks = a?.links;
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

              // FIX #29: Run ALL county queries in PARALLEL
              const dataTimer = createTimer('county_data_queries');

              const [zRes, aRes, oRes] = await Promise.allSettled([
                SHOW_ZONING   ? lookupZoning(apn, parcel)   : Promise.resolve(null),
                SHOW_ASSESSOR ? lookupAssessor(apn, parcel) : Promise.resolve(null),
                SHOW_OVERLAYS ? lookupOverlays(apn, parcel) : Promise.resolve(null),
              ]);

              dataTimer.stopAndLog(log);

              // Handle zoning result with NORMALIZATION (FIX #32, #33, #34)
              if (SHOW_ZONING) {
                if (zRes.status === "fulfilled" && zRes.value) {
                  const zData = zRes.value as any;
                  if (zData.zoning) {
                    zoningStatus = "success";

                    // FIX: Build raw data object for normalizer (not just the string)
                    const rawZoningData: Record<string, any> = {
                      ZONE: zData.zoning,
                      ...(zData.details || {}),
                    };

                    const normalized = normalizeZoningData(rawZoningData, detectedJurisdiction!);
                    const formattedZoning = formatZoningForContext(normalized);
                    zoningCard = createZoningCard(normalized);
                    zoningLinks = zData.links;

                    toolContext += `\n[TOOL:zoning]\n${JSON.stringify({
                      status: "success",
                      formatted: formattedZoning,
                      card: zoningCard,
                      links: zData.links
                    }, null, 2)}`;
                  } else {
                    zoningStatus = "no_data";
                    zoningMessage = zData.note || "No zoning data found for this parcel.";
                    zoningLinks = zData.links;
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
                    assessorCard = aData as AssessorCard;
                    assessorLinks = aData?.links;
                    toolContext += `\n[TOOL:assessor]\n${JSON.stringify({
                      status: "success",
                      ...aData
                    }, null, 2)}`;
                  } else {
                    assessorStatus = "no_data";
                    assessorMessage = "No assessor details found for this parcel.";
                    assessorLinks = aData?.links;
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
                    overlayGroups = groupOverlays(oData.overlays);
                    overlaysLinks = oData.links;
                    const formattedOverlays = renderGroupedOverlays(overlayGroups, detectedJurisdiction!);
                    toolContext += `\n[TOOL:overlays]\n${JSON.stringify({
                      status: "success",
                      formatted: formattedOverlays,
                      links: oData.links
                    }, null, 2)}`;
                  } else {
                    overlaysStatus = "no_data";
                    overlaysMessage = "No special overlays found for this parcel.";
                    overlaysLinks = oData.links;
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
      } else if (!address) {
        // No APN and no address detected
        toolContext += `\n[TOOL_NOTE] No APN/AIN or address detected in the query.`;
      }
      // Note: if address search returned multiple matches, we already handled it above
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

  // Sections the user didn't ask for are marked not_requested so the model
  // doesn't describe them as missing/unavailable in the narrative.
  const promptStatus = (show: boolean, status: InternalStatus) => (show ? status : "not_requested");

  toolContext += `\n\n[SECTION_STATUS]
ZONING_STATUS: ${promptStatus(SHOW_ZONING, zoningStatus)}${SHOW_ZONING && zoningMessage ? `\nZONING_MESSAGE: ${zoningMessage}` : ''}
OVERLAYS_STATUS: ${promptStatus(SHOW_OVERLAYS, overlaysStatus)}${SHOW_OVERLAYS && overlaysMessage ? `\nOVERLAYS_MESSAGE: ${overlaysMessage}` : ''}
ASSESSOR_STATUS: ${promptStatus(SHOW_ASSESSOR, assessorStatus)}${SHOW_ASSESSOR && assessorMessage ? `\nASSESSOR_MESSAGE: ${assessorMessage}` : ''}`;

  log.log('CHAT', 'Tool context ready', { length: toolContext.length });
  log.benchmark('tool_context_ready');

  // --- assemble structured cards ---
  const isMultiple = !!(addressSearchResults && addressSearchResults.length > 1);

  const cardStatus = (show: boolean, status: InternalStatus): SectionStatus => {
    if (isMultiple) return "address_multiple";
    return show ? status : "skipped";
  };

  const cards: ParcelCards = {
    apn: resolvedApn,
    jurisdiction: detectedJurisdiction ?? undefined,
    resolvedAddress: resolvedFromAddress ?? undefined,
    addressMatches: isMultiple
      ? addressSearchResults!.map(r => ({
          address: r.address,
          city: r.city,
          zip: r.zip,
          apn: r.ain || r.apn,
        }))
      : undefined,
    zoning: {
      status: cardStatus(SHOW_ZONING, zoningStatus),
      message: zoningMessage ?? undefined,
      card: zoningCard,
      links: zoningLinks,
    },
    overlays: {
      status: cardStatus(SHOW_OVERLAYS, overlaysStatus),
      message: overlaysMessage ?? undefined,
      groups: overlayGroups,
      links: overlaysLinks,
    },
    assessor: {
      status: cardStatus(SHOW_ASSESSOR, assessorStatus),
      message: assessorMessage ?? undefined,
      card: assessorCard,
      links: assessorLinks,
    },
  };

  return {
    cards,
    toolContext,
    flags: { SHOW_ZONING, SHOW_OVERLAYS, SHOW_ASSESSOR },
    overlayCount,
  };
}
