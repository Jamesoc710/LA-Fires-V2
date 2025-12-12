// lib/la/fetchers.ts
// Phase 4 Performance Optimizations: Caching, Parallel Queries, Deduplication
import { endpoints } from "./endpoints";
import type { CityProvider, JurisdictionResult } from "./providers";
import { normalizeCityName } from "./providers";
import type { OverlayCard, OverlayProgram } from "./types";
import { 
  parcelCache, 
  jurisdictionCache, 
  zoningCache, 
  overlayCache, 
  assessorCache 
} from "./cache";

/* -------------------------- helpers: http + utils -------------------------- */

const ARCGIS_TIMEOUT_MS = 8000;
const ARCGIS_RETRIES = 2;

// FIX #27: Batch size for parallel overlay queries
const OVERLAY_BATCH_SIZE = 6;

async function esriQuery(url: string, params: Record<string, string>) {
  // Always include f=json
  const bodyParams = new URLSearchParams({ f: "json", ...params });
  const qs = bodyParams.toString();
  const full = `${url}?${qs}`;

  // Use POST for large requests or when geometry exists (safer for polygons)
  const hasGeometry = !!params.geometry;
  const tooLong = full.length > 1800; // many servers fail > ~2k
  const usePost = hasGeometry || tooLong;

  console.log("[ArcGIS] REQUEST", {
    url: url.slice(-60),
    method: usePost ? "POST" : "GET",
    hasGeometry,
    len: full.length,
  });

  for (let attempt = 0; attempt <= ARCGIS_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), ARCGIS_TIMEOUT_MS);

    try {
      const res = await fetch(usePost ? url : `${url}?${qs}`, {
        method: usePost ? "POST" : "GET",
        headers: usePost ? { "content-type": "application/x-www-form-urlencoded" } : undefined,
        body: usePost ? qs : undefined,
        cache: "no-store",
        signal: ctrl.signal as any,
      });
      clearTimeout(to);

      console.log("[ArcGIS] status", res.status);

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`ArcGIS ${res.status} ${res.statusText} :: ${body?.slice(0, 200)}`);
      }
      const json = await res.json();
      if ((json as any)?.error) {
        throw new Error(`ArcGIS error :: ${JSON.stringify((json as any).error).slice(0, 200)}`);
      }
      return json;
    } catch (err) {
      clearTimeout(to);
      if (attempt === ARCGIS_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  throw new Error("esriQuery: exhausted retries");
}

function digitsOnly(id: string) {
  return id.replace(/\D/g, "");
}

function areaOfGeom(geom: any): number | null {
  if (!geom) return null;
  try {
    const rings = geom.rings?.[0];
    if (!Array.isArray(rings) || rings.length < 3) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of rings) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return (maxX - minX) * (maxY - minY);
  } catch {
    return null;
  }
}

function pickLargestFeatureByArea(features: any[] | undefined) {
  if (!features?.length) return undefined;
  let best = features[0];
  let bestArea = areaOfGeom(features[0]?.geometry);
  for (let i = 1; i < features.length; i++) {
    const a = areaOfGeom(features[i]?.geometry);
    if ((a ?? 0) > (bestArea ?? 0)) {
      best = features[i];
      bestArea = a;
    }
  }
  return best;
}

function normalizeApnVariants(id: string) {
  const digits = id.replace(/\D/g, "");
  const dashed =
    digits.length === 10
      ? `${digits.slice(0, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`
      : id;
  return { digits, dashed };
}

function makeEnvelopeFromGeom(geom: any) {
  const rings = geom?.rings?.[0] ?? [];
  if (!rings.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of rings) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return {
    xmin: minX, ymin: minY, xmax: maxX, ymax: maxY,
    spatialReference: { wkid: 102100 },
  };
}

export type ArcgisPoint102100 = {
  x: number;
  y: number;
  spatialReference: { wkid: 102100 };
};

export function makeCentroidFromGeom(geom: any): ArcgisPoint102100 | null {
  const env = makeEnvelopeFromGeom(geom);
  if (!env) return null;
  return {
    x: (env.xmin + env.xmax) / 2,
    y: (env.ymin + env.ymax) / 2,
    spatialReference: { wkid: 102100 as 102100 },
  };
}

function firstFieldValue(a: any, csv?: string) {
  if (!a || !csv) return null;
  for (const k of csv.split(",").map(s => s.trim()).filter(Boolean)) {
    if (k in a && a[k] != null && String(a[k]).trim() !== "") return a[k];
  }
  return null;
}

// WebMercator (EPSG:102100) -> WGS84 (EPSG:4326)
function wmToWgs84(point102100: { x: number; y: number }) {
  const R = 6378137;
  const lon = (point102100.x / R) * 180 / Math.PI;
  const lat = (2 * Math.atan(Math.exp(point102100.y / R)) - Math.PI / 2) * 180 / Math.PI;
  return { x: lon, y: lat, spatialReference: { wkid: 4326 } };
}

/* ========================== ATTRIBUTE SANITIZATION ========================== */

const OVERLAY_FIELD_BLACKLIST = new Set([
  'OBJECTID', 'FID', 'OID', 'GLOBALID', 'GlobalID', 'GDB_GEOMATTR_DATA',
  'SHAPE', 'Shape', 'SHAPE_AREA', 'SHAPE_LEN', 'SHAPE_LENGTH',
  'Shape__Area', 'Shape__Length', 'Shape_Area', 'Shape_Length',
  'shape_area', 'shape_len', 'shape_length', 'SHAPE.AREA', 'SHAPE.LEN',
  'STArea__', 'STLength__',
  'APN', 'AIN', 'PARCEL', 'PARCEL_ID', 'LAND_PARCEL_NUMBER',
  'ADDRESS', 'SITUS', 'CITY', 'STATE', 'ZIP', 'ZIPCODE',
  'SitusAddress', 'SitusCity', 'SitusZIP',
  'SRA', 'INCORP', 'VH_REC',
  'CREATED_DATE', 'LAST_EDITED_DATE', 'CREATED_USER', 'LAST_EDITED_USER',
  'CreationDate', 'EditDate', 'Creator', 'Editor',
  'created_date', 'last_edited_date', 'created_user', 'last_edited_user',
  'LANDMARK_TREE',
]);

