import { ENDPOINTS, endpointsConfigured, assessorParcelUrl } from "./endpoints";
import type { ZoningResult, AssessorResult } from "./types";

/** Abortable fetch with a short timeout so we don't hang the request. */
async function fetchJSON(url: string, init?: RequestInit, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort("timeout"), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, ...init, headers: {
      ...(init?.headers || {}),
      "accept": "application/json"
    }});
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} :: ${url} :: ${text?.slice(0, 250)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Build an ArcGIS "query" URL with common params. */
function buildArcgisQueryURL(base: string, params: Record<string, string>) {
  const u = new URL(base);
  const defaults: Record<string, string> = {
    f: "json",
    outFields: "*",
    returnGeometry: "false",
  };
  const all = { ...defaults, ...params };
  for (const [k, v] of Object.entries(all)) u.searchParams.set(k, v);
  return u.toString();
}

/** Normalize APN to the portal-friendly numeric form. */
function normalizeApn(apn?: string) {
  return apn?.replace(/[^0-9]/g, "");
}

/** Escape single quotes for simple ArcGIS WHERE filters. */
function escapeWhereLiteral(s: string) {
  return s.replace(/'/g, "''");
}

/**
 * Lookup zoning + overlays + helpful links.
 * Input can be address OR apn (OR lat/lng if you later wire a reverse-geocoder).
 */
export async function lookupZoning(input: {
  address?: string;
  apn?: string;
  lat?: number;
  lng?: number;
}): Promise<ZoningResult> {
  const result: ZoningResult = {
    input,
    jurisdiction: "Unknown",
    overlays: [],
    links: {
      znet: ENDPOINTS.ZNET_VIEWER,
      gisnet: ENDPOINTS.GISNET_VIEWER,
      title22: ENDPOINTS.TITLE_22,
    },
  };

  // If endpoints are placeholders, return links only (prevents crashes in Preview).
  if (!endpointsConfigured()) return result;

  // 1) Address → APN via Z-NET (optional step if APN isn’t provided)
  if (input.address && !input.apn) {
    const addr = input.address.trim();
    if (addr.length > 0) {
      // NOTE: Replace "Address" with the real field name in your Z-NET search layer.
      const where = `UPPER(Address) LIKE UPPER('%${escapeWhereLiteral(addr)}%')`;
      const url = buildArcgisQueryURL(ENDPOINTS.ZNET_ADDRESS_SEARCH, {
        where,
        outFields: "*",
        returnGeometry: "false",
      });
      const data = await fetchJSON(url);
      const f = data?.features?.[0]?.attributes ?? {};
      result.apn = f.APN || f.Parcel || result.apn;
      result.community = f.Community || f.City || result.community;
      result.planningArea = f.PlanningArea || result.planningArea;
    }
  }

  // 2) APN → zoning/overlays via GIS-NET
  const apn = input.apn || result.apn;
  if (apn) {
    // NOTE: Replace "APN", "ZONE", "CSD", "HILLSIDE" with your parcel layer’s real field names.
    const where = `APN='${escapeWhereLiteral(apn)}'`;
    const url = buildArcgisQueryURL(ENDPOINTS.GISNET_PARCEL_QUERY, {
      where,
      outFields: "*",
      returnGeometry: "true",
    });

    const data = await fetchJSON(url);
    const g = data?.features?.[0]?.attributes ?? {};

    result.zoning = g.ZONE || g.Zoning || result.zoning;

    const overlays: string[] = [];
    if (g.CSD) overlays.push(`CSD: ${g.CSD}`);
    if (g.HILLSIDE) overlays.push("Hillside");
    // Add more overlays here as your layer exposes them.
    result.overlays = overlays;

    // Helpful deep links users expect
    result.links.assessor = assessorParcelUrl(normalizeApn(apn) || apn);
    result.links.permits = "https://dpw.lacounty.gov/bsd/reports/"; // swap when you have a DRP permit-history URL
  }

  // TODO: add a jurisdiction check (unincorporated vs City) if/when you have a layer for that.

  return result;
}

/** Lookup assessor details (situs/use/areas/yearBuilt) by APN (or later by address). */
export async function lookupAssessor(input: {
  address?: string;
  apn?: string;
}): Promise<AssessorResult> {
  const out: AssessorResult = { input, links: {} };

  if (!endpointsConfigured()) return out;

  // You can add address→APN here by reusing the Z-NET search if needed.
  const apn = input.apn;
  if (!apn) return out;

  // NOTE: Replace field names with the assessor layer’s actual schema.
  const where = `APN='${escapeWhereLiteral(apn)}'`;
  const url = buildArcgisQueryURL(ENDPOINTS.ASSESSOR_QUERY, {
    where,
    outFields: "*",
    returnGeometry: "false",
  });

  const data = await fetchJSON(url);
  const f = data?.features?.[0]?.attributes ?? {};

  out.apn = apn;
  out.situsAddress = f.SITUS || f.Address || undefined;
  out.useCode = f.UseCode || f.LandUse || undefined;
  out.landSqft = toNum(f.LotArea ?? f.LandSQFT);
  out.livingAreaSqft = toNum(f.LivingArea ?? f.SqFt);
  out.yearBuilt = toNum(f.YearBuilt ?? f.YrBuilt);
  out.links.assessor = assessorParcelUrl(normalizeApn(apn) || apn);

  return out;
}

function toNum(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
