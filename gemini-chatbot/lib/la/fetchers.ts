// lib/la/fetchers.ts
import { endpoints } from "./endpoints";

// region: Types
type EsriPolygon = { rings: number[][][]; spatialReference: { wkid: number } };
type EsriPoint = { x: number; y: number; spatialReference: { wkid: number } };
type EsriEnvelope = { xmin: number; ymin: number; xmax: number; ymax: number; spatialReference: { wkid: number } };

type ParcelFeature = { attributes: { AIN: string; APN: string; SitusAddress: string; SitusCity: string; SitusZIP: string; }; geometry: EsriPolygon; };
type ZoningFeature = { attributes: { ZONE: string; Z_DESC: string; Z_CATEGORY: string; TITLE_22: string; PLNG_AREA: string; } };
type AssessorFeature = { attributes: Record<string, any> };
type OverlayFeature = { attributes: Record<string, any> };

export type ZoningResult = {
  zoning: string | null;
  details: { description: string | null; category: string | null; planningArea: string | null; title22: string | null; } | null;
  links: { znet: string; gisnet: string; };
  note?: string;
  method?: "polygon" | "envelope" | "centroid";
};

export type AssessorResult = {
  ain: string | null;
  apn: string | null;
  situs: string | null;
  city: string | null;
  zip: string | null;
  use: string | null;
  livingArea: number | null;
  yearBuilt: number | null;
  lotSqft: number | null;
  units: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  links: { assessor: string };
  note?: string;
};

export type OverlayResultItem = {
  url: string;
  ok: boolean;
  method: "point" | "envelope";
  attributes?: Record<string, any> | null;
  rawCount?: number;
  error?: string;
  label?: string;
};

// endregion: Types


/* -------------------------- helpers: http + utils -------------------------- */

const ARCGIS_TIMEOUT_MS = 8000;
const ARCGIS_RETRIES = 2;

/** Generic fetcher for ArcGIS Server REST endpoints with retry logic. */
async function esriQuery(url: string, params: Record<string, string>): Promise<{ features: any[] }> {
  const bodyParams = new URLSearchParams({ f: "json", ...params });
  const usePost = !!params.geometry || bodyParams.toString().length > 1800;

  console.log(`[ArcGIS] REQUEST ${usePost ? "POST" : "GET"} ${url}`);

  for (let attempt = 0; attempt <= ARCGIS_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), ARCGIS_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: usePost ? "POST" : "GET",
        headers: usePost ? { "content-type": "application/x-www-form-urlencoded" } : undefined,
        body: usePost ? bodyParams : undefined,
        cache: "no-store",
        signal: ctrl.signal,
      });
      clearTimeout(to);

      if (!res.ok) throw new Error(`ArcGIS HTTP ${res.status}`);
      const json = await res.json();
      if (json?.error) throw new Error(`ArcGIS API Error: ${JSON.stringify(json.error).slice(0, 200)}`);
      
      return json;
    } catch (err) {
      clearTimeout(to);
      console.warn(`[ArcGIS] attempt ${attempt + 1} failed for ${url}`, err);
      if (attempt === ARCGIS_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  throw new Error("esriQuery: exhausted retries");
}

function normalizeApnVariants(id: string) {
  const digits = id.replace(/\D/g, "");
  const dashed = digits.length === 10 ? `${digits.slice(0, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}` : id;
  return { digits, dashed };
}

function makeEnvelopeFromGeom(geom: EsriPolygon): EsriEnvelope | null {
  const rings = geom?.rings?.[0] ?? [];
  if (!rings.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of rings) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { xmin: minX, ymin: minY, xmax: maxX, ymax: maxY, spatialReference: geom.spatialReference };
}

function makeCentroidFromGeom(geom: EsriPolygon): EsriPoint | null {
  const env = makeEnvelopeFromGeom(geom);
  if (!env) return null;
  return {
    x: (env.xmin + env.xmax) / 2,
    y: (env.ymin + env.ymax) / 2,
    spatialReference: geom.spatialReference,
  };
}

/* --------------------------- PARCEL (AIN/APN → geom) --------------------------- */

/** Fetches a parcel's geometry and basic attributes by its AIN or APN. */
export async function getParcelByAINorAPN(id: string): Promise<ParcelFeature | null> {
  const { digits, dashed } = normalizeApnVariants(id);
  const where = [`AIN='${digits}'`, `APN='${digits}'`, `APN='${dashed}'`].join(" OR ");

  const r = await esriQuery(endpoints.znetAddressSearch, {
    returnGeometry: "true",
    outSR: "102100", // Web Mercator
    where,
    outFields: "AIN,APN,SitusAddress,SitusCity,SitusZIP",
  });

  return (r.features as ParcelFeature[]).sort((a,b) => (areaOfGeom(b.geometry) ?? 0) - (areaOfGeom(a.geometry) ?? 0))[0] ?? null;
}

function areaOfGeom(geom: EsriPolygon): number | null {
    if (!geom || !geom.rings || !geom.rings[0]) return null;
    const ring = geom.rings[0];
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        area += x1 * y2 - x2 * y1;
    }
    return Math.abs(area / 2);
}


/* ------------------------ ZONING (parcel geom → zone) ------------------------ */

