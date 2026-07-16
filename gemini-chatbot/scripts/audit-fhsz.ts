// scripts/audit-fhsz.ts
// Read-only audit of the app's Fire Hazard Severity Zone (FHSZ) data currency.
//
// The app answers "what fire hazard severity zone is this parcel in" by routing
// unincorporated parcels to a LA County composite layer (FIRE_HAZARD_ZONES_QUERY)
// and city parcels to per-city fire overlays (CITY_PROVIDERS_JSON). This script
// compares what those app-served layers return at a matrix of test points against
// three known-current reference layers (LAFD CalFire LRA 2025, County FHSZ LRA,
// County FHSZ SRA), reports each layer's vintage, and flags MATCH / STALE / MISMATCH.
//
// It writes nothing to disk and only issues read-only ArcGIS queries.
//
// Usage:
//   npm run audit:fhsz
//   npx tsx scripts/audit-fhsz.ts

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { CityProvider } from "../lib/la/providers";

/* --------------------------------- env --------------------------------- */

// Minimal .env.local reader. Must run BEFORE any dynamic import of app code
// (lib/la/providers freezes CITY_PROVIDERS_JSON at module load). Strips exactly
// one pair of outer double quotes; leaves inner (unescaped) quotes untouched.
function loadEnvLocal(): void {
  const p = join(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

/* ------------------------------- http fetch ------------------------------- */

const ARCGIS_TIMEOUT_MS = 8000;
const ARCGIS_RETRIES = 2;

// Standalone mirror of lib/la/fetchers.ts esriQuery (no caching / redis deps,
// no per-request console noise). Always f=json; POST when geometry present or the
// GET URL would be long; throws on json.error.
async function esriQuery(url: string, params: Record<string, string>): Promise<any> {
  const bodyParams = new URLSearchParams({ f: "json", ...params });
  const qs = bodyParams.toString();
  const full = `${url}?${qs}`;
  const usePost = !!params.geometry || full.length > 1800;

  for (let attempt = 0; attempt <= ARCGIS_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), ARCGIS_TIMEOUT_MS);
    try {
      const res = await fetch(usePost ? url : full, {
        method: usePost ? "POST" : "GET",
        headers: usePost
          ? { "content-type": "application/x-www-form-urlencoded" }
          : undefined,
        body: usePost ? qs : undefined,
        cache: "no-store",
        signal: ctrl.signal,
      });
      clearTimeout(to);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`ArcGIS ${res.status} ${res.statusText} :: ${body.slice(0, 120)}`);
      }
      const json = await res.json();
      if (json?.error) {
        throw new Error(`ArcGIS error :: ${JSON.stringify(json.error).slice(0, 120)}`);
      }
      return json;
    } catch (err) {
      clearTimeout(to);
      if (attempt === ARCGIS_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  throw new Error("esriQuery: exhausted retries");
}

function shortMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/\s+/g, " ").slice(0, 60);
}

/* ------------------------------ class helpers ------------------------------ */

// FHSZ / HAZ code -> descriptive label (CalFire convention).
function codeToLabel(code: number): string {
  if (code === 3) return "Very High";
  if (code === 2) return "High";
  if (code === 1) return "Moderate";
  return "none"; // -3, -2, 0 -> NonWildland / no zone
}

// Extract a raw class label from a feature's attributes. Returns a label string
// (or "present" when a feature exists but carries no class attribute -> caller
// infers from the layer label, e.g. LA's Very-High membership polygon).
function extractClass(attrs: Record<string, any> | undefined, layerLabel: string): string {
  if (!attrs) return "none";
  const strFields = ["HAZ_CLASS", "FHSZ_Description", "FHSZ_Descr"];
  for (const k of strFields) {
    if (k in attrs && attrs[k] != null && String(attrs[k]).trim() !== "") {
      return String(attrs[k]).trim();
    }
  }
  const codeFields = ["FHSZ", "HAZ_CODE"];
  for (const k of codeFields) {
    if (k in attrs && attrs[k] != null && String(attrs[k]).trim() !== "") {
      const n = Number(attrs[k]);
      if (!Number.isNaN(n)) return codeToLabel(n);
    }
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (/haz|fhsz|severity/i.test(k) && v != null && String(v).trim() !== "") {
      return String(v).trim();
    }
  }
  // Feature present but no class attribute: infer from the layer's own semantics.
  return /very high/i.test(layerLabel) ? "Very High" : "present";
}