/**
 * Fields we actively WANT to show - these provide value to architects/homeowners.
 * Used to prioritize display order when multiple fields exist.
 */
const OVERLAY_FIELD_PRIORITY = [
  // Fire hazard - CRITICAL for rebuild
  'HAZ_CLASS', 'HAZ_CODE', 'FIRE_REVIEW_DISTRICT', 'GENERALIZE',
  
  // Names and labels - primary identifiers
  'NAME', 'TITLE', 'LABEL', 'DISTRICT', 
  'HPOZ_NAME', 'CSD_NAME', 'SEA_NAME', 'CPIO_NAME',
  'PLAN_NAME', 'SPEC_PLAN', 'SPECIFIC_PLAN', 'OVERLAY_NAME', 'SPA_NM',
  
  // Descriptions
  'DESCRIPTIO', 'DESCRIPTION', 'NOTES', 'TYPE', 'CATEGORY',
  'OVERLAY_DESC', 'GEN_PLAN_DESC',
  
  // Plan/designation info - important for understanding development potential
  'GPLU_DESC', 'LU_LABEL', 'LAND_USE', 'GP_DESIG', 'GEN_PLAN_USE_DESCRIPTION',
  'PLAN_LEG', 'PLAN', 'CPA', 'COMM_NAME',
  'LU_TYPE', 'ZONE', 'ZONE_CODE',
  
  // Hillside - important for rebuild constraints
  'STATUS', 'SLOPE', 'HILLSIDE',
  
  // Historic - important for design review requirements
  'HISTORIC_NAME', 'DESIGNATION', 'MONUMENT_TYP', 'DISTRICT_TYPE',
  'NATIONAL_REGISTER_DISTRICT', 'NATIONAL_REGISTER_PROPERTY',
  
  // Administrative
  'ADOPTED', 'EFFECTIVE', 'ORDINANCE',
  
  // SEA (Significant Ecological Area)
  'SEA_TYPE', 'IMPLEMENTATION',
  
  // Flood
  'FLOOD_ZONE', 'FLD_ZONE', 'ZONE_SUBTY',
];

function sanitizeOverlayAttributes(raw: Record<string, any> | null | undefined): Record<string, any> {
  if (!raw) return {};
  const clean: Record<string, any> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (OVERLAY_FIELD_BLACKLIST.has(key)) continue;
    if (OVERLAY_FIELD_BLACKLIST.has(key.toUpperCase())) continue;
    if (value == null || value === '' || value === 'null' || value === 'Null') continue;
    if (typeof value === 'string') {
      const v = value.trim().toLowerCase();
      if (v === 'n/a' || v === 'none' || v === 'unknown' || v === 'n') continue;
    }
    if (typeof value === 'string' && /OBJECTID[:\s]*\d+/i.test(value)) continue;
    if (/_(ID|OID|FID)$/i.test(key)) continue;
    if (/^SHAPE/i.test(key)) continue;
    clean[key] = value;
  }
  return clean;
}

function summarizeOverlayAttrs(a?: Record<string, any> | null, nameCsv?: string, descCsv?: string): string | undefined {
  if (!a) return undefined;
  const pickField = (csv?: string): string | undefined => {
    if (!csv) return undefined;
    for (const k of csv.split(",").map(s => s.trim()).filter(Boolean)) {
      if (k in a && a[k] != null && String(a[k]).trim() !== '') {
        const val = String(a[k]).trim();
        if (/^OBJECTID/i.test(val)) continue;
        if (val.length < 2) continue;
        return val;
      }
    }
    return undefined;
  };
  const name = pickField(nameCsv) ?? pickField("NAME,TITLE,LABEL,DISTRICT,ZONE,PLAN,OVERLAY,CPIO_NAME,HPOZ_NAME,CSD_NAME,SEA_NAME,SPA_NM,SPEC_PLAN,PLAN_NAME");
  const desc = pickField(descCsv) ?? pickField("DESCRIPTIO,DESCRIPTION,NOTES,TYPE,CATEGORY,GPLU_DESC,LU_LABEL");
  if (name && desc && name !== desc) return `${name} — ${desc}`;
  if (name) return name;
  if (desc) return desc;
  return undefined;
}

/* --------------------------- PARCEL (AIN/APN → geom) --------------------------- */
/* FIX #26 & #28: Cached parcel lookup to avoid duplicate fetches */

export async function getParcelByAINorAPN(id: string, skipCache = false): Promise<any | null> {
  const { digits, dashed } = normalizeApnVariants(id);
  const cacheKey = digits;
  
  // FIX #28: Check cache first
  if (!skipCache) {
    const cached = parcelCache.get(cacheKey);
    if (cached) {
      console.log("[CACHE] Parcel HIT:", cacheKey);
      return cached;
    }
  }
  
  console.log("[CACHE] Parcel MISS:", cacheKey);

  const where = [`AIN='${digits}'`, `APN='${digits}'`, `APN='${dashed}'`].join(" OR ");

  if (!endpoints.znetAddressSearch) {
    throw new Error("Missing ZNET_ADDRESS_SEARCH endpoint");
  }
  
  let r: any;
  try {
    r = await esriQuery(endpoints.znetAddressSearch, {
      returnGeometry: "true",
      outSR: "102100",
      where,
      outFields: "AIN,APN,SitusAddress,SitusCity,SitusZIP",
    });
  } catch (e) {
    console.log("[PARCEL] query failed:", String(e));
    return null;
  }

  const feat = pickLargestFeatureByArea(Array.isArray(r?.features) ? r.features : []);
  
  // FIX #28: Store in cache
  if (feat) {
    parcelCache.set(cacheKey, feat);
  }
  
  return feat ?? null;
}

