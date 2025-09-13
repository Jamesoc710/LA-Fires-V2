// lib/la/endpoints.ts
// Central registry for LA County endpoints + viewer links (env-driven).

type EndpointMap = Readonly<{
  // REST endpoints (ArcGIS /query)
  ZNET_ADDRESS_SEARCH: string;    // PARCEL layer (AIN/APN + geometry)
  GISNET_PARCEL_QUERY: string;    // ZONING layer (ZONE, Z_DESC, etc.)
  ASSESSOR_PARCEL_QUERY: string;  // Assessor attrs (same parcel service is fine)

  // Human-viewer links
  ZNET_VIEWER: string;
  GISNET_VIEWER: string;
  TITLE_22: string;
}>;

const env = (k: string, fallback = "") => (process.env[k]?.trim() ?? fallback);

// Read from env (set these in Vercel and, if you run locally, .env.local)
export const ENDPOINTS: EndpointMap = Object.freeze({
  ZNET_ADDRESS_SEARCH: env("ZNET_ADDRESS_SEARCH"),
  GISNET_PARCEL_QUERY: env("GISNET_PARCEL_QUERY"),
  ASSESSOR_PARCEL_QUERY: env("ASSESSOR_PARCEL_QUERY"),

  ZNET_VIEWER:
    "https://experience.arcgis.com/experience/0eecc2d2d0b944a787f282420c8b290c",
  GISNET_VIEWER: "https://planning.lacounty.gov/gisnet",
  TITLE_22:
    "https://library.municode.com/ca/los_angeles_county/codes/code_of_ordinances?nodeId=TIT22PLZO",
});

// Back-compat convenience object used by fetchers.ts
export const endpoints = {
  znetAddressSearch: ENDPOINTS.ZNET_ADDRESS_SEARCH,
  gisnetParcelQuery: ENDPOINTS.GISNET_PARCEL_QUERY,
  assessorParcelQuery: ENDPOINTS.ASSESSOR_PARCEL_QUERY,

  znetViewer: ENDPOINTS.ZNET_VIEWER,
  gisnetViewer: ENDPOINTS.GISNET_VIEWER,
  assessorViewerForAIN: (ain: string) =>
    `https://portal.assessor.lacounty.gov/parceldetail/${ain.replace(/\D/g, "")}`,
};

// Only require parcel + zoning to run; assessor is optional.
export function endpointsConfigured(): boolean {
  return Boolean(endpoints.znetAddressSearch && endpoints.gisnetParcelQuery);
}

// Viewer helpers (unchanged)
export function assessorParcelUrl(apn: string): string {
  const normalized = apn.replace(/[^0-9]/g, "");
  return `https://portal.assessor.lacounty.gov/parceldetail/${normalized}`;
}
export function znetViewerUrl(_address?: string): string {
  return ENDPOINTS.ZNET_VIEWER;
}
export function gisnetViewerUrl(_apn?: string): string {
  return ENDPOINTS.GISNET_VIEWER;
}
