/**
 * Central registry for LA County endpoints + viewer links.
 * - Keep REST (machine) URLs separate from human-viewer URLs.
 * - Safe to import on server or client (strings only).
 * - Helpers included for common deep links.
 *
 * Fill the three REST placeholders when you’re ready.
 */

type EndpointMap = Readonly<{
  // --- REST (machine) endpoints used by fetchers.ts ---
  ZNET_ADDRESS_SEARCH: string;   // FeatureServer/MapServer "query" for address → APN
  GISNET_PARCEL_QUERY: string;   // MapServer "query" for APN → zoning/overlays
  ASSESSOR_QUERY: string;        // MapServer "query" for APN → assessor attrs

  // --- Human-friendly viewers (for clickable sources) ---
  ZNET_VIEWER: string;
  GISNET_VIEWER: string;
  TITLE_22: string;
}>;

/** Default endpoints (replace <arcgis-host> when you wire real layers). */
export const ENDPOINTS: EndpointMap = Object.freeze({
  // REST (machine) endpoints
  ZNET_ADDRESS_SEARCH: "https://<arcgis-host>/.../FeatureServer/0/query",
  GISNET_PARCEL_QUERY: "https://<arcgis-host>/.../MapServer/0/query",
  ASSESSOR_QUERY:      "https://<arcgis-host>/.../MapServer/0/query",

  // Viewers / references
  ZNET_VIEWER:
    "https://experience.arcgis.com/experience/0eecc2d2d0b944a787f282420c8b290c",
  GISNET_VIEWER: "https://planning.lacounty.gov/gisnet",
  TITLE_22:
    "https://library.municode.com/ca/los_angeles_county/codes/code_of_ordinances?nodeId=TIT22PLZO",
});

/** Quick guard so fetchers can early-return if placeholders aren’t replaced yet. */
export function endpointsConfigured(): boolean {
  return ![
    ENDPOINTS.ZNET_ADDRESS_SEARCH,
    ENDPOINTS.GISNET_PARCEL_QUERY,
    ENDPOINTS.ASSESSOR_QUERY,
  ].some((u) => u.includes("<arcgis-host>"));
}

/** Build a viewer link to the Assessor portal for a given APN. */
export function assessorParcelUrl(apn: string): string {
  const normalized = apn.replace(/[^0-9]/g, "");
  return `https://portal.assessor.lacounty.gov/parceldetail/${normalized}`;
}

/**
 * Optional viewer helpers (use if you want to deep-link):
 * - These return base viewers now; if you later know the query-string params used by Z-NET/GIS-NET,
 *   you can add them here without touching the rest of the app.
 */
export function znetViewerUrl(_address?: string): string {
  return ENDPOINTS.ZNET_VIEWER;
}
export function gisnetViewerUrl(_apn?: string): string {
  return ENDPOINTS.GISNET_VIEWER;
}