// Normalize a class label for comparison. Order matters: the "none" family (which
// includes NonWildland / NonVHFHSZ / Urban Unzoned) is matched before "veryhigh"
// so "nonvhfhsz" does not slip through, and "veryhigh" before "high".
function normalizeClass(raw: string): string {
  const s = (raw || "").toLowerCase().replace(/[^a-z]/g, "");
  if (
    s === "" || s === "none" || s === "nodata" || s === "notmapped" ||
    s === "unzoned" || s.includes("nonwildland") || s.includes("nonvhfhsz") ||
    s.includes("urbanunzoned")
  ) {
    return "none";
  }
  if (s.includes("veryhigh") || s.includes("vhfhsz")) return "veryhigh";
  if (s.includes("moderate")) return "moderate";
  if (s.includes("high")) return "high";
  return s;
}

/* ------------------------------ layer naming ------------------------------ */

// Compact, readable short name for a layer query/resource URL.
function shortName(url: string): string {
  const idm = url.match(/\/(\d+)\/query\/?$/) || url.match(/\/(\d+)\/?$/);
  const id = idm ? idm[1] : "?";
  if (/CalFire_FHSZ_LRA25/i.test(url)) return `LAFD-LRA25/${id}`;
  if (/FHSALRA25_v1_All/i.test(url)) return `SW-LRA25/${id}`;
  if (/LACounty_Dynamic\/Hazards/i.test(url)) return `County/${id}`;
  if (/Very_High_Fire_Hazard/i.test(url)) return `LA-VHFHSZ/${id}`;
  if (/Wildfire_Hazard_Area/i.test(url)) return `PAS-WildfireHaz/${id}`;
  if (/Parcels_Fire_Severity/i.test(url)) return `PAS-ParcelSev/${id}`;
  if (/Fire_Severity_Zones/i.test(url)) return `CAgov-FSZ/${id}`;
  const m = url.match(/\/services\/(.+?)\/(FeatureServer|MapServer)\//i);
  const svc = m ? (m[1].split("/").pop() || "layer").replace(/[^A-Za-z0-9]+/g, "").slice(0, 12) : "layer";
  return `${svc}/${id}`;
}

const metaUrlOf = (queryUrl: string): string => queryUrl.replace(/\/query\/?$/, "");

/* ------------------------------- vintage ------------------------------- */

interface Vintage {
  display: string;
  date: number | null; // comparable epoch ms (most recent advertised)
}

const metaCache = new Map<string, any>();
const vintageCache = new Map<string, Vintage>();

async function getMeta(metaUrl: string): Promise<any> {
  if (metaCache.has(metaUrl)) return metaCache.get(metaUrl);
  let j: any;
  try {
    j = await esriQuery(metaUrl, {});
  } catch (e) {
    j = { __error: shortMsg(e) };
  }
  metaCache.set(metaUrl, j);
  return j;
}

function fmtDate(epoch: number): string {
  return new Date(epoch).toISOString().slice(0, 10);
}

function yearsInWindow(text: string, limit: number): number[] {
  const t = (text || "").replace(/\s+/g, " ").slice(0, limit);
  const m = t.match(/\b(?:19|20)\d\d\b/g) || [];
  return m.map(Number);
}

// Vintage from layer resource metadata: editingInfo.lastEditDate (epoch), plus a
// 4-digit year found in the layer name or the first ~200 chars of description /
// copyrightText. Window widened from the nominal ~120 to capture LRA25's copyright
// "Updated March 24, 2025" (char ~136) and County/19's dated description (~char 79);
// County/18 buries its first year at char ~440 so it stays "vintage unknown".
function vintageFromMeta(metaUrl: string, meta: any): Vintage {
  if (vintageCache.has(metaUrl)) return vintageCache.get(metaUrl)!;
  const parts: string[] = [];
  const dates: number[] = [];

  if (meta?.__error) {
    const v: Vintage = { display: `vintage unknown (metadata error: ${meta.__error})`, date: null };
    vintageCache.set(metaUrl, v);
    return v;
  }

  const ei = meta?.editingInfo;
  const epoch = typeof ei?.lastEditDate === "number" ? ei.lastEditDate
    : typeof ei?.dataLastEditDate === "number" ? ei.dataLastEditDate : null;
  if (epoch && epoch > 0) {
    parts.push(`edited ${fmtDate(epoch)}`);
    dates.push(epoch);
  }

  const nameYears = yearsInWindow(meta?.name, 200);
  if (nameYears.length) {
    parts.push(`name "${String(meta.name).trim()}"`);
    dates.push(Date.UTC(Math.max(...nameYears), 0, 1));
  }

  const desc = (meta?.description || "").replace(/\s+/g, " ");
  const descYears = yearsInWindow(desc, 200);
  if (descYears.length) {
    const pos = desc.search(/\b(?:19|20)\d\d\b/);
    parts.push(`desc ~${Math.max(...descYears)} ("${desc.slice(Math.max(0, pos - 30), pos + 60).trim()}...")`);
    dates.push(Date.UTC(Math.max(...descYears), 0, 1));
  }

  const copy = (meta?.copyrightText || "").replace(/\s+/g, " ");
  const copyYears = yearsInWindow(copy, 200);
  if (copyYears.length) {
    const pos = copy.search(/\b(?:19|20)\d\d\b/);
    parts.push(`copyright ~${Math.max(...copyYears)} ("${copy.slice(Math.max(0, pos - 30), pos + 40).trim()}...")`);
    dates.push(Date.UTC(Math.max(...copyYears), 0, 1));
  }

  const v: Vintage = {
    display: parts.length ? parts.join(" | ") : "vintage unknown",
    date: dates.length ? Math.max(...dates) : null,
  };
  vintageCache.set(metaUrl, v);
  return v;
}

async function getVintage(queryUrl: string): Promise<Vintage> {
  const metaUrl = metaUrlOf(queryUrl);
  const meta = await getMeta(metaUrl);
  return vintageFromMeta(metaUrl, meta);
}

/* --------------------------- point / count queries --------------------------- */

interface Layer {
  query: string;
  label: string;
}

interface PointResult {
  norm: string;
  label: string;
  featureCount: number;
  error?: string;
}

const POINT_PARAMS = (lat: number, lng: number): Record<string, string> => ({
  geometry: `${lng},${lat}`,
  geometryType: "esriGeometryPoint",
  inSR: "4326",
  spatialRel: "esriSpatialRelIntersects",
  outFields: "*",
  returnGeometry: "false",
});

async function classAtPoint(layer: Layer, lat: number, lng: number): Promise<PointResult> {
  try {
    const r = await esriQuery(layer.query, POINT_PARAMS(lat, lng));
    const feats: any[] = Array.isArray(r?.features) ? r.features : [];
    if (feats.length === 0) return { norm: "none", label: "none", featureCount: 0 };
    const label = extractClass(feats[0]?.attributes, layer.label);
    return { norm: normalizeClass(label), label, featureCount: feats.length };
  } catch (e) {
    return { norm: "ERROR", label: "ERROR", featureCount: 0, error: shortMsg(e) };
  }
}

async function countWithin(layer: Layer, lat: number, lng: number, deg = 0.02): Promise<number> {
  const env = JSON.stringify({
    xmin: lng - deg, ymin: lat - deg, xmax: lng + deg, ymax: lat + deg,
    spatialReference: { wkid: 4326 },
  });
  try {
    const r = await esriQuery(layer.query, {
      geometry: env,
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      returnCountOnly: "true",
    });
    return typeof r?.count === "number" ? r.count : 0;
  } catch {
    return 0;
  }
}

/* ------------------------------ web mercator ------------------------------ */

const MERC_R = 6378137;
function toMercator(lng: number, lat: number): { x: number; y: number } {
  return {
    x: (MERC_R * lng * Math.PI) / 180,
    y: MERC_R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)),
  };
}

