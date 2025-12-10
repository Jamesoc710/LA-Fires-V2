// lib/la/fetchers.ts
import { endpoints } from "./endpoints";
import type { CityProvider, JurisdictionResult } from "./providers";
import { normalizeCityName } from "./providers";
import type { OverlayCard, OverlayProgram } from "./types";

/* -------------------------- helpers: http + utils -------------------------- */

const ARCGIS_TIMEOUT_MS = 8000;
const ARCGIS_RETRIES = 2;

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
    url,
    method: usePost ? "POST" : "GET",
    hasGeometry,
    len: full.length,
    keys: Object.keys(params),
  });

  for (let attempt = 0; attempt <= ARCGIS_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), ARCGIS_TIMEOUT_MS);

    try {
      const res = await fetch(usePost ? url : `${url}?${qs}`, {
        method: usePost ? "POST" : "GET",
        // ArcGIS expects form-encoded on POST
        headers: usePost ? { "content-type": "application/x-www-form-urlencoded" } : undefined,
        body: usePost ? qs : undefined,
        cache: "no-store",
        signal: ctrl.signal as any,
      });
      clearTimeout(to);

      console.log("[ArcGIS] status", res.status, res.statusText);

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`ArcGIS ${res.status} ${res.statusText} :: ${body?.slice(0, 200)}`);
      }
      const json = await res.json();
      // ArcGIS sometimes returns 200 with an error object
      if ((json as any)?.error) {
        throw new Error(`ArcGIS error :: ${JSON.stringify((json as any).error).slice(0, 200)}`);
      }
      return json;
    } catch (err) {
      clearTimeout(to);
      if (attempt === ARCGIS_RETRIES) throw err;
      // small jitter before retry
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
    // polygon rings: [[x,y], ...]
    const rings = geom.rings?.[0];
    if (!Array.isArray(rings) || rings.length < 3) return null;
    // rough bbox area
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
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
  // area in WebMercator (outSR=102100) -> approximate by ring bbox area
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
  const digits = id.replace(/\D/g, "");                                // 5843004015
  const dashed =
    digits.length === 10
      ? `${digits.slice(0, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`
      : id;                                                             // fallback
  return { digits, dashed };
}