/** Looks up zoning information for a given parcel ID by first fetching its geometry. */
export async function lookupZoning(id: string): Promise<ZoningResult> {
  const parcel = await getParcelByAINorAPN(id);
  if (!parcel?.geometry) {
    return { zoning: null, details: null, links: { znet: endpoints.znetViewer, gisnet: endpoints.gisnetViewer }, note: "Parcel geometry not found." };
  }

  const geom = parcel.geometry;
  const baseParams = { returnGeometry: "false", inSR: "102100", outFields: "ZONE,Z_DESC,Z_CATEGORY,TITLE_22,PLNG_AREA", spatialRel: "esriSpatialRelIntersects" };

  const strategies = [
    { method: "polygon" as const, geometry: JSON.stringify(geom), geometryType: "esriGeometryPolygon" },
    { method: "envelope" as const, geometry: JSON.stringify(makeEnvelopeFromGeom(geom)), geometryType: "esriGeometryEnvelope" },
    { method: "centroid" as const, geometry: JSON.stringify(makeCentroidFromGeom(geom)), geometryType: "esriGeometryPoint" },
  ];

  for (const s of strategies) {
    if (!s.geometry) continue;
    try {
      const res = await esriQuery(endpoints.gisnetParcelQuery, { ...baseParams, ...s });
      const attrs = (res.features as ZoningFeature[])?.[0]?.attributes;
      if (attrs) {
        return {
          zoning: attrs.ZONE ?? null,
          details: { description: attrs.Z_DESC ?? null, category: attrs.Z_CATEGORY ?? null, planningArea: attrs.PLNG_AREA ?? null, title22: attrs.TITLE_22 ?? null },
          links: { znet: endpoints.znetViewer, gisnet: endpoints.gisnetViewer },
          method: s.method,
        };
      }
    } catch (e) {
      console.log(`[ZONING] ${s.method} query failed, falling back...`, String(e));
    }
  }

  return { zoning: null, details: null, links: { znet: endpoints.znetViewer, gisnet: endpoints.gisnetViewer }, note: "No zoning feature found." };
}

/*------OVERLAY LOOKUP--------*/
/** Looks up all overlay zones for a given parcel ID. */
export async function lookupOverlays(id: string): Promise<{ overlays: OverlayResultItem[] }> {
  const parcel = await getParcelByAINorAPN(id);
  if (!parcel?.geometry) return { overlays: [] };

  const centroid = makeCentroidFromGeom(parcel.geometry);
  if (!centroid) return { overlays: [] };

  const base = { returnGeometry: "false", inSR: "102100", spatialRel: "esriSpatialRelIntersects", outFields: "*" };

  const results: OverlayResultItem[] = await Promise.all(
      endpoints.overlayQueries.map(async (url) => {
          try {
              const r = await esriQuery(url, { ...base, geometry: JSON.stringify(centroid), geometryType: "esriGeometryPoint" });
              const attrs = (r.features as OverlayFeature[])?.[0]?.attributes;
              return { url, ok: !!attrs, method: "point" as const, attributes: attrs, label: summarizeOverlay(attrs) };
          } catch (e) {
              return { url, ok: false, method: "point" as const, error: String(e) };
          }
      })
  );

  return { overlays: results.filter(r => r.ok) };
}

/** Attempt to make a short human label from whatever fields the layer has. */
function summarizeOverlay(a?: Record<string, any> | null): string | undefined {
  if (!a) return undefined;
  const candidates = [ a.NAME, a.Title, a.TITLE, a.LABEL, a.DISTRICT, a.PLAN_NAME, a.CSD_NAME, a.SEA_NAME, a.ZONE ].filter(Boolean);
  return candidates.length ? String(candidates[0]) : undefined;
}

/* ---------------------- ASSESSOR (AIN/APN → attributes) ---------------------- */

/** Looks up detailed assessor information for a given parcel ID. */
export async function lookupAssessor(id: string): Promise<AssessorResult> {
  const { digits, dashed } = normalizeApnVariants(id);
  const where = [`AIN='${digits}'`, `APN='${digits}'`, `APN='${dashed}'`].join(" OR ");

  try {
    const r = await esriQuery(endpoints.assessorParcelQuery, { returnGeometry: "false", where, outFields: "*" });
    const a = (r.features as AssessorFeature[])?.[0]?.attributes;
    if (!a) throw new Error("No assessor data found.");

    const get = (k: string) => (k in a ? a[k] : null);
    const getNum = (k: string) => Number(get(k)) || null;

    return {
      ain: get("AIN"), apn: get("APN"), situs: get("SitusAddress"), city: get("SitusCity"), zip: get("SitusZIP"),
      use: get("UseDescription") ?? get("UseType"),
      livingArea: getNum("SQFTmain1"),
      yearBuilt: getNum("YearBuilt1"),
      lotSqft: getNum("LotArea"),
      units: getNum("Units1"),
      bedrooms: getNum("Bedrooms1"),
      bathrooms: getNum("Bathrooms1"),
      links: { assessor: endpoints.assessorViewerForAIN((get("AIN") ?? digits).toString()) },
    };
  } catch (e) {
    console.log("[ASSESSOR] lookup failed -> returning portal link:", String(e));
    return {
      ain: null, apn: null, situs: null, city: null, zip: null, use: null, livingArea: null, yearBuilt: null, lotSqft: null, units: null, bedrooms: null, bathrooms: null,
      links: { assessor: endpoints.assessorViewerForAIN(digits) },
      note: "Assessor API lookup failed.",
    };
  }
}