/* -------------------------------------------------------------------------- */
/*                              JURISDICTION LOOKUP                           */
/* -------------------------------------------------------------------------- */

export async function lookupJurisdictionPoint102100(x: number, y: number): Promise<JurisdictionResult> {
  // FIX #28: Cache by rounded coordinates (within ~10m precision)
  const cacheKey = `${Math.round(x / 10) * 10},${Math.round(y / 10) * 10}`;
  
  const cached = jurisdictionCache.get(cacheKey);
  if (cached) {
    console.log("[CACHE] Jurisdiction HIT:", cacheKey);
    return cached;
  }
  
  console.log("[CACHE] Jurisdiction MISS:", cacheKey);

  if (!endpoints.jurisdictionQuery) {
    return { jurisdiction: "Unknown", source: "ERROR", note: "JURISDICTION_QUERY not configured." };
  }

  try {
    const geometry = JSON.stringify({
      x, y,
      spatialReference: { wkid: 102100 }
    });

    const r = await esriQuery(endpoints.jurisdictionQuery, {
      returnGeometry: "false",
      inSR: "102100",
      spatialRel: "esriSpatialRelIntersects",
      geometryType: "esriGeometryPoint",
      geometry,
      outFields: "CITY_NAME,CITY_TYPE,OBJECTID",
    });

    const attrs = r?.features?.[0]?.attributes;
    if (!attrs) {
      const result: JurisdictionResult = {
        jurisdiction: "Unincorporated",
        source: "COUNTY",
        note: "No city boundary match found.",
      };
      jurisdictionCache.set(cacheKey, result);
      return result;
    }

    const name = (attrs.CITY_NAME as string | null) ?? null;
    const type = (attrs.CITY_TYPE as string | null) ?? null;
    const isCity = (type?.toLowerCase() === "city");

    const result: JurisdictionResult = {
      jurisdiction: name ?? "Unincorporated",
      source: isCity ? "CITY" : "COUNTY",
      raw: attrs,
    };
    
    jurisdictionCache.set(cacheKey, result);
    return result;
  } catch (err: any) {
    console.error("[lookupJurisdictionPoint102100] Error:", err);
    return { jurisdiction: "Unknown", source: "ERROR", note: String(err?.message || err) };
  }
}

/* -------------------------------------------------------------------------- */
/*                             CITY ZONING LOOKUP                             */
/* -------------------------------------------------------------------------- */
/* FIX #26: Accept optional parcel data to avoid re-fetching */

export async function lookupCityZoning(
  id: string, 
  provider: CityProvider,
  parcelData?: any  // FIX #26: Optional pre-fetched parcel
) {
  if (provider.method !== "arcgis_query") {
    return { card: { type: "zoning", title: "Zoning (City)", body: "Viewer only.", links: { viewer: provider.viewer } } };
  }

  // FIX #26: Use provided parcel data or fetch if not provided
  const parcel = parcelData ?? await getParcelByAINorAPN(id);
  if (!parcel?.geometry) {
    return { card: { type: "zoning", title: "Zoning (City)", body: "Parcel geometry not found." } };
  }

  const centroid = makeCentroidFromGeom(parcel.geometry);
  if (!centroid) {
    return { card: { type: "zoning", title: "Zoning (City)", body: "Failed to compute centroid." } };
  }

  const r = await esriQuery(provider.zoning.url, {
    returnGeometry: "false",
    inSR: "102100",
    spatialRel: "esriSpatialRelIntersects",
    geometryType: "esriGeometryPoint",
    geometry: JSON.stringify(centroid),
    outFields: provider.zoning.outFields || "*",
  });

  const a = r?.features?.[0]?.attributes ?? null;
  if (!a) {
    return { card: { type: "zoning", title: "Zoning (City)", body: "No zoning feature found.", links: provider.viewer ? { viewer: provider.viewer } : undefined } };
  }

  const name = firstFieldValue(a, provider.zoning.nameFields ?? "ZONE,ZONING,ZONE_CODE");
  const desc = firstFieldValue(a, provider.zoning.descFields ?? "Z_DESC,ZONE_DESC,DESCRIPT");
  const label = name ? (desc ? `${name} — ${desc}` : name) : Object.keys(a).slice(0, 2).map(k => `${k}:${a[k]}`).join(", ");

  const cleanRaw = sanitizeOverlayAttributes(a);

  return {
    card: {
      type: "zoning",
      title: "Zoning (City)",
      body: label || "Zoning attributes found.",
      raw: cleanRaw,
      links: provider.viewer ? { viewer: provider.viewer } : undefined,
    }
  };
}

/* -------------------------------------------------------------------------- */
/*                         CITY OVERLAYS - PARALLEL                           */
/* -------------------------------------------------------------------------- */
/* FIX #27: Parallel overlay queries instead of sequential */

type OverlayBundle = {
  label: string;
  url: string;
  sublayers?: number[];
  outFields?: string;
  nameFields?: string;
  descFields?: string;
};