function makeEnvelopeFromGeom(geom: any) {
  const rings = geom?.rings?.[0] ?? [];
  if (!rings.length) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of rings) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return {
    xmin: minX,
    ymin: minY,
    xmax: maxX,
    ymax: maxY,
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
    spatialReference: { wkid: 102100 as 102100 }, // 👈 literal type
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

/**
 * Fields that should NEVER appear in overlay output.
 * These are technical/internal fields that confuse end users.
 */
const OVERLAY_FIELD_BLACKLIST = new Set([
  // Internal IDs - never useful to end users
  'OBJECTID', 'FID', 'OID', 'GLOBALID', 'GlobalID', 'GDB_GEOMATTR_DATA',
  
  // Geometry fields - technical noise
  'SHAPE', 'Shape', 'SHAPE_AREA', 'SHAPE_LEN', 'SHAPE_LENGTH',
  'Shape__Area', 'Shape__Length', 'Shape_Area', 'Shape_Length',
  'shape_area', 'shape_len', 'shape_length', 'SHAPE.AREA', 'SHAPE.LEN',
  'STArea__', 'STLength__',
  
  // Parcel identifiers - belong in Assessor section, not overlays
  'APN', 'AIN', 'PARCEL', 'PARCEL_ID', 'LAND_PARCEL_NUMBER',
  
  // Address fields - belong in Assessor section
  'ADDRESS', 'SITUS', 'CITY', 'STATE', 'ZIP', 'ZIPCODE',
  'SitusAddress', 'SitusCity', 'SitusZIP',
  
  // Firefighting jurisdiction codes - not relevant to building/rebuild
  'SRA',      // State Responsibility Area (who fights fires, not building codes)
  'INCORP',   // Incorporated status (already shown as jurisdiction)
  'VH_REC',   // Internal recommendation field
  
  // Creation/edit metadata - never useful
  'CREATED_DATE', 'LAST_EDITED_DATE', 'CREATED_USER', 'LAST_EDITED_USER',
  'CreationDate', 'EditDate', 'Creator', 'Editor',
  'created_date', 'last_edited_date', 'created_user', 'last_edited_user',
  
  // Landmark tree (very niche, usually N)
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
  'PLAN_NAME', 'SPEC_PLAN', 'SPECIFIC_PLAN', 'OVERLAY_NAME',
  
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

/**
 * Sanitize overlay attributes: remove technical junk, keep useful fields.
 * Returns a clean object suitable for display to end users.
 */
function sanitizeOverlayAttributes(
  raw: Record<string, any> | null | undefined
): Record<string, any> {
  if (!raw) return {};

  const clean: Record<string, any> = {};

  for (const [key, value] of Object.entries(raw)) {
    // Skip blacklisted fields (case-sensitive match first)
    if (OVERLAY_FIELD_BLACKLIST.has(key)) continue;
    
    // Also check uppercase version for case-insensitive blacklist
    if (OVERLAY_FIELD_BLACKLIST.has(key.toUpperCase())) continue;

    // Skip null/undefined/empty values
    if (value == null || value === '' || value === 'null' || value === 'Null') continue;
    
    // Skip "N/A", "None", "Unknown" type values that add no info
    if (typeof value === 'string') {
      const v = value.trim().toLowerCase();
      if (v === 'n/a' || v === 'none' || v === 'unknown' || v === 'n') continue;
    }

    // Skip fields that contain OBJECTID in their VALUE (e.g., "OBJECTID:1207, SRA:LRA")
    if (typeof value === 'string' && /OBJECTID[:\s]*\d+/i.test(value)) continue;

    // Skip fields ending in _ID, _OID, _FID (likely foreign keys)
    if (/_(ID|OID|FID)$/i.test(key)) continue;
    
    // Skip fields starting with SHAPE (catch any we missed)
    if (/^SHAPE/i.test(key)) continue;

    // Include the field
    clean[key] = value;
  }

  return clean;
}

/**
 * Create a human-readable summary from overlay attributes.
 * Tries known field names in priority order.
 */
function summarizeOverlayAttrs(
  a?: Record<string, any> | null, 
  nameCsv?: string, 
  descCsv?: string
): string | undefined {
  if (!a) return undefined;
  
  // Helper to pick first non-empty value from comma-separated field list
  const pickField = (csv?: string): string | undefined => {
    if (!csv) return undefined;
    for (const k of csv.split(",").map(s => s.trim()).filter(Boolean)) {
      if (k in a && a[k] != null && String(a[k]).trim() !== '') {
        const val = String(a[k]).trim();
        // Skip values that are just IDs or technical codes
        if (/^OBJECTID/i.test(val)) continue;
        if (val.length < 2) continue; // Skip single chars like "Y", "N"
        return val;
      }
    }
    return undefined;
  };

  // Try provided field lists first
  const name = pickField(nameCsv) ??
               pickField("NAME,TITLE,LABEL,DISTRICT,ZONE,PLAN,OVERLAY,CPIO_NAME,HPOZ_NAME,CSD_NAME,SEA_NAME");
  const desc = pickField(descCsv) ??
               pickField("DESCRIPTIO,DESCRIPTION,NOTES,TYPE,CATEGORY,GPLU_DESC,LU_LABEL");
               
  if (name && desc && name !== desc) return `${name} — ${desc}`;
  if (name) return name;
  if (desc) return desc;
  
  return undefined;
}

/* --------------------------- PARCEL (AIN/APN → geom) --------------------------- */

export async function getParcelByAINorAPN(id: string) {
  const { digits, dashed } = normalizeApnVariants(id);

  // NOTE: no SQL functions; many LA layers disallow them
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
  return feat ?? null;
}

/* -------------------------------------------------------------------------- */
/*                              JURISDICTION LOOKUP                           */
/* -------------------------------------------------------------------------- */

/** Query DPW City Boundaries by a point in Web Mercator (wkid 102100). */
export async function lookupJurisdictionPoint102100(x: number, y: number): Promise<JurisdictionResult> {
  if (!endpoints.jurisdictionQuery) {
    return { jurisdiction: "Unknown", source: "ERROR", note: "JURISDICTION_QUERY not configured." };
  }

  try {
    const geometry = JSON.stringify({
      x, y,
      spatialReference: { wkid: 102100 }
    });

    // Ask for the fields that actually exist on the layer
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
      return {
        jurisdiction: "Unincorporated",
        source: "COUNTY",
        note: "No city boundary match found.",
      };
    }

    // Normalize name and unincorporated flag
    const name = (attrs.CITY_NAME as string | null) ?? null;
    const type = (attrs.CITY_TYPE as string | null) ?? null;
    const isCity = (type?.toLowerCase() === "city");

    return {
      jurisdiction: name ?? "Unincorporated",
      source: isCity ? "CITY" : "COUNTY",
      raw: attrs,
    };
  } catch (err: any) {
    console.error("[lookupJurisdictionPoint102100] Error:", err);
    return { jurisdiction: "Unknown", source: "ERROR", note: String(err?.message || err) };
  }
}

export async function lookupCityZoning(id: string, provider: CityProvider) {
  if (provider.method !== "arcgis_query") {
    return { card: { type: "zoning", title: "Zoning (City)", body: "Viewer only.", links: { viewer: provider.viewer } } };
  }

  const parcel = await getParcelByAINorAPN(id);
  if (!parcel?.geometry) return { card: { type: "zoning", title: "Zoning (City)", body: "Parcel geometry not found." } };

  const centroid = makeCentroidFromGeom(parcel.geometry);
  if (!centroid) return { card: { type: "zoning", title: "Zoning (City)", body: "Failed to compute centroid." } };

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

  // Sanitize raw attributes to remove OBJECTID, SHAPE*, etc.
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

// ----------------------------- CITY OVERLAYS -----------------------------

type OverlayBundle = {
  label: string;
  url: string;            // FeatureServer root OR .../{layerId}/query
  sublayers?: number[];   // when present, loop these ids -> .../{id}/query
  outFields?: string;
  nameFields?: string;    // CSV: "NAME,TITLE,..."
  descFields?: string;    // CSV: "DESCRIPTIO,TYPE,..."
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

// FIX #17: Helper to add context to bare historic names
function enhanceHistoricName(name: string | undefined, layerLabel: string): string {
  if (!name) return "Historic Property";
  
  const nameLower = name.toLowerCase();
  const labelLower = layerLabel.toLowerCase();
  
  // If name is very short (1-2 words) and doesn't already include "district" or "historic"
  const wordCount = name.trim().split(/\s+/).length;
  const alreadyDescriptive = 
    nameLower.includes('district') || 
    nameLower.includes('historic') ||
    nameLower.includes('landmark') ||
    nameLower.includes('national register');
  
  if (wordCount <= 2 && !alreadyDescriptive) {
    // Add context based on the layer type
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

// FIX #17: Check if this is a generic "Historic Properties" designation
function isGenericHistoricPropertiesHit(rawFeat: Record<string, any>, label: string): boolean {
  // The layer might just be telling us the parcel IS on the historic properties list
  // without a specific property name
  const labelLower = label.toLowerCase();
  return labelLower.includes('historic properties') && 
         !rawFeat.HISTORIC_NAME && 
         !rawFeat.NAME && 
         !rawFeat.PROPERTY;
}

/** Query city overlays at a parcel centroid (102100). */
export async function lookupCityOverlays(
  centroid102100: ArcgisPoint102100,
  bundles: OverlayBundle[]
): Promise<{ overlays: OverlayCard[]; note?: string }> {
  const results: OverlayHit[] = [];

  for (const b of bundles || []) {
    try {
      // Case A: explicit .../0/query style (HPOZ or single-layer URLs)
      if (!b.sublayers?.length) {
        const r = await esriQuery(b.url, {
          ...OVERLAY_BASE_PARAMS,
          outFields: b.outFields || "*",
          geometryType: "esriGeometryPoint",
          geometry: JSON.stringify(centroid102100),
        });
        const feat = r?.features?.[0]?.attributes;
        if (feat) {
          results.push({
            label: b.label,
            attributes: feat,
            summary: summarizeOverlayAttrs(feat, b.nameFields, b.descFields),
          });
        }
        continue;
      }

      // Case B: FeatureServer root + sublayer IDs (SUD bundle, Pasadena bundles, etc.)
      for (const id of b.sublayers) {
        const layerUrl = `${b.url.replace(/\/+$/,"")}/${id}/query`;
        const r = await esriQuery(layerUrl, {
          ...OVERLAY_BASE_PARAMS,
          outFields: b.outFields || "*",
          geometryType: "esriGeometryPoint",
          geometry: JSON.stringify(centroid102100),
        });
        const feat = r?.features?.[0]?.attributes;
        if (feat) {
          results.push({
            label: b.label,
            layer: String(id),
            attributes: feat,
            summary: summarizeOverlayAttrs(feat, b.nameFields, b.descFields),
          });
        }
      }
    } catch (e) {
      console.log("[OVERLAYS] bundle error:", b.label, String(e));
    }
  }

  // ─────────────────────────────────────────────
  // Dedupe overlays so "SUD: Downtown" only shows once
  // Use a smarter key that normalizes summaries
  // ─────────────────────────────────────────────
  const dedupMap = new Map<string, OverlayHit>();

  for (const o of results) {
    // Normalize summary for dedup (lowercase, trim, remove extra spaces)
    const normSummary = (o.summary ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    const key = `${o.label.toLowerCase()}::${normSummary}`;
    
    if (!dedupMap.has(key)) {
      dedupMap.set(key, o);
    }
  }

  const dedupedHits = Array.from(dedupMap.values());

  // Map to OverlayCard with sanitized attributes
  const mapped = dedupedHits.map((hit): OverlayCard | null => {
    const rawFeat = hit.attributes ?? {};
    const feat = sanitizeOverlayAttributes(rawFeat); // ← SANITIZED
    const label = hit.label ?? "";
    const summary = hit.summary ?? undefined;
    const lowerLabel = label.toLowerCase();

    // For Pasadena "Zoning Overlays" layer, skip entries that only contain base zoning
    if (
      label.includes("Zoning Overlays") &&
      !(
        rawFeat.OVERLAY_DESC ||
        rawFeat.OVERLAY ||
        rawFeat.OVERLAY_NAME ||
        rawFeat.SPECIFICPLAN ||
        rawFeat.SPECIFIC_PLAN ||
        rawFeat.SPEC_PLAN
      )
    ) {
      // No real overlay info, just base zone -> don't create a card
      return null;
    }

    // Default values shared across programs
    const base = {
      source: "City" as const,
      name: summary || label,
      details: summary,
      attributes: feat, // ← Now sanitized
    };

    // ─────────────────────────────────────────────
    // LA-specific niceties for non-SUD / non-HPOZ overlays
    // ─────────────────────────────────────────────

    // General Plan Land Use (LA City)
    if (lowerLabel.includes("general plan land use")) {
      const gpluDesc =
        rawFeat.GPLU_DESC ||
        rawFeat.LU_LABEL ||
        summary ||
        "General Plan Land Use";

      const parts = [
        gpluDesc,
        rawFeat.CPA ? `CPA: ${rawFeat.CPA}` : null,
      ].filter(Boolean);

      return {
        ...base,
        program: "Other",
        name: gpluDesc,
        details: parts.join(" — ") || base.details,
      };
    }

    // FIX #15: Very High Fire Hazard Severity Zones (LA City) - remove redundant description
    if (
      lowerLabel.includes("very high fire hazard") ||
      lowerLabel.includes("very_high_fire")
    ) {
      const name = "Very High Fire Hazard Severity Zone";
      
      // FIX #15: Don't include redundant "Parcel is inside..." text
      // Only include HAZ_CLASS or GENERALIZE if they add new information
      let details: string | undefined = undefined;
      if (rawFeat.HAZ_CLASS && rawFeat.HAZ_CLASS !== "Very High") {
        details = rawFeat.HAZ_CLASS;
      } else if (rawFeat.GENERALIZE && !rawFeat.GENERALIZE.toLowerCase().includes('parcel')) {
        details = rawFeat.GENERALIZE;
      }
      // Otherwise, no details needed - the name is self-explanatory

      return {
        ...base,
        program: "Other",
        name,
        details,
      };
    }

    // Wildfire Evacuation Zones
    if (lowerLabel.includes("wildfire evacuation")) {
      return {
        ...base,
        program: "Other",
        name: `Wildfire Evacuation Zone: ${rawFeat.ZONE || summary || "Yes"}`,
        details: rawFeat.DESCRIPTIO || undefined,
      };
    }

    // Hillside areas
    if (lowerLabel.includes("hillside") || rawFeat.STATUS?.includes("Hillside")) {
      return {
        ...base,
        program: "Other",
        name: rawFeat.STATUS || "Hillside Management Area",
        details: summary,
      };
    }

    // ─────────────────────────────────────────────
    // SUD / HPOZ classification
    // ─────────────────────────────────────────────

    if (label.includes("Supplemental Use Districts") || label.includes("SUD")) {
      return {
        ...base,
        program: "SUD",
        name: rawFeat.DISTRICT ?? rawFeat.OVERLAY_NAME ?? base.name,
      };
    }

    if (label.includes("Historic Preservation") || label.includes("HPOZ")) {
      return {
        ...base,
        program: "HPOZ",
        name: rawFeat.HPOZ_NAME ?? rawFeat.NAME ?? "Historic Preservation Overlay Zone",
        details: rawFeat.DESCRIPTIO ?? base.details,
      };
    }

    // FIX #17: Historic Districts (Pasadena) - add context to bare names
    if (lowerLabel.includes("historic district") || lowerLabel.includes("landmark district")) {
      const rawName = rawFeat.NAME ?? rawFeat.HISTORIC_NAME ?? summary;
      const enhancedName = enhanceHistoricName(rawName, label);
      
      return {
        ...base,
        program: "HPOZ",
        name: enhancedName,
        details: rawFeat.DESIGNATION ?? rawFeat.DESCRIPTIO ?? undefined,
      };
    }

    // FIX #17: Landmark Buildings
    if (lowerLabel.includes("landmark building")) {
      const rawName = rawFeat.HISTORIC_NAME ?? rawFeat.NAME ?? summary;
      const enhancedName = enhanceHistoricName(rawName, label);
      
      return {
        ...base,
        program: "HPOZ",
        name: enhancedName,
        details: rawFeat.DESIGNATION ?? rawFeat.DESCRIPTIO ?? undefined,
      };
    }

    // FIX #17: Historic Properties (Pasadena) - handle generic hits
    if (lowerLabel.includes("historic properties")) {
      if (isGenericHistoricPropertiesHit(rawFeat, label)) {
        // This is just a flag that the parcel is on the historic properties list
        return {
          ...base,
          program: "HPOZ",
          name: "Listed on Historic Properties Registry",
          details: rawFeat.DESIGNATION ?? rawFeat.TYPE ?? undefined,
        };
      }
      
      // Has a specific property name
      const rawName = rawFeat.HISTORIC_NAME ?? rawFeat.NAME ?? rawFeat.PROPERTY ?? summary;
      const enhancedName = enhanceHistoricName(rawName, label);
      
      return {
        ...base,
        program: "HPOZ",
        name: enhancedName,
        details: rawFeat.DESIGNATION ?? rawFeat.TYPE ?? rawFeat.DESCRIPTIO ?? undefined,
      };
    }

    // FIX #17: Eligible Historic Districts
    if (lowerLabel.includes("eligible") && (lowerLabel.includes("historic") || lowerLabel.includes("landmark"))) {
      const rawName = rawFeat.NAME ?? rawFeat.DISTRICT ?? summary;
      const enhancedName = enhanceHistoricName(rawName, label);
      
      return {
        ...base,
        program: "HPOZ",
        name: enhancedName,
        details: rawFeat.STATUS ?? rawFeat.DESCRIPTIO ?? "Eligible but not yet designated",
      };
    }

    // National Register
    if (lowerLabel.includes("national register")) {
      const rawName = rawFeat.NAME ?? rawFeat.DISTRICT ?? summary;
      const enhancedName = enhanceHistoricName(rawName, label);
      
      return {
        ...base,
        program: "HPOZ",
        name: enhancedName,
        details: rawFeat.LISTING ?? rawFeat.DESCRIPTIO ?? undefined,
      };
    }

    // Fire Hazard (Pasadena / generic)
    if (lowerLabel.includes("fire") || lowerLabel.includes("hazard")) {
      const hazClass = rawFeat.HAZ_CLASS || rawFeat.FIRE_REVIEW_DISTRICT;
      return {
        ...base,
        program: "Other",
        name: hazClass ? `Fire Hazard: ${hazClass}` : (summary || "Fire Hazard Area"),
        details: rawFeat.FIRE_REVIEW_DISTRICT || undefined,
      };
    }

    // Specific Plan Areas
    if (lowerLabel.includes("specific plan")) {
      // Try multiple field name variations (LA City uses different field names)
      const planName = 
        rawFeat.SPEC_PLAN ?? 
        rawFeat.PLAN_NAME ?? 
        rawFeat.NAME ?? 
        rawFeat.TITLE ??
        rawFeat.SpecPlan ??
        rawFeat.PlanName ??
        rawFeat.SP_NAME ??
        rawFeat.SPECIFICPLAN ??
        summary ??  // Use the computed summary as fallback
        null;
      
      // Debug logging to see what fields are available
      console.log("[OVERLAY_AUDIT] Specific Plan raw fields:", Object.keys(rawFeat).join(", "));
      console.log("[OVERLAY_AUDIT] Specific Plan field values:", {
        SPEC_PLAN: rawFeat.SPEC_PLAN,
        PLAN_NAME: rawFeat.PLAN_NAME,
        NAME: rawFeat.NAME,
        TITLE: rawFeat.TITLE,
        summary,
      });
      
      const displayName = planName 
        ? `Specific Plan: ${planName}`
        : "Specific Plan Area";
      
      return {
        ...base,
        program: "Other",
        name: displayName,
        details: rawFeat.DESCRIPTIO ?? rawFeat.PLAN_TYPE ?? rawFeat.PLAN_AREA ?? undefined,
      };
    }

    // Fallback for other city overlays
    return {
      ...base,
      program: "Other",
    };
  });

  // Filter out nulls
  const overlays: OverlayCard[] = mapped.filter(
    (card): card is OverlayCard => card !== null
  );

  return { overlays };
}


/* ------------------------ ZONING (parcel geom → zone) ------------------------ */

export async function lookupZoning(id: string) {
  if (!endpoints.gisnetParcelQuery) {
    throw new Error("Missing GISNET_PARCEL_QUERY endpoint (Preview)");
  }
  console.log("[ZONING] endpoint:", endpoints.gisnetParcelQuery);

  const parcel = await getParcelByAINorAPN(id);
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

  // Common params
  const base = {
    returnGeometry: "false",
    inSR: "102100",
    outFields: "ZONE,Z_DESC,Z_CATEGORY,TITLE_22,PLNG_AREA",
    spatialRel: "esriSpatialRelIntersects",
  };

  // Attempt 1: full polygon (best)
  try {
    const z1 = await esriQuery(endpoints.gisnetParcelQuery, {
      ...base,
      geometry: JSON.stringify(geom),
      geometryType: "esriGeometryPolygon",
      geometryPrecision: "1", // shrink payload
    });
    const a1 = z1.features?.[0]?.attributes ?? null;
    if (a1) {
      return {
        zoning: a1.ZONE ?? null, // e.g., "R-1-10000"
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

  // Attempt 2: envelope (smaller)
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
            // FIX #16: Don't include raw TITLE22 code
            // title22: a2.TITLE_22 ?? null,
          },
          links: { znet: endpoints.znetViewer, gisnet: endpoints.gisnetViewer },
          method: "envelope",
        };
      }
    } catch (e) {
      console.log("[ZONING] envelope query failed -> centroid fallback", String(e));
    }
  }

  // Attempt 3: centroid (tiny, lowest chance to fail)
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
            // FIX #16: Don't include raw TITLE22 code
            // title22: a3.TITLE_22 ?? null,
          },
          links: { znet: endpoints.znetViewer, gisnet: endpoints.gisnetViewer },
          method: "centroid",
        };
      }
    } catch (e) {
      console.log("[ZONING] centroid query failed", String(e));
    }
  }

  // Nothing worked
  return {
    zoning: null,
    details: null,
    links: { znet: endpoints.znetViewer, gisnet: endpoints.gisnetViewer },
    note: "No zoning feature found (polygon/envelope/centroid all failed).",
  };
}

