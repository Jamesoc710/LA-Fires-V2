// Runtime retrieval over the committed Title 26 (LA County Building Code) RAG
// index (context/municode_index.json, built by scripts/build-municode-index.ts).
//
// Two retrieval modes:
//   - semantic: when the index carries per-chunk embeddings (provider google /
//     openrouter). We embed the query with the SAME provider, then cosine
//     (dot-product on pre-normalized vectors) rank.
//   - lexical: when the index has no vectors (provider 'none') OR query
//     embedding fails/times out. A cheap term-overlap scorer, no network.
//
// Every failure mode degrades to null (no retrieval) so the chat route is never
// blocked by a bad/missing index.

import fs from 'fs';
import path from 'path';

export type Citation = { chapter: string; section: string; url?: string };

const K = 5;
const MIN_SIMILARITY = 0.35;
const EXCERPT_CHAR_BUDGET = 24_000;
const QUERY_EMBED_TIMEOUT_MS = 2500;
const MIN_LEXICAL_HITS = 2;

type LoadedChunk = {
  id: string;
  chapter: string;
  chapterNum: string;
  section: string;
  sectionNum: string;
  breadcrumb: string;
  url: string;
  charLen: number;
  text: string;
  vec?: Float32Array;
};

type LoadedIndex = {
  version: number;
  model: string;
  provider: 'openrouter' | 'google' | 'none';
  dims: number;
  normalized: boolean;
  chunks: LoadedChunk[];
};

type RawChunk = Omit<LoadedChunk, 'vec'> & { vec?: string };
type RawIndex = Omit<LoadedIndex, 'chunks'> & { chunks: RawChunk[] };

/* ------------------------------ index loading ----------------------------- */

// Shared across concurrent first-loads: assigned synchronously so the readFile
// happens once even under a burst of simultaneous requests.
let indexPromise: Promise<LoadedIndex | null> | null = null;

async function loadIndexUncached(): Promise<LoadedIndex | null> {
  try {
    const raw = await fs.promises.readFile(
      path.join(process.cwd(), 'context', 'municode_index.json'),
      'utf8',
    );
    const parsed = JSON.parse(raw) as RawIndex;

    // Decode each chunk's base64 little-endian Float32 vector ONCE.
    const chunks: LoadedChunk[] = (parsed.chunks || []).map((c) => {
      let vec: Float32Array | undefined;
      if (typeof c.vec === 'string' && c.vec) {
        const buf = Buffer.from(c.vec, 'base64');
        vec = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      }
      return {
        id: c.id,
        chapter: c.chapter,
        chapterNum: c.chapterNum,
        section: c.section,
        sectionNum: c.sectionNum,
        breadcrumb: c.breadcrumb,
        url: c.url,
        charLen: c.charLen,
        text: c.text,
        vec,
      };
    });

    return {
      version: parsed.version,
      model: parsed.model,
      provider: parsed.provider,
      dims: parsed.dims,
      normalized: parsed.normalized,
      chunks,
    };
  } catch (err) {
    console.warn('[municodeIndex] failed to load index:', err);
    return null;
  }
}

function getIndex(): Promise<LoadedIndex | null> {
  if (!indexPromise) indexPromise = loadIndexUncached();
  return indexPromise;
}

/* ------------------------------ query embed ------------------------------- */