type OverlayHit = {
  label: string;
  layer?: string;
  attributes: Record<string, any>;
  summary?: string;
};

const OVERLAY_BASE_PARAMS = {
  returnGeometry: "false",
  inSR: "102100",
  spatialRel: "esriSpatialRelIntersects",
};

function enhanceHistoricName(name: string | undefined, layerLabel: string): string {
  if (!name) return "Historic Property";
  const nameLower = name.toLowerCase();
  const labelLower = layerLabel.toLowerCase();
  const wordCount = name.trim().split(/\s+/).length;
  const alreadyDescriptive = 
    nameLower.includes('district') || 
    nameLower.includes('historic') ||
    nameLower.includes('landmark') ||
    nameLower.includes('national register');
  
  if (wordCount <= 2 && !alreadyDescriptive) {
    if (labelLower.includes('historic district') || labelLower.includes('designated historic')) {
      return `${name} Historic District`;
    }
    if (labelLower.includes('landmark district')) {
      return `${name} Landmark District`;
    }
    if (labelLower.includes('landmark building')) {
      return `${name} (Landmark Building)`;
    }
    if (labelLower.includes('national register')) {
      return `${name} (National Register)`;
    }
    if (labelLower.includes('eligible') && labelLower.includes('historic')) {
      return `${name} (Eligible Historic District)`;
    }
  }
  return name;
}

function isGenericHistoricPropertiesHit(rawFeat: Record<string, any>, label: string): boolean {
  const labelLower = label.toLowerCase();
  return labelLower.includes('historic properties') && 
         !rawFeat.HISTORIC_NAME && 
         !rawFeat.NAME && 
         !rawFeat.PROPERTY;
}

/**
 * FIX #27: Execute overlay queries in parallel batches
 */
async function queryOverlayBatch(
  queries: Array<{ url: string; label: string; layer?: string; params: Record<string, string> }>
): Promise<OverlayHit[]> {
  const results: OverlayHit[] = [];
  
  // Execute all queries in parallel
  const promises = queries.map(async (q) => {
    try {
      const r = await esriQuery(q.url, q.params);
      const featCount = r?.features?.length ?? 0;
      const layerInfo = q.layer ? `${q.label}/${q.layer}` : q.label;
      console.log(`[OVERLAY_AUDIT] ${layerInfo}: ${featCount} features returned`);
      
      const feat = r?.features?.[0]?.attributes;
      if (feat) {
        return {
          label: q.label,
          layer: q.layer,
          attributes: feat,
          summary: summarizeOverlayAttrs(feat),
        };
      }
      return null;
    } catch (e) {
      console.log(`[OVERLAY] Query failed ${q.label}/${q.layer || ''}:`, String(e).slice(0, 100));
      return null;
    }
  });
  
  const resolved = await Promise.all(promises);
  
  for (const hit of resolved) {
    if (hit) results.push(hit);
  }
  
  return results;
}

/**
 * FIX #27: Parallel city overlay lookup
 */