/*------OVERLAY LOOKUP (COUNTY)--------*/
export async function lookupOverlays(
  apn: string
): Promise<{ input: { apn: string }; overlays: OverlayCard[]; note?: string; links?: { znet?: string } }> {
  // 1) get parcel geometry
  const parcel = await getParcelByAINorAPN(apn);
  if (!parcel?.geometry) {
    return {
      input: { apn },
      overlays: [],
      note: "Parcel geometry not found for this APN/AIN.",
    };
  }

  // use a tiny payload for reliability (point); fallback to envelope if needed
  const geom = parcel.geometry;
  const envelope = makeEnvelopeFromGeom(geom);
  const centroid = makeCentroidFromGeom(geom);

  const base = {
    returnGeometry: "false",
    inSR: "102100",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*", // best shot; fields vary by layer
  };

  const results: OverlayCard[] = [];

  for (const url of endpoints.overlayQueries) {
    let attrs: Record<string, any> | null = null;

    try {
      // try POINT first (fast & tiny)
      if (centroid) {
        const r1 = await esriQuery(url, {
          ...base,
          geometry: JSON.stringify(centroid),
          geometryType: "esriGeometryPoint",
        });
        attrs = r1.features?.[0]?.attributes ?? null;
      }

      // fallback: ENVELOPE (if point fails or returns nothing)
      if (!attrs && envelope) {
        const r2 = await esriQuery(url, {
          ...base,
          geometry: JSON.stringify(envelope),
          geometryType: "esriGeometryEnvelope",
        });
        attrs = r2.features?.[0]?.attributes ?? null;
      }

      if (!attrs) continue;

      // ─────────────────────────────────────────────
      // Sanitize attributes before processing
      // ─────────────────────────────────────────────
      const cleanAttrs = sanitizeOverlayAttributes(attrs);

      // ─────────────────────────────────────────────
      // Normalize into OverlayCard
      // ─────────────────────────────────────────────

      // 1) Program (must be OverlayProgram)
      let program: OverlayProgram = "Other"; // default

      if (attrs.CSD_NAME) {
        // County Community Standards District
        program = "CSD";
      }

      // 2) Name - create human-readable name
      let name =
        attrs.CSD_NAME ??
        attrs.SEA_NAME ??
        attrs.DISTRICT ??
        attrs.NAME ??
        attrs.TITLE ??
        attrs.STATUS ?? // For hillside management areas
        summarizeCountyOverlay(attrs) ??
        "County overlay";

      // 3) Details (optional)
      let details: string | undefined = undefined;

      // FIX #16: Don't show raw TITLE22 codes - they're meaningless to users
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

      results.push({
        source: "County",
        program,
        name,
        details,
        attributes: cleanAttrs, // ← Now sanitized
      });
    } catch (e) {
      console.log(`[OVERLAYS] query failed for ${url}`, String(e));
    }
  }

  // Dedupe county overlays by name
  const dedupMap = new Map<string, OverlayCard>();
  for (const card of results) {
    const key = `${card.program}::${card.name.toLowerCase()}`;
    if (!dedupMap.has(key)) {
      dedupMap.set(key, card);
    }
  }

  return {
    input: { apn },
    overlays: Array.from(dedupMap.values()),
    links: { znet: endpoints.znetViewer },
  };
}