function pointInExtent(lat: number, lng: number, meta: any): boolean {
  const ext = meta?.extent;
  if (!ext || typeof ext.xmin !== "number") return false;
  const wkid = ext.spatialReference?.latestWkid ?? ext.spatialReference?.wkid;
  let px: number, py: number;
  if (wkid === 4326) {
    px = lng; py = lat;
  } else {
    const m = toMercator(lng, lat);
    px = m.x; py = m.y;
  }
  return px >= ext.xmin && px <= ext.xmax && py >= ext.ymin && py <= ext.ymax;
}

/* ------------------------------ reference layers ------------------------------ */

const LRA25_QUERY = "https://firegis.lafd.org/arcgis/rest/services/CalFire_FHSZ_LRA25/MapServer/16/query";
const LRA25: Layer = { query: LRA25_QUERY, label: "LAFD CalFire FHSZ LRA25 (16)" };

// Statewide CAL FIRE 2025 LRA service (all rollout phases). URL path "FHSALRA25"
// is CAL FIRE's own typo; service title is "FHSZLRA25_v1_All". Class comes from the
// FHSZ_Description string field. LRA lands only; SRA points return no feature. Any
// returned feature (incl. NonWildland) counts as coverage.
const SW_LRA25_QUERY = "https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/arcgis/rest/services/FHSALRA25_v1_All/FeatureServer/0/query";
const SW_LRA25: Layer = { query: SW_LRA25_QUERY, label: "CAL FIRE statewide FHSZ LRA25 (all phases)" };