export async function lookupCityOverlays(
  centroid102100: ArcgisPoint102100,
  bundles: OverlayBundle[]
): Promise<{ overlays: OverlayCard[]; note?: string; audit?: { layersQueried: number; cardsCreated: number } }> {
  const startTime = Date.now();
  
  // Build all query configs first
  const allQueries: Array<{ url: string; label: string; layer?: string; params: Record<string, string> }> = [];
  
  for (const b of bundles || []) {
    const baseParams = {
      ...OVERLAY_BASE_PARAMS,
      outFields: b.outFields || "*",
      geometryType: "esriGeometryPoint",
      geometry: JSON.stringify(centroid102100),
    };
    
    if (!b.sublayers?.length) {
      // Single layer query
      allQueries.push({ url: b.url, label: b.label, params: baseParams });
    } else {
      // Multiple sublayers
      for (const id of b.sublayers) {
        const layerUrl = `${b.url.replace(/\/+$/,"")}/${id}/query`;
        allQueries.push({ url: layerUrl, label: b.label, layer: String(id), params: baseParams });
      }
    }
  }
  
  console.log(`[OVERLAY] Executing ${allQueries.length} queries in PARALLEL`);
  
  // FIX #27: Execute in batches to avoid overwhelming the server
  const results: OverlayHit[] = [];
  
  for (let i = 0; i < allQueries.length; i += OVERLAY_BATCH_SIZE) {
    const batch = allQueries.slice(i, i + OVERLAY_BATCH_SIZE);
    const batchResults = await queryOverlayBatch(batch);
    results.push(...batchResults);
  }
  
  const queryTime = Date.now() - startTime;
  console.log(`[OVERLAY] All ${allQueries.length} queries complete in ${queryTime}ms (avg ${Math.round(queryTime / allQueries.length)}ms each)`);
  console.log(`[OVERLAY_AUDIT] Total hits before dedup: ${results.length}`);
  
  // Dedupe overlays
  const dedupMap = new Map<string, OverlayHit>();
  for (const o of results) {
    const normSummary = (o.summary ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    const key = `${o.label.toLowerCase()}::${normSummary}`;
    if (!dedupMap.has(key)) {
      dedupMap.set(key, o);
    }
  }
  const dedupedHits = Array.from(dedupMap.values());
  console.log(`[OVERLAY_AUDIT] After dedup: ${dedupedHits.length} unique hits`);

  // Map to OverlayCard with sanitized attributes
  const mapped = dedupedHits.map((hit): OverlayCard | null => {
    const rawFeat = hit.attributes ?? {};
    const feat = sanitizeOverlayAttributes(rawFeat);
    const label = hit.label ?? "";
    const summary = hit.summary ?? undefined;
    const lowerLabel = label.toLowerCase();

    // Skip Zoning Overlays that only have base zoning
    if (label.includes("Zoning Overlays") && 
        !(rawFeat.OVERLAY_DESC || rawFeat.OVERLAY || rawFeat.OVERLAY_NAME || rawFeat.SPECIFICPLAN || rawFeat.SPECIFIC_PLAN || rawFeat.SPEC_PLAN)) {
      return null;
    }

    const base = {
      source: "City" as const,
      name: summary || label,
      details: summary,
      attributes: feat,
    };

    // General Plan Land Use
    if (lowerLabel.includes("general plan land use")) {
      const gpluDesc = rawFeat.GPLU_DESC || rawFeat.LU_LABEL || summary || "General Plan Land Use";
      const parts = [gpluDesc, rawFeat.CPA ? `CPA: ${rawFeat.CPA}` : null].filter(Boolean);
      return { ...base, program: "Other", name: gpluDesc, details: parts.join(" — ") || base.details };
    }

    // Very High Fire Hazard
    if (lowerLabel.includes("very high fire hazard") || lowerLabel.includes("very_high_fire")) {
      let details: string | undefined = undefined;
      if (rawFeat.HAZ_CLASS && rawFeat.HAZ_CLASS !== "Very High") {
        details = rawFeat.HAZ_CLASS;
      } else if (rawFeat.GENERALIZE && !rawFeat.GENERALIZE.toLowerCase().includes('parcel')) {
        details = rawFeat.GENERALIZE;
      }
      return { ...base, program: "Other", name: "Very High Fire Hazard Severity Zone", details };
    }

    // Wildfire Evacuation Zones
    if (lowerLabel.includes("wildfire evacuation")) {
      return { ...base, program: "Other", name: `Wildfire Evacuation Zone: ${rawFeat.ZONE || summary || "Yes"}`, details: rawFeat.DESCRIPTIO || undefined };
    }

    // Hillside areas
    if (lowerLabel.includes("hillside") || rawFeat.STATUS?.includes("Hillside")) {
      return { ...base, program: "Other", name: rawFeat.STATUS || "Hillside Management Area", details: summary };
    }

    // SUD
    if (label.includes("Supplemental Use Districts") || label.includes("SUD")) {
      return { ...base, program: "SUD", name: rawFeat.DISTRICT ?? rawFeat.OVERLAY_NAME ?? base.name };
    }

    // HPOZ
    if (label.includes("Historic Preservation") || label.includes("HPOZ")) {
      return { ...base, program: "HPOZ", name: rawFeat.HPOZ_NAME ?? rawFeat.NAME ?? "Historic Preservation Overlay Zone", details: rawFeat.DESCRIPTIO ?? base.details };
    }

    // Historic Districts
    if (lowerLabel.includes("historic district") || lowerLabel.includes("landmark district")) {
      const rawName = rawFeat.NAME ?? rawFeat.HISTORIC_NAME ?? summary;
      return { ...base, program: "HPOZ", name: enhanceHistoricName(rawName, label), details: rawFeat.DESIGNATION ?? rawFeat.DESCRIPTIO ?? undefined };
    }

    // Landmark Buildings
    if (lowerLabel.includes("landmark building")) {
      const rawName = rawFeat.HISTORIC_NAME ?? rawFeat.NAME ?? summary;
      return { ...base, program: "HPOZ", name: enhanceHistoricName(rawName, label), details: rawFeat.DESIGNATION ?? rawFeat.DESCRIPTIO ?? undefined };
    }

    // Historic Properties
    if (lowerLabel.includes("historic properties")) {
      if (isGenericHistoricPropertiesHit(rawFeat, label)) {
        return { ...base, program: "HPOZ", name: "Listed on Historic Properties Registry", details: rawFeat.DESIGNATION ?? rawFeat.TYPE ?? undefined };
      }
      const rawName = rawFeat.HISTORIC_NAME ?? rawFeat.NAME ?? rawFeat.PROPERTY ?? summary;
      return { ...base, program: "HPOZ", name: enhanceHistoricName(rawName, label), details: rawFeat.DESIGNATION ?? rawFeat.TYPE ?? rawFeat.DESCRIPTIO ?? undefined };
    }

    // Eligible Historic Districts
    if (lowerLabel.includes("eligible") && (lowerLabel.includes("historic") || lowerLabel.includes("landmark"))) {
      const rawName = rawFeat.NAME ?? rawFeat.DISTRICT ?? summary;
      return { ...base, program: "HPOZ", name: enhanceHistoricName(rawName, label), details: rawFeat.STATUS ?? rawFeat.DESCRIPTIO ?? "Eligible but not yet designated" };
    }

    // National Register
    if (lowerLabel.includes("national register")) {
      const rawName = rawFeat.NAME ?? rawFeat.DISTRICT ?? summary;
      return { ...base, program: "HPOZ", name: enhanceHistoricName(rawName, label), details: rawFeat.LISTING ?? rawFeat.DESCRIPTIO ?? undefined };
    }

    // Fire Hazard
    if (lowerLabel.includes("fire") || lowerLabel.includes("hazard")) {
      const hazClass = rawFeat.HAZ_CLASS || rawFeat.FIRE_REVIEW_DISTRICT;
      return { ...base, program: "Other", name: hazClass ? `Fire Hazard: ${hazClass}` : (summary || "Fire Hazard Area"), details: rawFeat.FIRE_REVIEW_DISTRICT || undefined };
    }

    // Specific Plan Areas
    if (lowerLabel.includes("specific plan")) {
      const planName = rawFeat.SPA_NM ?? rawFeat.SPEC_PLAN ?? rawFeat.PLAN_NAME ?? rawFeat.NAME ?? rawFeat.TITLE ?? rawFeat.SpecPlan ?? rawFeat.PlanName ?? rawFeat.SP_NAME ?? rawFeat.SPECIFICPLAN ?? summary ?? null;
      
      // Debug logging to see what fields are available
      console.log("[OVERLAY_AUDIT] Specific Plan raw fields:", Object.keys(rawFeat).join(", "));
      console.log("[OVERLAY_AUDIT] Specific Plan extracted name:", planName);
      
      const displayName = planName ? `Specific Plan: ${planName}` : "Specific Plan Area";
      return { ...base, program: "Other", name: displayName, details: rawFeat.DESCRIPTIO ?? rawFeat.PLAN_TYPE ?? rawFeat.PLAN_AREA ?? undefined };
    }

    return { ...base, program: "Other" };
  });

  const overlays: OverlayCard[] = mapped.filter((card): card is OverlayCard => card !== null);

  console.log(`[OVERLAY_AUDIT] Summary: ${results.length} total hits, ${dedupedHits.length} after dedup, ${overlays.length} cards created from ${allQueries.length} layer queries`);
  console.log(`[OVERLAY_AUDIT] Final overlays array: ${overlays.length} cards`);

  return { 
    overlays,
    audit: { layersQueried: allQueries.length, cardsCreated: overlays.length }
  };
}

/* ------------------------ ZONING (parcel geom → zone) ------------------------ */
/* FIX #26: Accept optional parcel data to avoid re-fetching */

export async function lookupZoning(id: string, parcelData?: any) {
  if (!endpoints.gisnetParcelQuery) {
    throw new Error("Missing GISNET_PARCEL_QUERY endpoint (Preview)");
  }
  console.log("[ZONING] endpoint:", endpoints.gisnetParcelQuery);

  // FIX #26: Use provided parcel data or fetch if not provided
  const parcel = parcelData ?? await getParcelByAINorAPN(id);
  console.log(
    "[ZONING] parcel geometry?",
    !!parcel?.geometry,
    parcel?.geometry ? JSON.stringify(parcel.geometry).length : 0
  );

  if (!parcel?.geometry) {
    return {
      zoning: null,
      details: null,
      links: { znet: endpoints.znetViewer, gisnet: endpoints.gisnetViewer },
      note: "Parcel geometry not found for this APN/AIN.",
    };
  }

  const geom = parcel.geometry;
  const envelope = makeEnvelopeFromGeom(geom);
  const centroid = makeCentroidFromGeom(geom);

  const base = {
    returnGeometry: "false",
    inSR: "102100",
    outFields: "ZONE,Z_DESC,Z_CATEGORY,TITLE_22,PLNG_AREA",
    spatialRel: "esriSpatialRelIntersects",
  };

  // Attempt 1: full polygon
  try {
    const z1 = await esriQuery(endpoints.gisnetParcelQuery, {
      ...base,
      geometry: JSON.stringify(geom),
      geometryType: "esriGeometryPolygon",
      geometryPrecision: "1",
    });
    const a1 = z1.features?.[0]?.attributes ?? null;
    if (a1) {
      return {
        zoning: a1.ZONE ?? null,
        details: {
          description: a1.Z_DESC ?? null,
          category: a1.Z_CATEGORY ?? null,
          planningArea: a1.PLNG_AREA ?? null,
          // FIX #16: Don't include raw TITLE22 code - it's meaningless to users
          // title22: a1.TITLE_22 ?? null,
        },
        links: { znet: endpoints.znetViewer, gisnet: endpoints.gisnetViewer },
        method: "polygon",
      };
    }
  } catch (e) {
    console.log("[ZONING] polygon query failed -> envelope fallback", String(e));
  }

  // Attempt 2: envelope
  if (envelope) {
    try {
      const z2 = await esriQuery(endpoints.gisnetParcelQuery, {
        ...base,
        geometry: JSON.stringify(envelope),
        geometryType: "esriGeometryEnvelope",
      });
      const a2 = z2.features?.[0]?.attributes ?? null;
      if (a2) {
        return {
          zoning: a2.ZONE ?? null,
          details: {
            description: a2.Z_DESC ?? null,
            category: a2.Z_CATEGORY ?? null,
            planningArea: a2.PLNG_AREA ?? null,
          },
          links: { znet: endpoints.znetViewer, gisnet: endpoints.gisnetViewer },
          method: "envelope",
        };
      }
    } catch (e) {
      console.log("[ZONING] envelope query failed -> centroid fallback", String(e));
    }
  }

  // Attempt 3: centroid
  if (centroid) {
    try {
      const z3 = await esriQuery(endpoints.gisnetParcelQuery, {
        ...base,
        geometry: JSON.stringify(centroid),
        geometryType: "esriGeometryPoint",
      });
      const a3 = z3.features?.[0]?.attributes ?? null;
      if (a3) {
        return {
          zoning: a3.ZONE ?? null,
          details: {
            description: a3.Z_DESC ?? null,
            category: a3.Z_CATEGORY ?? null,
            planningArea: a3.PLNG_AREA ?? null,
          },
          links: { znet: endpoints.znetViewer, gisnet: endpoints.gisnetViewer },
          method: "centroid",
        };
      }
    } catch (e) {
      console.log("[ZONING] centroid query failed", String(e));
    }
  }

  return {
    zoning: null,
    details: null,
    links: { znet: endpoints.znetViewer, gisnet: endpoints.gisnetViewer },
    note: "No zoning feature found (polygon/envelope/centroid all failed).",
  };
}

/* ---------------------- COUNTY OVERLAYS - PARALLEL ---------------------- */
/* FIX #27: Parallel overlay lookup for county */

export async function lookupOverlays(
  apn: string,
  parcelData?: any  // FIX #26: Optional pre-fetched parcel
): Promise<{ input: { apn: string }; overlays: OverlayCard[]; note?: string; links?: { znet?: string } }> {
  const startTime = Date.now();
  
  // FIX #26: Use provided parcel data or fetch if not provided
  const parcel = parcelData ?? await getParcelByAINorAPN(apn);
  if (!parcel?.geometry) {
    return {
      input: { apn },
      overlays: [],
      note: "Parcel geometry not found for this APN/AIN.",
    };
  }

  const geom = parcel.geometry;
  const envelope = makeEnvelopeFromGeom(geom);
  const centroid = makeCentroidFromGeom(geom);

  const base = {
    returnGeometry: "false",
    inSR: "102100",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",
  };

  // FIX #27: Build all queries for parallel execution
  const overlayUrls = endpoints.overlayQueries;
  console.log(`[OVERLAY] County: Executing ${overlayUrls.length} queries in PARALLEL`);
  
  const queries = overlayUrls.map(url => ({
    url,
    centroid,
    envelope,
    base,
  }));

  // Execute queries in parallel batches
  const results: OverlayCard[] = [];
  
  for (let i = 0; i < queries.length; i += OVERLAY_BATCH_SIZE) {
    const batch = queries.slice(i, i + OVERLAY_BATCH_SIZE);
    
    const batchPromises = batch.map(async (q) => {
      try {
        let attrs: Record<string, any> | null = null;

        // Try POINT first (fast & tiny)
        if (q.centroid) {
          const r1 = await esriQuery(q.url, {
            ...q.base,
            geometry: JSON.stringify(q.centroid),
            geometryType: "esriGeometryPoint",
          });
          const featCount = r1.features?.length ?? 0;
          console.log(`[OVERLAY_AUDIT] ${q.url.slice(-50)}: ${featCount} features`);
          attrs = r1.features?.[0]?.attributes ?? null;
        }

        // Fallback: ENVELOPE
        if (!attrs && q.envelope) {
          const r2 = await esriQuery(q.url, {
            ...q.base,
            geometry: JSON.stringify(q.envelope),
            geometryType: "esriGeometryEnvelope",
          });
          const featCount = r2.features?.length ?? 0;
          console.log(`[OVERLAY_AUDIT] ${q.url.slice(-50)}: ${featCount} features (envelope)`);
          attrs = r2.features?.[0]?.attributes ?? null;
        }

        if (!attrs) return null;

        const cleanAttrs = sanitizeOverlayAttributes(attrs);

        // Normalize into OverlayCard
        let program: OverlayProgram = "Other";
        if (attrs.CSD_NAME) program = "CSD";

        let name =
          attrs.CSD_NAME ??
          attrs.SEA_NAME ??
          attrs.DISTRICT ??
          attrs.NAME ??
          attrs.TITLE ??
          attrs.STATUS ??
          summarizeCountyOverlay(attrs) ??
          "County overlay";

        let details: string | undefined = undefined;

        if (attrs.Type) {
          details = attrs.Type;
        } else if (attrs.HAZ_CLASS) {
          details = `Fire Hazard Class: ${attrs.HAZ_CLASS}`;
          name = attrs.HAZ_CLASS === "Very High" 
            ? "Very High Fire Hazard Severity Zone" 
            : `Fire Hazard Zone: ${attrs.HAZ_CLASS}`;
          program = "Other";
        } else if (attrs.STATUS?.includes("Hillside")) {
          name = attrs.STATUS;
          program = "Other";
        } else if (attrs.SEA_NAME) {
          name = `SEA: ${attrs.SEA_NAME}`;
          details = attrs.IMPLEMENTATION ?? attrs.SEA_TYPE ?? undefined;
          program = "Other";
        } else if (attrs.FLOOD_ZONE || attrs.FLD_ZONE) {
          name = `Flood Zone: ${attrs.FLOOD_ZONE || attrs.FLD_ZONE}`;
          program = "Other";
        }

        return {
          source: "County" as const,
          program,
          name,
          details,
          attributes: cleanAttrs,
        };
      } catch (e) {
        console.log(`[OVERLAYS] query failed for ${q.url.slice(-50)}`, String(e).slice(0, 100));
        return null;
      }
    });
    
    const batchResults = await Promise.all(batchPromises);
    for (const r of batchResults) {
      if (r) results.push(r);
    }
  }

  const queryTime = Date.now() - startTime;
  console.log(`[OVERLAY] County: ${overlayUrls.length} queries complete in ${queryTime}ms`);

  // Dedupe
  const dedupMap = new Map<string, OverlayCard>();
  for (const card of results) {
    const key = `${card.program}::${card.name.toLowerCase()}`;
    if (!dedupMap.has(key)) {
      dedupMap.set(key, card);
    }
  }

  const finalOverlays = Array.from(dedupMap.values());
  console.log(`[OVERLAY_AUDIT] County summary: ${results.length} hits, ${finalOverlays.length} after dedup from ${overlayUrls.length} endpoints`);

  return {
    input: { apn },
    overlays: finalOverlays,
    links: { znet: endpoints.znetViewer },
  };
}

function summarizeCountyOverlay(a?: Record<string, any> | null): string | undefined {
  if (!a) return undefined;
  const candidates = [
    a.NAME, a.Title, a.TITLE, a.LABEL,
    a.DISTRICT, a.CATEGORY, a.TYPE,
    a.PLAN_NAME, a.PLAN, a.CSD_NAME,
    a.SEA_NAME, a.STATUS,
    a.ZONE, a.ZONING,
  ].filter(v => {
    if (!v) return false;
    const s = String(v);
    if (/^OBJECTID/i.test(s)) return false;
    if (s.length < 2) return false;
    return true;
  });
  if (candidates.length) return String(candidates[0]);
  return undefined;
}

/* ---------------------- ASSESSOR (AIN/APN → attributes) ---------------------- */
/* FIX #26: Accept optional parcel data to avoid re-fetching */

export async function lookupAssessor(id: string, parcelData?: any) {
  const { digits, dashed } = normalizeApnVariants(id);

  if (!endpoints.assessorParcelQuery) {
    return { links: { assessor: endpoints.assessorViewerForAIN(digits) } };
  }

  const where = [`AIN='${digits}'`, `APN='${digits}'`, `APN='${dashed}'`].join(" OR ");

  let r: any;
  try {
    r = await esriQuery(endpoints.assessorParcelQuery, {
      returnGeometry: "true",  // FIX #6: Request geometry to compute area as fallback
      where,
      outFields: "*",
    });
  } catch (e) {
    console.log("[ASSESSOR] hard fail -> returning portal link:", String(e));
    return {
      links: { assessor: endpoints.assessorViewerForAIN(digits) },
      note: "Assessor API returned an error; providing official portal link.",
    };
  }

  const feature = r?.features?.[0];
  const a = feature?.attributes;
  if (!a) {
    return { links: { assessor: endpoints.assessorViewerForAIN(digits) } };
  }

  // FIX #6: Log all available field names for debugging
  console.log("[ASSESSOR] Available fields:", Object.keys(a).join(", "));

  const get = (k: string) => (k in a ? a[k] : null);

  const ain = get("AIN") ?? null;
  const apn = get("APN") ?? null;
  const situs = get("SitusAddress") ?? null;
  const city = get("SitusCity") ?? null;
  const zip = get("SitusZIP") ?? null;
  const use = get("UseDescription") ?? get("UseType") ?? get("UseCode") ?? null;

  const maybeNums = (...keys: string[]) =>
    keys.map(k => Number(get(k)) || 0).reduce((s, n) => s + n, 0) || null;

  const livingArea = maybeNums("SQFTmain1", "SQFTmain2", "SQFTmain3", "SQFTmain4");

  const yearBuiltVals = ["YearBuilt1", "YearBuilt2", "YearBuilt3", "YearBuilt4"]
    .map(k => parseInt(get(k), 10))
    .filter(n => !Number.isNaN(n));
  const yearBuilt = yearBuiltVals.length ? Math.min(...yearBuiltVals) : null;


  const lotSizeFieldNames = [
    // Direct lot size fields (preferred - already in sq ft)
    "LotArea", "LOT_AREA", "LOT_SQFT", "LotSqFt", "LOTSQFT",
    "LandArea", "LAND_AREA", "LandSqFt", "LAND_SQFT",
    "LotSize", "LOT_SIZE", "ParcelArea", "PARCEL_AREA",
    "SqFtLand", "SQFT_LAND", "LotSquareFeet", "LOT_SQUARE_FEET",
    // Geometry area fields (need conversion from sq meters to sq ft)
    "Shape.STArea()",  // <-- KEY FIX: exact field name from LA County Assessor layer
    "Shape.STArea",
    "Shape_Area", "SHAPE_AREA", "Shape__Area", "ShapeArea",
    "STArea", "STAREA",
  ];
  
  let lotSqft: number | null = null;
  for (const fieldName of lotSizeFieldNames) {
    const val = Number(get(fieldName));
    if (val && val > 0) {
      // Check if this is a geometry-derived field (needs conversion from sq meters)
      const isShapeField = fieldName.toLowerCase().includes("shape") || 
                           fieldName.toLowerCase().includes("starea") ||
                           fieldName.includes("STArea");
      
      if (isShapeField) {
        // Web Mercator (EPSG:102100) returns area in square meters
        // Convert to square feet: 1 sq m = 10.7639 sq ft
        if (val > 0 && val < 1000000) {
          lotSqft = Math.round(val * 10.7639);
          console.log(`[ASSESSOR] LOT SIZE: Using ${fieldName} → ${val.toLocaleString()} sq m → ${lotSqft.toLocaleString()} sq ft`);
        } else {
          console.log(`[ASSESSOR] LOT SIZE: Skipping ${fieldName} - value ${val} out of expected range`);
        }
      } else {
        // Direct lot size field - assume already in sq ft
        lotSqft = Math.round(val);
        console.log(`[ASSESSOR] LOT SIZE: Found in ${fieldName}: ${lotSqft.toLocaleString()} sq ft`);
      }
      
      if (lotSqft !== null) break;
    }
  }
  
  // Debug: log if no lot size found
  if (lotSqft === null) {
    const areaFields = Object.keys(a).filter(k => 
      k.toLowerCase().includes('area') || 
      k.toLowerCase().includes('sqft') || 
      k.toLowerCase().includes('shape') ||
      k.includes('STArea')
    );
    console.log("[ASSESSOR] LOT SIZE: Not found. Potential fields:", areaFields.join(", ") || "(none)");
  }

  const units =
    ["Units1", "Units2", "Units3", "Units4"]
      .map(k => Number(get(k)) || 0)
      .reduce((s, n) => s + n, 0) || null;

  return {
    ain, apn, situs, city, zip,
    use,
    livingArea,
    yearBuilt,
    lotSqft,
    units,
    bedrooms: get("Bedrooms1"),
    bathrooms: get("Bathrooms1"),
    links: { assessor: endpoints.assessorViewerForAIN((ain ?? digits).toString()) },
  };
}
