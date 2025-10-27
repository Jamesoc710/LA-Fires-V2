// lib/la/endpoints.ts
// Central registry for LA County endpoints + viewer links (env-driven).

type EndpointMap = Readonly<{
  ZNET_ADDRESS_SEARCH: string;    // PARCEL layer (AIN/APN + geometry)
  GISNET_PARCEL_QUERY: string;    // ZONING layer (ZONE, Z_DESC, etc.)
  ASSESSOR_PARCEL_QUERY: string;  // Assessor attrs (same parcel service is fine)
  ZNET_VIEWER: string;
  GISNET_VIEWER: string;
  TITLE_22: string;
  OVERLAY_QUERY_1?: string;
  OVERLAY_QUERY_2?: string;
  OVERLAY_QUERY_3?: string;
  OVERLAY_QUERY_4?: string;
  OVERLAY_QUERY_5?: string;
  OVERLAY_QUERY_6?: string;
}>;

const env = (k: string, fallback = "") => (process.env[k]?.trim() ?? fallback);

// Read from env (set in Vercel; optional .env.local for local dev)
export const ENDPOINTS: EndpointMap = Object.freeze({
  // Main parcel lookup service (yields AIN, APN, and geometry)
  ZNET_ADDRESS_SEARCH: env("ZNET_ADDRESS_SEARCH"),
  // Zoning information service (queried by geometry)
  GISNET_PARCEL_QUERY: env("GISNET_PARCEL_QUERY"),
  // Assessor details service (queried by AIN/APN)
  ASSESSOR_PARCEL_QUERY: env("ASSESSOR_PARCEL_QUERY"),

  // Static viewer links
  ZNET_VIEWER: "https://experience.arcgis.com/experience/0eecc2d2d0b944a787f282420c8b290c",
  GISNET_VIEWER: "https://planning.lacounty.gov/gisnet",
  TITLE_22: "https://library.municode.com/ca/los_angeles_county/codes/code_of_ordinances?nodeId=TIT22PLZO",

  // Overlay services (up to 6)
  OVERLAY_QUERY_1: env("OVERLAY_QUERY_1"),
  OVERLAY_QUERY_2: env("OVERLAY_QUERY_2"),
  OVERLAY_QUERY_3: env("OVERLAY_QUERY_3"),
  OVERLAY_QUERY_4: env("OVERLAY_QUERY_4"),
  OVERLAY_QUERY_5: env("OVERLAY_QUERY_5"),
  OVERLAY_QUERY_6: env("OVERLAY_QUERY_6"),
});

// Small convenience object used by fetchers.ts
export const endpoints = {
  znetAddressSearch: ENDPOINTS.ZNET_ADDRESS_SEARCH,
  gisnetParcelQuery: ENDPOINTS.GISNET_PARCEL_QUERY,
  assessorParcelQuery: ENDPOINTS.ASSESSOR_PARCEL_QUERY,

  overlayQueries: [
    ENDPOINTS.OVERLAY_QUERY_1,
    ENDPOINTS.OVERLAY_QUERY_2,
    ENDPOINTS.OVERLAY_QUERY_3,
    ENDPOINTS.OVERLAY_QUERY_4,
    ENDPOINTS.OVERLAY_QUERY_5,
    ENDPOINTS.OVERLAY_QUERY_6,
  ].filter(Boolean) as string[],

  znetViewer: ENDPOINTS.ZNET_VIEWER,
  gisnetViewer: ENDPOINTS.GISNET_VIEWER,
  assessorViewerForAIN: (ain: string) =>
    `https://portal.assessor.lacounty.gov/parceldetail/${ain.replace(/\D/g, "")}`,
};

// Require parcel + zoning; assessor optional
export function endpointsConfigured(): boolean {
  return Boolean(endpoints.znetAddressSearch && endpoints.gisnetParcelQuery);
}

// Viewer helpers (optional)
export function assessorParcelUrl(apn: string): string {
  const normalized = apn.replace(/[^0-9]/g, "");
  return `https://portal.assessor.lacounty.gov/parceldetail/${normalized}`;
}
export function znetViewerUrl(): string {
  return ENDPOINTS.ZNET_VIEWER;
}
export function gisnetViewerUrl(): string {
  return ENDPOINTS.GISNET_VIEWER;
}
export function assertCoreEndpoints() {
  if (!endpoints.znetAddressSearch || !endpoints.gisnetParcelQuery) {
    throw new Error(
      "Missing required ArcGIS endpoints. Ensure ZNET_ADDRESS_SEARCH and GISNET_PARCEL_QUERY are set in this environment."
    );
  }
}
