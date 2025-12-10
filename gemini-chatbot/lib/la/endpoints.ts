// lib/la/endpoints.ts
// Central registry for LA County endpoints + viewer links (env-driven).

type EndpointMap = Readonly<{
  ZNET_ADDRESS_SEARCH: string;    // PARCEL layer (AIN/APN + geometry)
  GISNET_PARCEL_QUERY: string;    // ZONING layer (ZONE, Z_DESC, etc.)
  ASSESSOR_PARCEL_QUERY: string;  // Assessor attrs (same parcel service is fine)
  JURISDICTION_QUERY?: string;    // <-- NEW: City boundaries (Jurisdiction layer)
  ZNET_VIEWER: string;
  GISNET_VIEWER: string;
  TITLE_22: string;
  OVERLAY_QUERY_1?: string;
  OVERLAY_QUERY_2?: string;
  OVERLAY_QUERY_3?: string;
  OVERLAY_QUERY_4?: string;
  OVERLAY_QUERY_5?: string;
  OVERLAY_QUERY_6?: string;

  FIRE_HAZARD_ZONES_QUERY?: string;
  HILLSIDE_OVERLAY_QUERY?: string;
  FLOOD_100YR_QUERY?: string;
}>;

const env = (k: string, fallback = "") => (process.env[k] || fallback).trim();

// Read from env (set in Vercel; optional .env.local for local dev)
export const ENDPOINTS: EndpointMap = Object.freeze({
  // Main parcel lookup service (yields AIN, APN, and geometry)
  ZNET_ADDRESS_SEARCH: env("ZNET_ADDRESS_SEARCH"),
  // Zoning information service (queried by geometry)
  GISNET_PARCEL_QUERY: env("GISNET_PARCEL_QUERY"),
  // Assessor details service (queried by AIN/APN)
  ASSESSOR_PARCEL_QUERY: env("ASSESSOR_PARCEL_QUERY"),
  // Jurisdiction detection (City Boundaries layer)
  JURISDICTION_QUERY: env(
    "JURISDICTION_QUERY",
    "https://dpw.gis.lacounty.gov/dpw/rest/services/PW_Jurisdiction_Locator/MapServer/0"
  ),

  // Static viewer links
  ZNET_VIEWER:
    "https://experience.arcgis.com/experience/0eecc2d2d0b944a787f282420c8b290c",
  GISNET_VIEWER: "https://egis-lacounty.hub.arcgis.com/",
  TITLE_22:
    "https://library.municode.com/ca/los_angeles_county/codes/code_of_ordinances?nodeId=TIT22PLZO",

  // Overlay services (up to 6)
  OVERLAY_QUERY_1: env("OVERLAY_QUERY_1"),
  OVERLAY_QUERY_2: env("OVERLAY_QUERY_2"),
  OVERLAY_QUERY_3: env("OVERLAY_QUERY_3"),
  OVERLAY_QUERY_4: env("OVERLAY_QUERY_4"),
  OVERLAY_QUERY_5: env("OVERLAY_QUERY_5"),
  OVERLAY_QUERY_6: env("OVERLAY_QUERY_6"),
  FIRE_HAZARD_ZONES_QUERY: env("FIRE_HAZARD_ZONES_QUERY"),
  HILLSIDE_OVERLAY_QUERY: env("HILLSIDE_OVERLAY_QUERY"),
  FLOOD_100YR_QUERY: env("FLOOD_100YR_QUERY"),
});

export const endpoints = {
  znetAddressSearch: ENDPOINTS.ZNET_ADDRESS_SEARCH,
  gisnetParcelQuery: ENDPOINTS.GISNET_PARCEL_QUERY,
  assessorParcelQuery: ENDPOINTS.ASSESSOR_PARCEL_QUERY,
  jurisdictionQuery: ENDPOINTS.JURISDICTION_QUERY,

  overlayQueries: [
    ENDPOINTS.OVERLAY_QUERY_1,
    ENDPOINTS.OVERLAY_QUERY_2,
    ENDPOINTS.OVERLAY_QUERY_3,
    ENDPOINTS.OVERLAY_QUERY_4,
    ENDPOINTS.OVERLAY_QUERY_5,
    ENDPOINTS.OVERLAY_QUERY_6,

    ENDPOINTS.FIRE_HAZARD_ZONES_QUERY,
    ENDPOINTS.HILLSIDE_OVERLAY_QUERY,
    ENDPOINTS.FLOOD_100YR_QUERY,
  ].filter(Boolean) as string[],

  znetViewer: ENDPOINTS.ZNET_VIEWER,
  gisnetViewer: ENDPOINTS.GISNET_VIEWER,
  assessorViewerForAIN: (ain: string) =>
    `https://portal.assessor.lacounty.gov/parceldetail/${ain.replace(/\D/g, "")}`,
};


export function assertCoreEndpoints() {
  if (!endpoints.znetAddressSearch || !endpoints.gisnetParcelQuery) {
    throw new Error(
      "Missing required ArcGIS endpoints. Ensure ZNET_ADDRESS_SEARCH and GISNET_PARCEL_QUERY are set."
    );
  }
  // Optional: warn if jurisdiction endpoint is missing
  if (!endpoints.jurisdictionQuery) {
    // eslint-disable-next-line no-console
    console.warn("[WARN] Missing JURISDICTION_QUERY — city detection disabled.");
  }
}


// Viewer URLs for client-side use
export const znetViewerUrl = ENDPOINTS.ZNET_VIEWER;
export const gisnetViewerUrl = ENDPOINTS.GISNET_VIEWER;
export const assessorParcelUrl = (ain: string) =>
  `https://portal.assessor.lacounty.gov/parceldetail/${ain.replace(/\D/g, "")}`;

// FIX #5: City-specific viewer URLs
export const zimasViewerUrl = "https://zimas.lacity.org/";
export const pasadenaZoningViewerUrl = "https://cityofpasadena.net/planning/zoning/";

/**
 * Get the appropriate viewer URL based on jurisdiction.
 * Returns null if no specific viewer applies.
 */
export function getViewerUrlForJurisdiction(jurisdiction: string | undefined | null): {
  name: string;
  url: string;
} | null {
  if (!jurisdiction) return null;
  
  const j = jurisdiction.toLowerCase();
  
  // City of Los Angeles
  if (j === "los angeles" || j === "city of los angeles" || j === "la") {
    return { name: "ZIMAS", url: zimasViewerUrl };
  }
  
  // Pasadena
  if (j === "pasadena" || j === "city of pasadena") {
    return { name: "Pasadena Zoning", url: pasadenaZoningViewerUrl };
  }
  
  // Unincorporated LA County - no specific link, use ZNET/GISNET
  return null;
}

/**
 * Determine if ZNET/GISNET links should be shown for a jurisdiction.
 * These are only relevant for unincorporated LA County areas.
 */
export function shouldShowCountyViewers(jurisdiction: string | undefined | null): boolean {
  if (!jurisdiction) return true; // default to showing if unknown
  
  const j = jurisdiction.toLowerCase();
  
  // Show county viewers only for unincorporated areas
  return (
    j.includes("unincorporated") ||
    j === "la county" ||
    j === "los angeles county" ||
    j === "unknown"
  );
}