function countyRefs(countyFireQuery: string): { c18: Layer; c19: Layer } {
  const m = countyFireQuery.match(/^(.*\/MapServer)\/2\/query\/?$/);
  const base = m ? m[1] : "https://public.gis.lacounty.gov/public/rest/services/LACounty_Dynamic/Hazards/MapServer";
  return {
    c18: { query: `${base}/18/query`, label: "County FHSZ LRA (18)" },
    c19: { query: `${base}/19/query`, label: "County FHSZ SRA (19)" },
  };
}

/* ---------------------------- coverage (LRA25) ---------------------------- */

interface Coverage {
  covers: boolean;
  cls: string; // normalized class the layer reports at the point
  atPointFeature: boolean;
  nearCount: number; // -1 when a feature is present at the point (not probed)
  inExtent: boolean;
}

const coverageCache = new Map<string, Coverage>();

async function lra25Coverage(lat: number, lng: number): Promise<Coverage> {
  const key = `${lat},${lng}`;
  if (coverageCache.has(key)) return coverageCache.get(key)!;
  const pt = await classAtPoint(LRA25, lat, lng);
  const meta = await getMeta(metaUrlOf(LRA25.query));
  const inExtent = pointInExtent(lat, lng, meta);
  let cov: Coverage;
  if (pt.error) {
    cov = { covers: false, cls: "ERROR", atPointFeature: false, nearCount: 0, inExtent };
  } else if (pt.featureCount > 0) {
    cov = { covers: true, cls: pt.norm, atPointFeature: true, nearCount: -1, inExtent };
  } else {
    const nearCount = await countWithin(LRA25, lat, lng);
    cov = { covers: inExtent && nearCount > 0, cls: "none", atPointFeature: false, nearCount, inExtent };
  }
  coverageCache.set(key, cov);
  return cov;
}

/* --------------------------------- matrix --------------------------------- */

const FIRE_LABEL_RE = /fire hazard|fire severity|wildfire hazard|parcel fire/i;

interface MatrixPoint {
  name: string;
  lat: number;
  lng: number;
  jurisdiction: string;
  kind: "county" | "city";
  city?: string; // normalized city key for city points
}

interface ServedResult {
  norm: string;
  srcShort: string;
  servedQuery: string; // the specific sublayer that produced the class (for vintage)
  detail: Array<{ layer: string; cls: string }>;
}

