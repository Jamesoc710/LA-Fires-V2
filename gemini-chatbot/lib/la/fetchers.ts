// lib/la/fetchers.ts
import { endpoints } from "./endpoints";

/* -------------------------- helpers: http + utils -------------------------- */

const ARCGIS_TIMEOUT_MS = 8000;
const ARCGIS_RETRIES = 2;

async function esriQuery(url: string, params: Record<string, string>) {
  const qs = new URLSearchParams({ f: "json", ...params }).toString();
  const full = `${url}?${qs}`;

  for (let attempt = 0; attempt <= ARCGIS_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), ARCGIS_TIMEOUT_MS);

    try {
      const res = await fetch(full, { method: "GET", cache: "no-store", signal: ctrl.signal as any });
      clearTimeout(to);

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`ArcGIS ${res.status} ${res.statusText} :: ${body?.slice(0, 200)}`);
      }
      const json = await res.json();
      // ArcGIS error payloads still return 200 sometimes:
      if ((json as any)?.error) {
        throw new Error(`ArcGIS error :: ${JSON.stringify((json as any).error).slice(0, 200)}`);
      }
      return json;
    } catch (err) {
      clearTimeout(to);
      if (attempt === ARCGIS_RETRIES) throw err;
      // small jitter before retry
      await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  // unreachable
  throw new Error("esriQuery: exhausted retries");
}

function digitsOnly(id: string) {
  return id.replace(/\D/g, "");
}

function pickLargestFeatureByArea(features: any[] | undefined) {
  if (!features?.length) return undefined;
  // area in WebMercator (outSR=102100) -> approximate by ring bbox area
  let best = features[0];
  let bestArea = areaOfGeom(features[0]?.geometry);
  for (let i = 1; i < features.length; i++) {
    const a = areaOfGeom(features[i]?.geometry);
    if ((a ?? 0) > (bestArea ?? 0)) {
      best = features[i]; bestArea = a;
    }
  }
  return best;
}

function areaOfGeom(geom: any): number | null {
  if (!geom) return null;
  try {
    // polygon rings: [[x,y], ...]
    const rings = geom.rings?.[0];
    if (!Array.isArray(rings) || rings.length < 3) return null;
    // rough bbox area
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of rings) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return (maxX - minX) * (maxY - minY);
  } catch { return null; }
}

/* --------------------------- PARCEL (AIN/APN → geom) --------------------------- */

export async function getParcelByAINorAPN(id: string) {
  const digits = digitsOnly(id);
  const where = [
    `REPLACE(UPPER(AIN),'-','')='${digits}'`,
    `REPLACE(UPPER(APN),'-','')='${digits}'`,
  ].join(" OR ");

  const r = await esriQuery(endpoints.znetAddressSearch, {
    returnGeometry: "true",
    outSR: "102100",
    where,
    // keep lean; add more only if you show them in UI
    outFields: "AIN,APN,SitusAddress,SitusCity,SitusZIP",
  });

  // if multiple polygons (condos/complex), take the largest
  const feat = pickLargestFeatureByArea(r.features);
  return feat ?? null;
}

/* ------------------------ ZONING (parcel geom → zone) ------------------------ */

export async function lookupZoning(id: string) {
  const parcel = await getParcelByAINorAPN(id);
  if (!parcel?.geometry) {
    return { zoning: null, details: null, links: { znet: endpoints.znetViewer, gisnet: endpoints.gisnetViewer } };
  }

  const z = await esriQuery(endpoints.gisnetParcelQuery, {
    returnGeometry: "false",
    geometry: JSON.stringify(parcel.geometry),
    geometryType: "esriGeometryPolygon",
    inSR: "102100",
    spatialRel: "esriSpatialRelIntersects",
    // tailor to your confirmed fields on layer 4
    outFields: "ZONE,Z_DESC,Z_CATEGORY,TITLE_22,PLNG_AREA",
  });

  const a = z.features?.[0]?.attributes ?? null;
  return a
    ? {
        zoning: a.ZONE ?? null, // e.g., "R-1-10000"
        details: {
          description: a.Z_DESC ?? null,
          category: a.Z_CATEGORY ?? null,
          planningArea: a.PLNG_AREA ?? null,
          title22: a.TITLE_22 ?? null,
        },
        links: { znet: endpoints.znetViewer, gisnet: endpoints.gisnetViewer },
      }
    : { zoning: null, details: null, links: { znet: endpoints.znetViewer, gisnet: endpoints.gisnetViewer } };
}

/* ---------------------- ASSESSOR (AIN/APN → attributes) ---------------------- */

export async function lookupAssessor(id: string) {
  const digits = digitsOnly(id);

  if (!endpoints.assessorParcelQuery) {
    return { links: { assessor: endpoints.assessorViewerForAIN(digits) } };
  }

  const where = [
    `REPLACE(UPPER(AIN),'-','')='${digits}'`,
    `REPLACE(UPPER(APN),'-','')='${digits}'`,
  ].join(" OR ");

  const outFields = [
    "AIN","APN","SitusAddress","SitusCity","SitusZIP",
    "UseCode","UseType","UseDescription",
    // multi-part improvements/main area + earliest year built
    "YearBuilt1","YearBuilt2","YearBuilt3","YearBuilt4",
    "EffectiveYear1","EffectiveYear2","EffectiveYear3","EffectiveYear4",
    "SQFTmain1","SQFTmain2","SQFTmain3","SQFTmain4",
    "Units1","Units2","Units3","Units4",
    "Bedrooms1","Bathrooms1",
    // lot size if present on this layer (sometimes missing)
    "LotArea","LOT_AREA","LOT_SQFT"
  ].join(",");

  const r = await esriQuery(endpoints.assessorParcelQuery, {
    returnGeometry: "false",
    where,
    outFields,
  });

  const a = r.features?.[0]?.attributes;
  if (!a) {
    return { links: { assessor: endpoints.assessorViewerForAIN(digits) } };
  }

  const livingArea =
    ["SQFTmain1","SQFTmain2","SQFTmain3","SQFTmain4"]
      .map(k => Number(a[k]) || 0)
      .reduce((s, n) => s + n, 0) || null;

  const yearBuiltVals = ["YearBuilt1","YearBuilt2","YearBuilt3","YearBuilt4"]
    .map(k => parseInt(a[k], 10))
    .filter(n => !Number.isNaN(n));
  const yearBuilt = yearBuiltVals.length ? Math.min(...yearBuiltVals) : null;

  const lotSqft =
    Number(a.LotArea) || Number(a.LOT_AREA) || Number(a.LOT_SQFT) || null;

  const units = ["Units1","Units2","Units3","Units4"].map(k => Number(a[k]) || 0)
                  .reduce((s, n) => s + n, 0) || null;

  return {
    ain: a.AIN ?? null,
    apn: a.APN ?? null,
    situs: a.SitusAddress ?? null,
    city: a.SitusCity ?? null,
    zip: a.SitusZIP ?? null,
    use: a.UseDescription || a.UseType || a.UseCode || null,
    livingArea,
    yearBuilt,
    lotSqft,
    units,
    bedrooms: a.Bedrooms1 ?? null,
    bathrooms: a.Bathrooms1 ?? null,
    links: { assessor: endpoints.assessorViewerForAIN((a.AIN ?? digits).toString()) },
  };
}