// Truncate to 768 dims (valid MRL length) and L2-normalize into a Float32Array.
function normalizeVec(raw: number[]): Float32Array {
  const v = raw.length > 768 ? raw.slice(0, 768) : raw;
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

// Embed the query with the index's OWN provider only — mixing providers would
// compare vectors from different embedding spaces. Any failure returns null so
// the caller falls back to lexical (never to the other provider).
async function embedQuery(query: string, index: LoadedIndex): Promise<Float32Array | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUERY_EMBED_TIMEOUT_MS);
  try {
    let raw: unknown = null;

    if (index.provider === 'openrouter') {
      const key = process.env.OPENROUTER_API_KEY;
      if (!key) return null;
      const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: index.model, input: [query], dimensions: 768 }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const json = await res.json();
      raw = json?.data?.[0]?.embedding ?? null;
    } else if (index.provider === 'google') {
      const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
      if (!key) return null;
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${key}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: { parts: [{ text: query }] },
          outputDimensionality: 768,
          taskType: 'RETRIEVAL_QUERY',
        }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const json = await res.json();
      raw = json?.embedding?.values ?? null;
    }

    if (!Array.isArray(raw) || raw.length === 0) return null;
    return normalizeVec(raw as number[]);
  } catch {
    // timeout / abort / network / parse error → lexical fallback
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------- scoring --------------------------------- */

// Dot product over pre-normalized vectors == cosine similarity.
function semanticSelect(qVec: Float32Array, chunks: LoadedChunk[]): LoadedChunk[] {
  const scored: { chunk: LoadedChunk; score: number }[] = [];
  for (const chunk of chunks) {
    const vec = chunk.vec;
    if (!vec) continue;
    const n = Math.min(qVec.length, vec.length);
    let dot = 0;
    for (let i = 0; i < n; i++) dot += qVec[i] * vec[i];
    if (dot >= MIN_SIMILARITY) scored.push({ chunk, score: dot });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, K).map((s) => s.chunk);
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'what', 'are', 'can', 'you', 'not', 'with', 'this', 'that',
  'have', 'from', 'requirements', 'required', 'need', 'building', 'county', 'los',
  'angeles', 'property', 'house', 'home', 'rebuild', 'fire', 'fires',
]);

function tokenize(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const t of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length < 3 || STOPWORDS.has(t) || seen.has(t)) continue;
    seen.add(t);
    terms.push(t);
  }
  return terms;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function lexicalSelect(query: string, chunks: LoadedChunk[]): LoadedChunk[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const scored: { chunk: LoadedChunk; score: number }[] = [];
  for (const chunk of chunks) {
    const breadcrumbLower = chunk.breadcrumb.toLowerCase();
    const combined = (chunk.breadcrumb + '\n' + chunk.text).toLowerCase();
    let hits = 0;
    let score = 0;
    for (const term of terms) {
      const occ = countOccurrences(combined, term);
      if (occ === 0) continue;
      hits++;
      const base = Math.min(occ, 3);
      // Matches in the breadcrumb (chapter/section headings) count double.
      score += breadcrumbLower.includes(term) ? base * 2 : base;
    }
    if (hits >= MIN_LEXICAL_HITS) scored.push({ chunk, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, K).map((s) => s.chunk);
}

/* --------------------------------- result --------------------------------- */

function buildResult(
  selected: LoadedChunk[],
): { excerptsBlock: string; citations: Citation[] } | null {
  if (selected.length === 0) return null;

  let excerptsBlock = '';
  let n = 0;
  const seen = new Set<string>();
  const citations: Citation[] = [];

  for (const chunk of selected) {
    const piece =
      `[Excerpt ${n + 1}] ${chunk.breadcrumb}\n${chunk.text}\n(Source: ${chunk.url})\n\n`;
    if (excerptsBlock.length + piece.length > EXCERPT_CHAR_BUDGET) break;
    excerptsBlock += piece;
    n++;

    const key = chunk.chapter + '§' + chunk.sectionNum;
    if (!seen.has(key)) {
      seen.add(key);
      citations.push({
        chapter: chunk.chapter,
        section: chunk.section || '(chapter introduction)',
        url: chunk.url,
      });
    }
  }

  if (n === 0) return null;
  return { excerptsBlock, citations };
}

/* --------------------------------- public --------------------------------- */

export async function retrieveMunicode(
  query: string,
): Promise<{ excerptsBlock: string; citations: Citation[] } | null> {
  try {
    const index = await getIndex();
    if (!index) return null;

    const hasVecs = index.provider !== 'none' && index.chunks.some((c) => c.vec);

    let selected: LoadedChunk[];
    if (hasVecs) {
      const qVec = await embedQuery(query, index);
      selected = qVec ? semanticSelect(qVec, index.chunks) : lexicalSelect(query, index.chunks);
    } else {
      selected = lexicalSelect(query, index.chunks);
    }

    return buildResult(selected);
  } catch (err) {
    console.warn('[municodeIndex] retrieveMunicode failed:', err);
    return null;
  }
}
