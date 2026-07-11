// scripts/build-municode-index.ts
// Builds the Title 26 (LA County Building Code) RAG index from
// context/municode_title_26.txt into context/municode_index.json.
//
// The corpus is a single-line-per-chapter markdown dump: odd lines are content,
// each an ENTIRE chapter/appendix; only `## ` starts a chapter, while `### SECTION`
// and `#### <num>` markers appear inline mid-line. We split chapters into sections,
// sections into subsection-aligned chunks (<= MAX_CHARS with overlap), and optionally
// embed each chunk. Embedding walks a provider ladder (OpenRouter -> Google direct);
// `--no-embed` emits the index structure without vectors.
//
// Usage:
//   npm run build:municode-index -- --no-embed   (structure only, no API calls)
//   npm run build:municode-index                 (embed via OpenRouter/Google)

import { readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

const MAX_CHARS = 4400;
const OVERLAP_CHARS = 400;
const BASE_URL = "https://library.municode.com/ca/los_angeles_county/codes/code_of_ordinances";

const CORPUS_FILE = "municode_title_26.txt";
const CONTEXT_DIR = join(process.cwd(), "context");
const CORPUS_PATH = join(CONTEXT_DIR, CORPUS_FILE);
const OUTPUT_PATH = join(CONTEXT_DIR, "municode_index.json");

// Markers that terminate the chapter label (first one wins).
const LABEL_CUT_MARKERS = [" … ", "[Title 26]", " TABLE ", "###", "####"];
// Markdown links pointing at municode.com — boilerplate we strip from intros.
const MUNICODE_MD_LINK_RE = /\[[^\]]*\]\([^)]*municode\.com[^)]*\)/gi;
// Bare municode URLs (used to derive a chapter URL).
const MUNICODE_URL_RE = /https?:\/\/[^\s)]*municode\.com[^\s)]*/gi;
// Subsection markers. NOTE: spec gives `/(?=#### \d)/`, but appendix subsections are
// letter-prefixed (#### J101.1, #### H103.1, #### P101.1); `[0-9A-Z]` covers those too.
// See the deviation note in the final report.
const SUBSECTION_SPLIT_RE = /(?=#### [0-9A-Z])/;
const SECTION_SPLIT_RE = /### (?=SECTION\b)/;

interface Chunk {
  id: string;
  chapter: string;
  chapterNum: string;
  section: string;
  sectionNum: string;
  breadcrumb: string;
  url: string;
  charLen: number;
  text: string;
  vec?: string;
}

interface IndexFile {
  version: 1;
  model: string;
  provider: "openrouter" | "google" | "none";
  dims: number;
  normalized: boolean;
  taskType?: string;
  corpusFile: string;
  corpusHash: string;
  createdAt: string;
  chunkCount: number;
  chunks: Chunk[];
}

/* --------------------------------- env --------------------------------- */

// Minimal .env.local reader (no dotenv dep). Does not override existing env.
function loadEnvLocal(): void {
  const p = join(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

/* ------------------------------ text helpers ------------------------------ */

function collapseSpaces(s: string): string {
  return s.replace(/[ \t]{2,}/g, " ");
}

// Chapter label: strip `## `, cut at the first terminator, collapse, cap 90.
function chapterLabelOf(introRegion: string): { label: string; afterLabel: string } {
  const label0 = introRegion.replace(/^## /, "");
  let cut = label0.length;
  for (const m of LABEL_CUT_MARKERS) {
    const i = label0.indexOf(m);
    if (i >= 0 && i < cut) cut = i;
  }
  const label = label0.slice(0, cut).replace(/\s+/g, " ").trim().slice(0, 90);
  const afterLabel = label0.slice(cut);
  return { label, afterLabel };
}

function chapterNumOf(introRegion: string): string {
  const m = introRegion.replace(/^## /, "").match(/^(?:CHAPTER|APPENDIX)\s+(\S+)/);
  return m ? m[1] : "";
}

// Prefer a link whose URL contains CH<num>, else first municode link, else BASE_URL.
function chapterUrlOf(block: string, chapterNum: string): string {
  const links = block.match(MUNICODE_URL_RE) || [];
  const needle = ("CH" + chapterNum).toUpperCase();
  const specific = links.find((u) => u.toUpperCase().includes(needle));
  return specific || links[0] || BASE_URL;
}

// sectionNum from `SECTION <id>`, trailing punctuation stripped.
function sectionNumOf(part: string): string {
  const m = part.match(/^SECTION\s+(\S+)/);
  if (!m) return "";
  return m[1].replace(/[^A-Za-z0-9]+$/, "");
}

// Uppercase run after ` - `, capped 80; stops at ####, a mixed-case word, or a period.
function sectionNameOf(part: string): string {
  const idx = part.indexOf(" - ");
  if (idx < 0) return "";
  const after = part.slice(idx + 3);
  const kept: string[] = [];
  for (const w of after.split(/\s+/)) {
    if (!w) continue;
    if (w.startsWith("####")) break;
    const dot = w.indexOf(".");
    if (dot >= 0) {
      const head = w.slice(0, dot);
      if (head && !/[a-z]/.test(head) && /[A-Z0-9]/.test(head)) kept.push(head);
      break; // a period terminates the run
    }
    if (/[a-z]/.test(w)) break; // mixed-case word terminates the run
    kept.push(w);
  }
  return kept.join(" ").trim().slice(0, 80).trim();
}

/* ------------------------------- chunking ------------------------------- */

// Hard-split an oversize unit into MAX_CHARS windows with OVERLAP_CHARS overlap.
function hardSplit(s: string): string[] {
  const out: string[] = [];
  const step = MAX_CHARS - OVERLAP_CHARS;
  let start = 0;
  while (start < s.length) {
    out.push(s.slice(start, start + MAX_CHARS));
    if (start + MAX_CHARS >= s.length) break;
    start += step;
  }
  return out;
}

interface HardSplitCounter {
  count: number;
}

// Greedy-pack subsection units into chunks <= MAX_CHARS. When a chunk closes
// mid-body, the next one is seeded with the previous chunk's last OVERLAP_CHARS
// (dropped only if it would push the chunk over MAX_CHARS). Single units larger
// than MAX_CHARS are hard-split and counted separately.
function packBody(body: string, hs: HardSplitCounter): string[] {
  const units = body.split(SUBSECTION_SPLIT_RE);
  const chunks: string[] = [];
  let cur = "";
  for (const unit of units) {
    if (!unit) continue;
    if (unit.length > MAX_CHARS) {
      if (cur) {
        chunks.push(cur);
        cur = "";
      }
      for (const w of hardSplit(unit)) {
        chunks.push(w);
        hs.count++;
      }
      continue;
    }
    if (cur === "") {
      cur = unit;
    } else if (cur.length + unit.length <= MAX_CHARS) {
      cur += unit;
    } else {
      const prefix = cur.slice(-OVERLAP_CHARS);
      chunks.push(cur);
      cur = prefix.length + unit.length <= MAX_CHARS ? prefix + unit : unit;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/* -------------------------------- build -------------------------------- */

interface BuildStats {
  perChapter: Map<string, number>;
  hardSplit: number;
  sectionNums: Set<string>;
  coverageChars: number;
  appendixAChars: number;
}

function buildChunks(text: string): { chunks: Chunk[]; stats: BuildStats } {
  const blocks = text.split("\n").filter((l) => l.startsWith("## "));
  const chunks: Chunk[] = [];
  const stats: BuildStats = {
    perChapter: new Map(),
    hardSplit: 0,
    sectionNums: new Set(),
    coverageChars: 0,
    appendixAChars: 0,
  };
  const hs: HardSplitCounter = { count: 0 };

  for (const block of blocks) {
    const chapterNum = chapterNumOf(block);

    if (chapterNum === "A") {
      // Skip the Appendix A legislative-history block entirely, but record its
      // size so coverage is measured against the corpus minus that block.
      stats.appendixAChars = block.length;
      continue;
    }

    const sectionParts = block.split(SECTION_SPLIT_RE);
    const introRegion = sectionParts[0];
    const { label, afterLabel } = chapterLabelOf(introRegion);
    const chapterLabel = label;
    const url = chapterUrlOf(block, chapterNum);
    const baseCrumb = `Title 26 (LA County Building Code) > ${chapterLabel}`;

    const push = (
      texts: string[],
      section: string,
      sectionNum: string,
      breadcrumb: string,
    ): void => {
      texts.forEach((t, i) => {
        const chunk: Chunk = {
          id: `ch${chapterNum.toLowerCase()}-s${sectionNum || "intro"}-${i}`,
          chapter: chapterLabel,
          chapterNum,
          section,
          sectionNum,
          breadcrumb,
          url,
          charLen: t.length,
          text: t,
        };
        chunks.push(chunk);
        stats.coverageChars += t.length;
        stats.perChapter.set(chapterNum, (stats.perChapter.get(chapterNum) || 0) + 1);
      });
    };

    // Chapter intro: content after the label, boilerplate municode links stripped.
    // A chapter with no SECTION markers (e.g. Chapter 2 - DEFINITIONS) keeps its
    // intro regardless of the 200-char floor so no chapter vanishes from the index.
    const introText = collapseSpaces(afterLabel.replace(MUNICODE_MD_LINK_RE, " ")).trim();
    const minIntroChars = sectionParts.length === 1 ? 1 : 200;
    if (introText.length >= minIntroChars) {
      const introChunks = packBody(introText, hs);
      push(introChunks, "", "", `${baseCrumb} > (chapter introduction)`);
    }

    // Sections.
    for (let i = 1; i < sectionParts.length; i++) {
      const part = sectionParts[i];
      const sectionNum = sectionNumOf(part);
      const sectionName = sectionNameOf(part);
      const sectionLabel = sectionName
        ? `SECTION ${sectionNum} - ${sectionName}`
        : `SECTION ${sectionNum}`;
      if (sectionNum) stats.sectionNums.add(sectionNum);
      const sectionChunks = packBody(part, hs);
      push(sectionChunks, sectionLabel, sectionNum, `${baseCrumb} > ${sectionLabel}`);
    }
  }

  stats.hardSplit = hs.count;
  return { chunks, stats };
}

/* ------------------------------- embedding ------------------------------- */

interface ProviderChoice {
  provider: "openrouter" | "google" | "none";
  model: string;
  dims: number;
  normalized: boolean;
  taskType?: string;
  apiKey?: string;
  keyLabel?: string;
}

const EMBED_MODEL = process.env.OR_EMBEDDING_MODEL || "google/gemini-embedding-001";
const GOOGLE_MODEL = "gemini-embedding-001";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Retry on 429/5xx/network with backoff 600 * 2^n ms (cap 6s), 4 tries.
// Other statuses (e.g. 402/400) are returned so the caller can inspect them.
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastErr: unknown;
  for (let n = 0; n < 4; n++) {
    try {
      const res = await fetch(url, init);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
      } else {
        return res;
      }
    } catch (e) {
      lastErr = e;
    }
    if (n < 3) await sleep(Math.min(600 * 2 ** n, 6000));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

interface PreflightResult {
  ok: boolean;
  status?: number;
  detail?: string;
}

async function preflightOpenRouter(sample: string, apiKey: string): Promise<PreflightResult> {
  try {
    const res = await fetchWithRetry("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: EMBED_MODEL, input: [sample], dimensions: 768 }),
    });
    if (res.status !== 200) {
      return { ok: false, status: res.status, detail: (await res.text()).slice(0, 300) };
    }
    const json = await res.json();
    const vec = json?.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length === 0) {
      return { ok: false, status: 200, detail: "unexpected response shape (no data[0].embedding)" };
    }
    return { ok: true, status: 200 };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

async function preflightGoogle(sample: string, apiKey: string): Promise<PreflightResult> {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GOOGLE_MODEL}:batchEmbedContents?key=${apiKey}`;
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            model: `models/${GOOGLE_MODEL}`,
            content: { parts: [{ text: sample }] },
            outputDimensionality: 768,
            taskType: "RETRIEVAL_DOCUMENT",
          },
        ],
      }),
    });
    if (res.status !== 200) {
      return { ok: false, status: res.status, detail: (await res.text()).slice(0, 300) };
    }
    const json = await res.json();
    const vec = json?.embeddings?.[0]?.values;
    if (!Array.isArray(vec) || vec.length === 0) {
      return { ok: false, status: 200, detail: "unexpected response shape (no embeddings[0].values)" };
    }
    return { ok: true, status: 200 };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

// Walk the provider ladder using one sample input. Throws an actionable error if
// no provider works (callers pass --no-embed to skip embedding entirely).
async function chooseProvider(sample: string): Promise<ProviderChoice> {
  const errors: string[] = [];

  const orKey = process.env.OPENROUTER_API_KEY;
  if (orKey) {
    const r = await preflightOpenRouter(sample, orKey);
    if (r.ok) {
      return { provider: "openrouter", model: EMBED_MODEL, dims: 768, normalized: true, apiKey: orKey, keyLabel: "OPENROUTER_API_KEY" };
    }
    errors.push(`OpenRouter embeddings failed (HTTP ${r.status ?? "network"}): ${r.detail ?? ""}`);
  } else {
    errors.push("OpenRouter skipped: OPENROUTER_API_KEY not set.");
  }

  for (const label of ["GEMINI_API_KEY", "GOOGLE_API_KEY"]) {
    const key = process.env[label];
    if (!key) {
      errors.push(`Google skipped: ${label} not set.`);
      continue;
    }
    const r = await preflightGoogle(sample, key);
    if (r.ok) {
      return { provider: "google", model: GOOGLE_MODEL, dims: 768, normalized: true, taskType: "RETRIEVAL_DOCUMENT", apiKey: key, keyLabel: label };
    }
    errors.push(`Google embeddings via ${label} failed (HTTP ${r.status ?? "network"}): ${r.detail ?? ""}`);
  }

  throw new Error(
    "No embedding provider available.\n" +
      errors.map((e) => "  - " + e).join("\n") +
      "\n\nFix: purchase OpenRouter credits (its /embeddings ignores BYOK) OR set a valid " +
      "GEMINI_API_KEY / GOOGLE_API_KEY in .env.local, then re-run without --no-embed. " +
      "To build the index structure without vectors now, pass --no-embed.",
  );
}

async function embedBatch(texts: string[], choice: ProviderChoice): Promise<number[][]> {
  if (choice.provider === "openrouter") {
    const res = await fetchWithRetry("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${choice.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts, dimensions: 768 }),
    });
    if (res.status !== 200) {
      throw new Error(`OpenRouter embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const json = await res.json();
    return (json.data as Array<{ embedding: number[] }>).map((d) => d.embedding);
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GOOGLE_MODEL}:batchEmbedContents?key=${choice.apiKey}`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: texts.map((text) => ({
        model: `models/${GOOGLE_MODEL}`,
        content: { parts: [{ text }] },
        outputDimensionality: 768,
        taskType: "RETRIEVAL_DOCUMENT",
      })),
    }),
  });
  if (res.status !== 200) {
    throw new Error(`Google embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = await res.json();
  return (json.embeddings as Array<{ values: number[] }>).map((e) => e.values);
}

// Truncate to 768 (valid MRL), L2-normalize, encode as base64 LE Float32. Also
// returns the pre-normalization norm for reporting.
function encodeVector(raw: number[]): { b64: string; normBefore: number } {
  const v = raw.length > 768 ? raw.slice(0, 768) : raw;
  let sum = 0;
  for (const x of v) sum += x * x;
  const normBefore = Math.sqrt(sum);
  const norm = normBefore > 0 ? normBefore : 1;
  const unit = v.map((x) => x / norm);
  const b64 = Buffer.from(new Float32Array(unit).buffer).toString("base64");
  return { b64, normBefore };
}

async function embedAll(chunks: Chunk[], choice: ProviderChoice): Promise<void> {
  const BATCH = 16;
  const normsBefore: number[] = [];
  const normsAfter: number[] = [];
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const inputs = batch.map((c) => `${c.breadcrumb}\n\n${c.text}`);
    const vecs = await embedBatch(inputs, choice);
    batch.forEach((c, j) => {
      const { b64, normBefore } = encodeVector(vecs[j]);
      c.vec = b64;
      normsBefore.push(normBefore);
      // Recompute post-normalization norm for the assertion / log.
      const buf = Buffer.from(b64, "base64");
      const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      let s = 0;
      for (const x of f) s += x * x;
      normsAfter.push(Math.sqrt(s));
    });
    if (i + BATCH < chunks.length) await sleep(200);
    process.stdout.write(`\r  embedded ${Math.min(i + BATCH, chunks.length)}/${chunks.length}`);
  }
  process.stdout.write("\n");
  const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  console.log(`  mean L2 norm before normalization: ${mean(normsBefore).toFixed(4)} (expected != 1.0)`);
  console.log(`  mean L2 norm after normalization:  ${mean(normsAfter).toFixed(4)} (expected 1.0)`);
}

/* --------------------------------- main --------------------------------- */

async function main(): Promise<void> {
  const started = Date.now();
  const noEmbed = process.argv.includes("--no-embed");
  loadEnvLocal();

  if (!existsSync(CORPUS_PATH)) {
    throw new Error(`Corpus not found at ${CORPUS_PATH}`);
  }
  const raw = readFileSync(CORPUS_PATH);
  const corpusHash = createHash("sha256").update(raw).digest("hex");
  const text = raw.toString("utf8");

  const { chunks, stats } = buildChunks(text);

  // Provider selection.
  let choice: ProviderChoice;
  if (noEmbed) {
    choice = { provider: "none", model: EMBED_MODEL, dims: 0, normalized: false };
    console.log("Provider: none (--no-embed) — emitting index structure without vectors.");
  } else {
    console.log("Selecting embedding provider (preflight)...");
    choice = await chooseProvider(`${chunks[0].breadcrumb}\n\n${chunks[0].text}`);
    console.log(`Provider: ${choice.provider} (model ${choice.model}, key ${choice.keyLabel})`);
    await embedAll(chunks, choice);
  }

  // ------- self-checks (fail loudly before writing) -------
  const oversize = chunks.filter((c) => c.charLen > MAX_CHARS);
  if (oversize.length > 0) {
    throw new Error(`ASSERT FAILED: ${oversize.length} chunk(s) exceed MAX_CHARS (${MAX_CHARS}). All windows must be <= MAX_CHARS.`);
  }
  if (stats.sectionNums.size < 140) {
    throw new Error(`ASSERT FAILED: distinct sectionNum count ${stats.sectionNums.size} < 140 (expected ~150).`);
  }
  const appendixAChunks = chunks.filter((c) => c.chapter.startsWith("APPENDIX A"));
  if (appendixAChunks.length > 0) {
    throw new Error(`ASSERT FAILED: ${appendixAChunks.length} chunk(s) from APPENDIX A; that block must be skipped.`);
  }
  const coverageDenom = text.length - stats.appendixAChars;
  const coverage = stats.coverageChars / coverageDenom;
  if (coverage < 0.9) {
    throw new Error(`ASSERT FAILED: coverage ${(coverage * 100).toFixed(1)}% < 90% (dropped content).`);
  }
  if (!noEmbed) {
    const badVec = chunks.filter((c) => !c.vec || c.vec.length !== 4096);
    if (badVec.length > 0) {
      throw new Error(`ASSERT FAILED: ${badVec.length} chunk(s) have a vec that is not exactly 4096 base64 chars.`);
    }
  }

  // ------- write index -------
  const index: IndexFile = {
    version: 1,
    model: choice.model,
    provider: choice.provider,
    dims: choice.dims,
    normalized: choice.normalized,
    ...(choice.provider === "google" ? { taskType: choice.taskType } : {}),
    corpusFile: CORPUS_FILE,
    corpusHash,
    createdAt: new Date().toISOString(),
    chunkCount: chunks.length,
    chunks,
  };
  writeFileSync(OUTPUT_PATH, JSON.stringify(index));

  // ------- report -------
  const lens = chunks.map((c) => c.charLen);
  const min = Math.min(...lens);
  const max = Math.max(...lens);
  const mean = Math.round(lens.reduce((a, b) => a + b, 0) / lens.length);
  const fileSize = statSync(OUTPUT_PATH).size;

  console.log("\n=== Title 26 index built ===");
  console.log(`provider:            ${choice.provider}`);
  console.log(`chunkCount:          ${chunks.length}`);
  console.log(`charLen min/max/mean:${min} / ${max} / ${mean}`);
  console.log(`hard-split windows:  ${stats.hardSplit}`);
  console.log(`distinct sections:   ${stats.sectionNums.size}`);
  console.log(`coverage:            ${(coverage * 100).toFixed(1)}% of corpus minus Appendix A (${coverageDenom} chars)`);
  console.log(`index file size:     ${fileSize} bytes (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
  console.log("per-chapter chunk counts:");
  for (const [num, count] of stats.perChapter) {
    console.log(`  ${num.padEnd(4)} ${count}`);
  }
  console.log(`elapsed:             ${Date.now() - started} ms`);

  // ------- QA samples -------
  const printSample = (label: string, c: Chunk | undefined): void => {
    if (!c) {
      console.log(`\n[QA ${label}] (not found)`);
      return;
    }
    console.log(`\n[QA ${label}] id=${c.id}`);
    console.log(`  breadcrumb: ${c.breadcrumb}`);
    console.log(`  text[0:200]: ${c.text.slice(0, 200)}`);
  };
  printSample("CH10 S1031", chunks.find((c) => c.chapterNum === "10" && c.sectionNum === "1031"));
  printSample("APPENDIX J", chunks.find((c) => c.chapterNum === "J"));
}

main().catch((e) => {
  console.error("\nbuild-municode-index failed:\n" + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