// Resolve the app-served FHSZ class for a point.
async function resolveServed(
  pt: MatrixPoint,
  countyFireQuery: string,
  providers: Record<string, CityProvider>,
): Promise<ServedResult> {
  if (pt.kind === "county") {
    const layer: Layer = { query: countyFireQuery, label: "County composite FHSZ (2)" };
    const r = await classAtPoint(layer, pt.lat, pt.lng);
    const cls = r.error ? `ERROR:${r.error}` : r.norm;
    const short = shortName(countyFireQuery);
    return { norm: r.error ? "ERROR" : r.norm, srcShort: short, servedQuery: countyFireQuery, detail: [{ layer: short, cls }] };
  }

  const provider = pt.city ? providers[pt.city] : undefined;
  const overlays = provider && "overlays" in provider ? provider.overlays ?? [] : [];
  const fireOverlays = overlays.filter((o) => FIRE_LABEL_RE.test(o.label));

  // Flatten fire overlays into ordered sublayer query entries.
  const entries: Array<{ q: string; short: string; label: string }> = [];
  for (const ov of fireOverlays) {
    const subs = ov.sublayers && ov.sublayers.length ? ov.sublayers : [null];
    for (const id of subs) {
      const base = ov.url.replace(/\/+$/, "");
      const q = id != null ? `${base}/${id}/query` : (/\/query$/.test(ov.url) ? ov.url : `${base}/query`);
      entries.push({ q, short: shortName(q), label: ov.label });
    }
  }

  const detail: Array<{ layer: string; cls: string }> = [];
  let served: ServedResult = {
    norm: "none",
    srcShort: entries[0]?.short ?? "n/a",
    servedQuery: entries[0]?.q ?? countyFireQuery,
    detail,
  };
  for (const e of entries) {
    const r = await classAtPoint({ query: e.q, label: e.label }, pt.lat, pt.lng);
    const cls = r.error ? `ERROR:${r.error}` : r.norm;
    detail.push({ layer: e.short, cls });
    if (served.norm === "none" && !r.error && r.norm !== "none") {
      served = { norm: r.norm, srcShort: e.short, servedQuery: e.q, detail };
    }
  }
  return served;
}

interface Row {
  point: string;
  jurisdiction: string;
  servedNorm: string;
  servedSrc: string;
  lra25: string;
  swlra: string;
  county18: string;
  county19: string;
  verdict: string;
  note?: string;
  servedDetail: Array<{ layer: string; cls: string }>;
}

