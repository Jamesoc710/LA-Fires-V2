// lib/la/providers.ts

/* -------------------------------------------------------------------------- */
/*                               City Providers                               */
/* -------------------------------------------------------------------------- */

// City zoning providers can be either a viewer-only link or an ArcGIS query endpoint.
export type CityProvider =
  | { method: "viewer_link"; viewer: string }
  | {
      method: "arcgis_query";
      viewer?: string;
      zoning: {
        url: string;            // must end in /query
        outFields?: string;     // default "*"
        nameFields?: string;    // comma-list fallback: "ZONE,ZONING,ZONE_CODE"
        descFields?: string;    // fallback list for description
        categoryFields?: string; // optional fallback list
      };
    };

/* -------------------------------------------------------------------------- */
/*                              Helper Functions                              */
/* -------------------------------------------------------------------------- */

// Normalize city names for consistent lookups
export function normalizeCityName(s: string | null | undefined) {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^city of\s+/i, "")           // "City of Pasadena" -> "Pasadena"
    .replace(/\s+city$/i, "")              // "Pasadena City" -> "Pasadena"
    .replace(/^los angeles city$/, "los angeles") // rare variant
    .replace(/[^\p{L}\p{N}\s-]/gu, "")     // remove punctuation safely
    .trim();
}

// Safely parse CITY_PROVIDERS_JSON and normalize keys
export function loadCityProvidersSafe(): Record<string, CityProvider> {
  let raw = (process.env.CITY_PROVIDERS_JSON ?? "{}").trim();
  const i = raw.indexOf("{");
  if (i > 0) raw = raw.slice(i);
  try {
    const obj = JSON.parse(raw) as Record<string, CityProvider>;
    const out: Record<string, CityProvider> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[normalizeCityName(k)] = v;
    }
    return out;
  } catch (e) {
    console.error("[CITY_PROVIDERS_JSON] parse error:", e);
    return {};
  }
}

/* -------------------------------------------------------------------------- */
/*                            Jurisdiction Typing                             */
/* -------------------------------------------------------------------------- */

export type JurisdictionResult = {
  jurisdiction: string;
  source: "CITY" | "COUNTY" | "ERROR";
  raw?: Record<string, any>;
  note?: string;
};

/* -------------------------------------------------------------------------- */
/*                           Provider Lookup Helper                           */
/* -------------------------------------------------------------------------- */

// Global registry for resolved city providers
let REGISTRY: Record<string, CityProvider> = {};
try {
  REGISTRY = loadCityProvidersSafe();
} catch {
  REGISTRY = {};
}

// Find provider by normalized city name
export function resolveCityProvider(cityName: string): CityProvider | undefined {
  const norm = normalizeCityName(cityName);
  return REGISTRY[norm];
}