/** Attempt to make a short human label from whatever fields the layer has. */
function summarizeCountyOverlay(a?: Record<string, any> | null): string | undefined {
  if (!a) return undefined;

  // Try common field names in priority order
  const candidates = [
    a.NAME, a.Title, a.TITLE, a.LABEL,
    a.DISTRICT, a.CATEGORY, a.TYPE,
    a.PLAN_NAME, a.PLAN, a.CSD_NAME,
    a.SEA_NAME, a.STATUS,
    a.ZONE, a.ZONING,
  ].filter(v => {
    if (!v) return false;
    const s = String(v);
    // Skip values that look like IDs or are too short
    if (/^OBJECTID/i.test(s)) return false;
    if (s.length < 2) return false;
    return true;
  });

  if (candidates.length) return String(candidates[0]);
  return undefined;
}

/* ---------------------- ASSESSOR (AIN/APN → attributes) ---------------------- */

export async function lookupAssessor(id: string) {
  const { digits, dashed } = normalizeApnVariants(id);

  if (!endpoints.assessorParcelQuery) {
    return { links: { assessor: endpoints.assessorViewerForAIN(digits) } };
  }

  // Try by AIN or APN (dashed and undashed)
  const where = [`AIN='${digits}'`, `APN='${digits}'`, `APN='${dashed}'`].join(" OR ");

  // IMPORTANT: ask for everything, then only read what exists
  let r: any;
  try {
    r = await esriQuery(endpoints.assessorParcelQuery, {
      returnGeometry: "true", // FIX #6: Request geometry to compute area as fallback
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

  // Safely read values if they exist on this layer
  const get = (k: string) => (k in a ? a[k] : null);

  // Commonly available on the LACounty_Parcel layer:
  const ain = get("AIN") ?? null;
  const apn = get("APN") ?? null;
  const situs = get("SitusAddress") ?? null;
  const city = get("SitusCity") ?? null;
  const zip = get("SitusZIP") ?? null;
  const use =
    get("UseDescription") ?? get("UseType") ?? get("UseCode") ?? null;

  // Optional fields (many layers won't have these)
  const maybeNums = (...keys: string[]) =>
    keys.map(k => Number(get(k)) || 0).reduce((s, n) => s + n, 0) || null;

  const livingArea = maybeNums("SQFTmain1", "SQFTmain2", "SQFTmain3", "SQFTmain4");

  const yearBuiltVals = ["YearBuilt1", "YearBuilt2", "YearBuilt3", "YearBuilt4"]
    .map(k => parseInt(get(k), 10))
    .filter(n => !Number.isNaN(n));
  const yearBuilt = yearBuiltVals.length ? Math.min(...yearBuiltVals) : null;

  // FIX #6: Expanded field name search for lot size
  // Try multiple possible field names for lot size/area
  const lotSizeFieldNames = [
    // Direct lot size fields
    "LotArea", "LOT_AREA", "LOT_SQFT", "LotSqFt", "LOTSQFT",
    "LandArea", "LAND_AREA", "LandSqFt", "LAND_SQFT",
    "LotSize", "LOT_SIZE", "ParcelArea", "PARCEL_AREA",
    "SqFtLand", "SQFT_LAND", "LotSquareFeet", "LOT_SQUARE_FEET",
    // Shape area (typically in square meters for Web Mercator)
    "Shape_Area", "SHAPE_AREA", "Shape__Area", "ShapeArea",
  ];
  
  let lotSqft: number | null = null;
  for (const fieldName of lotSizeFieldNames) {
    const val = Number(get(fieldName));
    if (val && val > 0) {
      // Check if this is Shape_Area (typically in sq meters, needs conversion)
      if (fieldName.toLowerCase().includes("shape")) {
        // Convert square meters to square feet (1 sq m = 10.7639 sq ft)
        // But only if the value seems reasonable (Web Mercator sq meters)
        // Typical lot: 5000-20000 sq ft = ~465-1858 sq m
        // If value > 10000, it's likely already in sq ft or an error
        if (val < 100000) {
          lotSqft = Math.round(val * 10.7639);
          console.log(`[ASSESSOR] Using ${fieldName} (converted from sq m): ${lotSqft} sq ft`);
        }
      } else {
        lotSqft = val;
        console.log(`[ASSESSOR] Found lot size in ${fieldName}: ${lotSqft}`);
      }
      break;
    }
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