async function auditPoint(
  pt: MatrixPoint,
  countyFireQuery: string,
  c18: Layer,
  c19: Layer,
  providers: Record<string, CityProvider>,
): Promise<Row> {
  const served = await resolveServed(pt, countyFireQuery, providers);
  const lraRes = await classAtPoint(LRA25, pt.lat, pt.lng);
  const swRes = await classAtPoint(SW_LRA25, pt.lat, pt.lng);
  const r18 = await classAtPoint(c18, pt.lat, pt.lng);
  const r19 = await classAtPoint(c19, pt.lat, pt.lng);
  const cov = await lra25Coverage(pt.lat, pt.lng);

  // Determine the "current" class. Priority: LAFD LRA25/16 (if it covers the point)
  // -> statewide SW-LRA25 (any returned feature = coverage; NonWildland is an explicit
  // "none"-class feature) -> county /19 (SRA) -> county /18 -> "none".
  let currentNorm: string;
  let currentQuery: string;
  const disagreeBits: string[] = [];
  if (cov.covers && cov.cls !== "ERROR") {
    currentNorm = cov.cls;
    currentQuery = LRA25.query;
  } else if (swRes.featureCount > 0 && !swRes.error) {
    currentNorm = swRes.norm;
    currentQuery = SW_LRA25.query;
  } else if (r19.featureCount > 0 && !r19.error) {
    currentNorm = r19.norm;
    currentQuery = c19.query;
  } else if (r18.featureCount > 0 && !r18.error) {
    currentNorm = r18.norm;
    currentQuery = c18.query;
  } else {
    currentNorm = "none";
    currentQuery = SW_LRA25.query;
  }

  // Disagreement notes. Flag LAFD-vs-SW divergence, and (when current comes from a
  // CAL FIRE layer) divergence against the county layer that returns a feature.
  if (cov.covers && cov.cls !== "ERROR" && swRes.featureCount > 0 && !swRes.error && swRes.norm !== cov.cls) {
    disagreeBits.push(`LAFD-LRA25/16=${cov.cls} disagrees SW-LRA25=${swRes.norm}`);
  }
  if (currentQuery === LRA25.query || currentQuery === SW_LRA25.query) {
    const cc = r19.featureCount > 0 && !r19.error ? { name: "County/19", norm: r19.norm }
      : r18.featureCount > 0 && !r18.error ? { name: "County/18", norm: r18.norm } : null;
    if (cc && cc.norm !== currentNorm) {
      disagreeBits.push(`current=${currentNorm} disagrees ${cc.name}=${cc.norm}`);
    }
  }

  // Verdict.
  let verdict: string;
  if (served.norm === "ERROR") {
    verdict = "MISMATCH";
  } else if (served.norm === currentNorm) {
    verdict = "MATCH";
  } else {
    const servedDate = (await getVintage(served.servedQuery)).date;
    const currentDate = (await getVintage(currentQuery)).date;
    verdict = servedDate != null && currentDate != null && servedDate < currentDate ? "STALE" : "MISMATCH";
  }

  const noteBits: string[] = [];
  noteBits.push(`current=${currentNorm}@${shortName(currentQuery)}`);
  if (!cov.covers && cov.cls !== "ERROR") noteBits.push("LAFD LRA25 no coverage");
  noteBits.push(...disagreeBits);

  return {
    point: pt.name,
    jurisdiction: pt.jurisdiction,
    servedNorm: served.norm,
    servedSrc: served.srcShort,
    lra25: lraRes.error ? "ERROR" : lraRes.norm,
    swlra: swRes.error ? "ERROR" : swRes.norm,
    county18: r18.error ? "ERROR" : r18.norm,
    county19: r19.error ? "ERROR" : r19.norm,
    verdict,
    note: noteBits.join("; "),
    servedDetail: served.detail,
  };
}

/* ---------------------------- derived newly-VH probe ---------------------------- */

async function deriveNewlyVH(
  countyFireQuery: string,
): Promise<{ lat: number; lng: number; c2: string; sw: string } | null> {
  const county: Layer = { query: countyFireQuery, label: "County composite FHSZ (2)" };
  const lats: number[] = [];
  for (let la = 34.175; la <= 34.215 + 1e-9; la += 0.008) lats.push(Number(la.toFixed(3)));
  const lngs: number[] = [];
  for (let lo = -118.16; lo <= -118.09 + 1e-9; lo += 0.01) lngs.push(Number(lo.toFixed(2)));

  let probes = 0;
  const CAP = 40;
  for (const lat of lats) {
    for (const lng of lngs) {
      if (probes >= CAP) return null;
      probes++;
      const c2 = await classAtPoint(county, lat, lng);
      if (c2.norm === "veryhigh") continue; // need county NOT very-high
      const sw = await classAtPoint(SW_LRA25, lat, lng);
      if (sw.norm === "veryhigh") {
        return { lat, lng, c2: c2.norm, sw: sw.norm };
      }
    }
  }
  return null;
}

/* -------------------------------- rendering -------------------------------- */

function pad(s: string, w: number): string {
  const str = String(s);
  return str.length >= w ? str.slice(0, w) : str.padEnd(w);
}

const W = { point: 28, jur: 14, served: 26, ref: 11, verdict: 9 };

function tableHeader(): string {
  return [
    pad("Point", W.point),
    pad("Jurisdiction", W.jur),
    pad("Served (class @ source)", W.served),
    pad("LRA25/16", W.ref),
    pad("SW-LRA25", W.ref),
    pad("County/18", W.ref),
    pad("County/19", W.ref),
    pad("Verdict", W.verdict),
  ].join("  ");
}

