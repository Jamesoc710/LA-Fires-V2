// lib/la/fetchers.ts
import { endpoints } from "./endpoints";

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

function makeCentroidFromGeom(geom: any) {
  const env = makeEnvelopeFromGeom(geom);
  if (!env) return null;
  return {
    x: (env.xmin + env.xmax) / 2,
    y: (env.ymin + env.ymax) / 2,
    spatialReference: { wkid: 102100 },
  };
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
    "AIN",
    "APN",
    "SitusAddress",
    "SitusCity",
    "SitusZIP",
    "UseCode",
    "UseType",
    "UseDescription",
    // multi-part improvements/main area + earliest year built
    "YearBuilt1",
    "YearBuilt2",
    "YearBuilt3",
    "YearBuilt4",
    "EffectiveYear1",
    "EffectiveYear2",
    "EffectiveYear3",
    "EffectiveYear4",
    "SQFTmain1",
    "SQFTmain2",
    "SQFTmain3",
    "SQFTmain4",
    "Units1",
    "Units2",
    "Units3",
    "Units4",
    "Bedrooms1",
    "Bathrooms1",
    // lot size if present on this layer (sometimes missing)
    "LotArea",
    "LOT_AREA",
    "LOT_SQFT",
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
    ["SQFTmain1", "SQFTmain2", "SQFTmain3", "SQFTmain4"]
      .map((k) => Number(a[k]) || 0)
      .reduce((s, n) => s + n, 0) || null;

  const yearBuiltVals = ["YearBuilt1", "YearBuilt2", "YearBuilt3", "YearBuilt4"]
    .map((k) => parseInt(a[k], 10))
    .filter((n) => !Number.isNaN(n));
  const yearBuilt = yearBuiltVals.length ? Math.min(...yearBuiltVals) : null;

  const lotSqft =
    Number(a.LotArea) || Number(a.LOT_AREA) || Number(a.LOT_SQFT) || null;

  const units = ["Units1", "Units2", "Units3", "Units4"]
    .map((k) => Number(a[k]) || 0)
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
    links: {
      assessor: endpoints.assessorViewerForAIN((a.AIN ?? digits).toString()),
    },
  };
}
