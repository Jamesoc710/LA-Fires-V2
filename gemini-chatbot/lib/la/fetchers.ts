// lib/la/fetchers.ts
import { endpoints } from "./endpoints";
import type { CityProvider, JurisdictionResult } from "./providers";
import { normalizeCityName } from "./providers";

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

export function makeCentroidFromGeom(geom: any) {
  const env = makeEnvelopeFromGeom(geom);
  if (!env) return null;
  return {
    x: (env.xmin + env.xmax) / 2,
    y: (env.ymin + env.ymax) / 2,
    spatialReference: { wkid: 102100 },
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

  return {
    card: {
      type: "zoning",
      title: "Zoning (City)",
      body: label || "Zoning attributes found.",
      raw: a,
      links: provider.viewer ? { viewer: provider.viewer } : undefined,
    }
  };
}

// ----------------------------- CITY OVERLAYS -----------------------------
type ArcgisPoint102100 = { x: number; y: number; spatialReference: { wkid: 102100 } };

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

function pickField(a: Record<string, any>, csv?: string) {
  if (!a || !csv) return undefined;
  for (const k of csv.split(",").map(s => s.trim()).filter(Boolean)) {
    if (k in a && a[k] != null && String(a[k]).trim() !== "") return String(a[k]);
  }
  return undefined;
}

function summarizeOverlayAttrs(a?: Record<string, any> | null, nameCsv?: string, descCsv?: string) {
  if (!a) return undefined;
  const name = pickField(a, nameCsv) ??
               pickField(a, "NAME,TITLE,LABEL,DISTRICT,ZONE,PLAN,OVERLAY,CPIO_NAME,HPOZ_NAME");
  const desc = pickField(a, descCsv) ??
               pickField(a, "DESCRIPTIO,NOTES,TYPE,CATEGORY");
  if (name && desc) return `${name} — ${desc}`;
  if (name) return name;
  return undefined;
}

/** Query city overlays at a parcel centroid (102100). */
export async function lookupCityOverlays(
  centroid102100: ArcgisPoint102100,
  bundles: OverlayBundle[]
): Promise<{ overlays: OverlayHit[]; note?: string }> {
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

      // Case B: FeatureServer root + sublayer IDs (SUD bundle)
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

  return { overlays: results };
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
          title22: a1.TITLE_22 ?? null,
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
            title22: a2.TITLE_22 ?? null,
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
            title22: a3.TITLE_22 ?? null,
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

/*------OVERLAY LOOKUP--------*/
export async function lookupOverlays(id: string) {
  // 1) get parcel geometry
  const parcel = await getParcelByAINorAPN(id);
  if (!parcel?.geometry) {
    return { overlays: [], note: "Parcel geometry not found for this APN/AIN." };
  }

  // use a tiny payload for reliability (point); fallback to envelope if needed
  const geom = parcel.geometry;
  const envelope = makeEnvelopeFromGeom(geom);
  const centroid = makeCentroidFromGeom(geom);

  const base = {
    returnGeometry: "false",
    inSR: "102100",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",              // best shot; fields vary by layer
  };

  const results: Array<{
    url: string;
    ok: boolean;
    method: "point" | "envelope";
    attributes?: Record<string, any> | null;
    rawCount?: number;
    error?: string;
    label?: string;
  }> = [];

  for (const url of endpoints.overlayQueries) {
    // try POINT first (fast & tiny)
    try {
      if(!centroid) continue;
      const r1 = await esriQuery(url, {
        ...base,
        geometry: JSON.stringify(centroid),
        geometryType: "esriGeometryPoint",
      });
      const attrs = r1.features?.[0]?.attributes ?? null;
      results.push({
        url,
        ok: Boolean(attrs),
        method: "point",
        attributes: attrs,
        rawCount: Array.isArray(r1.features) ? r1.features.length : undefined,
        label: summarizeOverlay(attrs),
      });
      continue;
    } catch (e) {
      // fall through to envelope
    }

    // fallback: ENVELOPE (still small)
    try {
      if(!envelope) continue;
      const r2 = await esriQuery(url, {
        ...base,
        geometry: JSON.stringify(envelope),
        geometryType: "esriGeometryEnvelope",
      });
      const attrs = r2.features?.[0]?.attributes ?? null;
      results.push({
        url,
        ok: Boolean(attrs),
        method: "envelope",
        attributes: attrs,
        rawCount: Array.isArray(r2.features) ? r2.features.length : undefined,
        label: summarizeOverlay(attrs),
      });
    } catch (e) {
      results.push({ url, ok: false, method: "envelope", error: String(e) });
    }
  }

  return { overlays: results };
}

/** Attempt to make a short human label from whatever fields the layer has. */
function summarizeOverlay(a?: Record<string, any> | null): string | undefined {
  if (!a) return undefined;

  // Try common field names you’ll see across those layers:
  const candidates = [
    a.NAME, a.Title, a.TITLE, a.LABEL,
    a.DISTRICT, a.DIST_TYPE, a.CATEGORY, a.TYPE,
    a.PLAN_NAME, a.PLAN, a.CSD_NAME,
    a.SEA_NAME, a.CRANAME, a.RL_NAME,
    a.ZONE, a.ZONING, a.Z_CAT, a.SPEC_PLAN,
  ].filter(Boolean);

  if (candidates.length) return String(candidates[0]);

  // last resort: show first two keys
  const keys = Object.keys(a);
  if (keys.length) {
    const pick = keys.slice(0, 2).map(k => `${k}:${a[k]}`).join(", ");
    return pick;
  }
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
      returnGeometry: "false",
      where,
      outFields: "*",          // <-- safe
    });
  } catch (e) {
    console.log("[ASSESSOR] hard fail -> returning portal link:", String(e));
    return {
      links: { assessor: endpoints.assessorViewerForAIN(digits) },
      note: "Assessor API returned an error; providing official portal link.",
    };
  }

  const a = r?.features?.[0]?.attributes;
  if (!a) {
    return { links: { assessor: endpoints.assessorViewerForAIN(digits) } };
  }

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

  // Optional fields (many layers won’t have these)
  const maybeNums = (...keys: string[]) =>
    keys.map(k => Number(get(k)) || 0).reduce((s, n) => s + n, 0) || null;

  const livingArea = maybeNums("SQFTmain1", "SQFTmain2", "SQFTmain3", "SQFTmain4");

  const yearBuiltVals = ["YearBuilt1", "YearBuilt2", "YearBuilt3", "YearBuilt4"]
    .map(k => parseInt(get(k), 10))
    .filter(n => !Number.isNaN(n));
  const yearBuilt = yearBuiltVals.length ? Math.min(...yearBuiltVals) : null;

  const lotSqft =
    Number(get("LotArea")) || Number(get("LOT_AREA")) || Number(get("LOT_SQFT")) || null;

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
