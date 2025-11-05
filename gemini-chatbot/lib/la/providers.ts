export type CityProviderViewer = { method: "viewer_link"; viewer: string };
export type CityProviderArcGIS = {
  method: "arcgis_query";
  zoning: { url: string; outFields?: string; fields?: Record<string, string[]> };
  overlays?: Array<{ url: string; outFields?: string }>;
  viewer?: string;
};
export type CityProvider = CityProviderViewer | CityProviderArcGIS;

export type JurisdictionResult = {
  jurisdiction: string;
  source: "CITY" | "COUNTY" | "ERROR";
  raw?: Record<string, any>;
  note?: string;
};

let REGISTRY: Record<string, CityProvider> = {};
try {
  const raw = process.env.CITY_PROVIDERS_JSON?.trim();
  if (raw) REGISTRY = JSON.parse(raw);
} catch (e) {
  console.warn("[CITY_PROVIDERS_JSON] parse error:", e);
}

const norm = (s: string) => s.replace(/^City of\s+/i, "").trim().toLowerCase();

export function resolveCityProvider(cityName: string): CityProvider | undefined {
  const key = norm(cityName);
  return REGISTRY[cityName] || REGISTRY[key] || REGISTRY[cityName.replace(/^City of\s+/i, "").trim()];
}