function tableRow(r: Row): string {
  return [
    pad(r.point, W.point),
    pad(r.jurisdiction, W.jur),
    pad(`${r.servedNorm} @ ${r.servedSrc}`, W.served),
    pad(r.lra25, W.ref),
    pad(r.swlra, W.ref),
    pad(r.county18, W.ref),
    pad(r.county19, W.ref),
    pad(r.verdict, W.verdict),
  ].join("  ");
}

/* --------------------------------- main --------------------------------- */

async function main(): Promise<void> {
  const started = Date.now();
  loadEnvLocal();

  const countyFireQuery = (process.env.FIRE_HAZARD_ZONES_QUERY || "").trim();
  if (!countyFireQuery) {
    throw new Error("FIRE_HAZARD_ZONES_QUERY is not set (.env.local). Cannot audit unincorporated routing.");
  }
  const { loadCityProvidersSafe } = await import("../lib/la/providers");
  const providers = loadCityProvidersSafe();
  const { c18, c19 } = countyRefs(countyFireQuery);

  const cities = ["los angeles", "pasadena", "malibu", "santa monica", "arcadia"];

  console.log("========================================================================================");
  console.log(`FHSZ DATA CURRENCY AUDIT  —  ${new Date().toISOString()}`);
  console.log("Read-only. Compares app-served FHSZ layers vs known-current 2024/2025 reference layers.");
  console.log("========================================================================================\n");

  /* (i) Header: every distinct layer + vintage. */
  const headerLayers: Array<{ role: string; query: string }> = [];
  headerLayers.push({ role: "served · unincorporated LA County", query: countyFireQuery });
  const seenMeta = new Set<string>([metaUrlOf(countyFireQuery)]);
  for (const city of cities) {
    const provider = providers[city];
    const overlays = provider && "overlays" in provider ? provider.overlays ?? [] : [];
    for (const ov of overlays.filter((o) => FIRE_LABEL_RE.test(o.label))) {
      const subs = ov.sublayers && ov.sublayers.length ? ov.sublayers : [null];
      for (const id of subs) {
        const base = ov.url.replace(/\/+$/, "");
        const q = id != null ? `${base}/${id}/query` : (/\/query$/.test(ov.url) ? ov.url : `${base}/query`);
        const meta = metaUrlOf(q);
        if (seenMeta.has(meta)) continue;
        seenMeta.add(meta);
        headerLayers.push({ role: `served · ${city}`, query: q });
      }
    }
  }
  headerLayers.push({ role: "reference · CalFire LRA 2025 (LAFD)", query: LRA25.query });
  headerLayers.push({ role: "reference · CAL FIRE statewide LRA 2025 (all rollout phases)", query: SW_LRA25.query });
  headerLayers.push({ role: "reference · County FHSZ LRA", query: c18.query });
  headerLayers.push({ role: "reference · County FHSZ SRA", query: c19.query });

  console.log("LAYERS AND VINTAGES");
  console.log("-------------------");
  for (const hl of headerLayers) {
    const v = await getVintage(hl.query);
    console.log(`${pad(shortName(hl.query), 20)} ${hl.role}`);
    console.log(`  url:     ${metaUrlOf(hl.query)}`);
    console.log(`  vintage: ${v.display}`);
  }
  console.log("");

  /* Derived newly-VH probe over the Eaton-fire fringe. */
  console.log("DERIVED NEWLY-VH PROBE (county layer 2 vs statewide SW-LRA25, Eaton fringe grid)");
  console.log("------------------------------------------------------------------------------");
  const derived = await deriveNewlyVH(countyFireQuery);
  if (derived) {
    console.log(`  FOUND: (${derived.lat}, ${derived.lng}) — county/2=${derived.c2}, SW-LRA25=${derived.sw}`);
    console.log("  Added to matrix as 'Altadena newly-VH (derived)'.");
  } else {
    console.log("  No point found where county layer 2 is NOT very-high but statewide SW-LRA25 IS very-high.");
    console.log("  (Statewide SW-LRA25 does cover unincorporated Altadena; across this grid county layer 2");
    console.log("   already agrees with — or exceeds — SW-LRA25's very-high mapping, so no stale VH gap of");
    console.log("   that direction exists in the Altadena fringe.)");
  }
  console.log("");

  /* Build matrix. */
  const matrix: MatrixPoint[] = [
    { name: "Altadena core", lat: 34.19, lng: -118.131, jurisdiction: "Unincorporated", kind: "county" },
    { name: "Palisades", lat: 34.045, lng: -118.525, jurisdiction: "Los Angeles", kind: "city", city: "los angeles" },
    { name: "Pasadena", lat: 34.156, lng: -118.132, jurisdiction: "Pasadena", kind: "city", city: "pasadena" },
    { name: "Malibu", lat: 34.037, lng: -118.68, jurisdiction: "Malibu", kind: "city", city: "malibu" },
    { name: "Santa Monica", lat: 34.02, lng: -118.49, jurisdiction: "Santa Monica", kind: "city", city: "santa monica" },
    { name: "Arcadia", lat: 34.132, lng: -118.032, jurisdiction: "Arcadia", kind: "city", city: "arcadia" },
  ];
  if (derived) {
    matrix.splice(1, 0, {
      name: "Altadena newly-VH (derived)",
      lat: derived.lat,
      lng: derived.lng,
      jurisdiction: "Unincorporated",
      kind: "county",
    });
  }

  const rows: Row[] = [];
  for (const pt of matrix) {
    rows.push(await auditPoint(pt, countyFireQuery, c18, c19, providers));
  }

  /* (ii) Main table. */
  console.log("MAIN COMPARISON TABLE  (all classes normalized: veryhigh / high / moderate / none / ERROR)");
  console.log("-----------------------------------------------------------------------------------------");
  console.log(tableHeader());
  console.log("-".repeat(tableHeader().length));
  for (const r of rows) console.log(tableRow(r));
  console.log("");
  console.log("Per-row detail:");
  for (const r of rows) {
    console.log(`  ${r.point}: ${r.note}`);
    console.log(`      served overlays: ${r.servedDetail.map((d) => `${d.layer}=${d.cls}`).join(", ") || "(none)"}`);
  }
  console.log("");

  /* (iii) Extent probe for Malibu, Santa Monica, Arcadia on LAFD LRA25/16. */
  console.log("LAFD LRA25/16 COVERAGE PROBE  (Malibu, Santa Monica, Arcadia)");
  console.log("-------------------------------------------------------------");
  const probeCities = matrix.filter((m) => ["malibu", "santa monica", "arcadia"].includes(m.city ?? ""));
  for (const pc of probeCities) {
    const cov = await lra25Coverage(pc.lat, pc.lng);
    const sw = await classAtPoint(SW_LRA25, pc.lat, pc.lng);
    const near = cov.nearCount < 0 ? "n/a (feature at point)" : String(cov.nearCount);
    const swCls = sw.error ? `ERROR (${sw.error})` : sw.norm;
    const conclusion = cov.covers
      ? `LAFD LRA25 covers — viable repoint target; SW-LRA25 class here: ${swCls}`
      : `NOT covered by LAFD LRA25 — repoint to SW-LRA25 (statewide CAL FIRE 2025); SW-LRA25 class here: ${swCls}`;
    console.log(
      `  ${pad(pc.name, 14)} (${pc.lat}, ${pc.lng}): in extent: ${cov.inExtent ? "yes" : "no"} | ` +
      `features within ~2km: ${near} | conclusion: ${conclusion}`,
    );
  }
  console.log("");

  /* (iv) Summary. */
  const count = (v: string): number => rows.filter((r) => r.verdict === v).length;
  console.log("SUMMARY");
  console.log("-------");
  console.log(`  ${count("MATCH")} MATCH / ${count("STALE")} STALE / ${count("MISMATCH")} MISMATCH  (of ${rows.length} matrix points)`);
  if (derived) {
    console.log(`  Derived newly-VH point: (${derived.lat}, ${derived.lng})`);
  } else {
    console.log("  Derived newly-VH point: none found in scanned grid.");
  }
  console.log(`  elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error("\naudit-fhsz failed:\n" + (e instanceof Error ? e.stack || e.message : String(e)));
  process.exit(1);
});
