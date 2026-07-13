/**
 * Scripted demo capture for the LA Fires chat UI.
 *
 * Run: `npx tsx scripts/record-demo/record.ts` (assumes the built app is
 * already serving at http://localhost:3000 — you manage `npm start`).
 *
 * Records a headless Chromium session through a THREE-beat conversation
 * (parcel lookup -> assessor follow-up -> Title 26 code question with amber
 * citation chips) and writes ms-offset markers so `polish.sh` can trim +
 * speed-ramp the raw webm. All app state is gated on DOM signals (never fixed
 * sleeps for LLM output) because the narrative streams live and its length/
 * timing vary.
 *
 * DOM signals used (derived from app/components/chat/*):
 *   - input:            input[aria-label="Message input"]  (disabled === isLoading)
 *   - loading states:   [aria-label="Looking up parcel data"] (CardsSkeleton)
 *                       [aria-label="Assistant is thinking"]  (typing dots)
 *   - data cards:       <h3> exact text "Zoning" / "Overlays" / "Assessor"
 *   - card narrative:   `.prose` block inside the assistant `.flex.justify-start`
 *                       bubble that owns the card heading
 *   - code answer:      a Title 26 question yields NO cards (all sections
 *                       "skipped"), so CardsBubble falls back to MarkdownBubble
 *                       — a plain `.prose` bubble with a CitationChips row. The
 *                       chips ride the FIRST (meta) frame, so they paint at
 *                       stream start, before any answer text.
 *   - citations:        <span> "Code sections" label + amber § chips
 *                       (CitationChips), scoped to the MarkdownBubble root
 *                       (`.space-y-3`).
 */
import { chromium, type Browser, type BrowserContext, type Page, type Locator } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, renameSync, writeFileSync, readdirSync } from 'node:fs';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out');
const BASE = process.env.DEMO_BASE_URL ?? 'http://localhost:3000';
const CHAT_URL = `${BASE}/chat`;
const STORAGE_KEY = 'lafires.chat.v2';
const INPUT_SEL = 'input[aria-label="Message input"]';

// NOTE ON FRAMING: Playwright 1.61 recordVideo captures at the CSS-pixel
// viewport resolution and only scales DOWN to fit `size` (deviceScaleFactor is
// NOT applied to the video frame). The captured webm is therefore exactly the
// CSS viewport size. Take 1 shot 1600x1000 and left a sparse dead right third;
// take 2 tightens to 1280x800 (same 1.6 aspect) so the chat column fills the
// frame. DSF 2 still supersamples text for crisp anti-aliasing on downsample.
const VIEWPORT = { width: 1280, height: 800 };
const DEVICE_SCALE_FACTOR = 2;
const VIDEO_SIZE = { width: 1280, height: 800 };

const QUERY_1 = 'What can I rebuild at 5314 La Crescenta Ave?';
const QUERY_2 = 'when was it built?';
const QUERY_3 = 'what are the egress window requirements for a bedroom?';
const GREETING_FRAGMENT = 'navigate Los Angeles building codes';

// ---- in-page DOM predicates (real functions; tsx strips TS, Playwright
// serializes the resulting JS). ------------------------------------------
function hasZoningAndOverlays(): boolean {
  const t = Array.from(document.querySelectorAll('h3')).map(h => (h.textContent || '').trim());
  return t.includes('Zoning') && t.includes('Overlays');
}
function hasAssessorCard(): boolean {
  return Array.from(document.querySelectorAll('h3')).some(h => (h.textContent || '').trim() === 'Assessor');
}
function narrativeReady(heading: string): boolean {
  const h = Array.from(document.querySelectorAll('h3')).find(x => (x.textContent || '').trim() === heading);
  const bubble = h && h.closest('.flex.justify-start');
  const prose = bubble && bubble.querySelector('.prose');
  return !!prose && (prose as HTMLElement).innerText.trim().length > 0;
}
function narrativeLen(heading: string): number {
  const h = Array.from(document.querySelectorAll('h3')).find(x => (x.textContent || '').trim() === heading);
  const bubble = h && h.closest('.flex.justify-start');
  const prose = bubble && bubble.querySelector('.prose');
  return prose ? (prose as HTMLElement).innerText.trim().length : 0;
}
function inputEnabled(): boolean {
  const i = document.querySelector('input[aria-label="Message input"]') as HTMLInputElement | null;
  return !!i && !i.disabled;
}
function inputDisabled(): boolean {
  const i = document.querySelector('input[aria-label="Message input"]') as HTMLInputElement | null;
  return !!i && i.disabled;
}
// Beat 3: the flagship visual. A code question renders a MarkdownBubble with a
// CitationChips row: a "Code sections" label span followed by amber § chips.
// True once the label AND at least one chip sibling are in the DOM. Scoped to
// the LAST such row so earlier beats (which carry no citations) can't match.
function hasCitationChips(): boolean {
  const labels = Array.from(document.querySelectorAll('span')).filter(
    s => (s.textContent || '').trim() === 'Code sections'
  );
  if (labels.length === 0) return false;
  const row = labels[labels.length - 1].parentElement; // CitationChips flex row
  return !!row && row.childElementCount > 1; // label + >=1 chip
}
// Answer-text length of the beat-3 MarkdownBubble, found via its CitationChips
// row (the chips ride the meta frame, so the row exists before the text does).
// Returns -1 until the row is present so the stability wait keeps polling
// instead of latching onto an earlier beat's settled prose.
function codeAnswerLen(): number {
  const labels = Array.from(document.querySelectorAll('span')).filter(
    s => (s.textContent || '').trim() === 'Code sections'
  );
  if (labels.length === 0) return -1;
  const bubble = labels[labels.length - 1].closest('.space-y-3'); // MarkdownBubble root
  const prose = bubble && bubble.querySelector('.prose');
  return prose ? (prose as HTMLElement).innerText.trim().length : -1;
}

type Markers = Record<string, number>;

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });

  // --- cache warm-up: a SEPARATE, non-recorded context runs the full flow
  // once so the GIS lookups (address + assessor) are cached server-side and
  // the cards paint fast on the recorded take. Also validates selectors.
  // (DEMO_SKIP_WARMUP=1 skips it when the server cache is already warm.)
  if (process.env.DEMO_SKIP_WARMUP === '1') {
    console.log('[warmup] skipped (DEMO_SKIP_WARMUP=1)');
  } else {
    console.log('[warmup] running full flow (non-recorded) to warm GIS cache...');
    await warmup(browser);
    console.log('[warmup] done');
  }

  // --- the recorded take -------------------------------------------------
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    colorScheme: 'dark',
    recordVideo: { dir: OUT_DIR, size: VIDEO_SIZE },
  });
  const page = await context.newPage();
  // recordVideo starts at page creation -> t0 is our recording origin.
  const t0 = Date.now();
  const markers: Markers = {};
  const mark = (name: string) => {
    markers[name] = Date.now() - t0;
    console.log(`[mark] ${name} = ${markers[name]}ms`);
  };

  const video = page.video();
  try {
    await preparePage(page);
    await runTake(page, mark);
  } finally {
    await context.close(); // finalizes the webm
  }

  // rename produced webm -> capture.webm
  let videoPath = video ? await video.path().catch(() => null) : null;
  if (!videoPath) {
    const webm = readdirSync(OUT_DIR).find(f => f.endsWith('.webm') && f !== 'capture.webm');
    videoPath = webm ? join(OUT_DIR, webm) : null;
  }
  if (videoPath) {
    renameSync(videoPath, join(OUT_DIR, 'capture.webm'));
    console.log('[video] ->', join(OUT_DIR, 'capture.webm'));
  } else {
    console.warn('[video] could not locate produced webm');
  }

  writeFileSync(join(OUT_DIR, 'markers.json'), JSON.stringify(markers, null, 2) + '\n');
  console.log('[markers]', JSON.stringify(markers));

  await browser.close();
}

// Reset localStorage so the greeting + suggested prompts show, then confirm
// the greeting and self-hosted fonts are ready before we start the take.
async function preparePage(page: Page) {
  await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(key => localStorage.removeItem(key), STORAGE_KEY);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText(GREETING_FRAGMENT, { exact: false }).waitFor({ timeout: 15000 });
  await page.evaluate(() => (document as unknown as { fonts?: { ready: Promise<unknown> } }).fonts?.ready);
  await page.waitForTimeout(300);
}

async function runTake(page: Page, mark: (name: string) => void) {
  const input = page.locator(INPUT_SEL);

  // ---- Beat 1 ----------------------------------------------------------
  mark('takeStart');
  await page.waitForTimeout(800); // brief opening beat

  mark('type1Start');
  await input.click();
  await typeWithJitter(page, input, QUERY_1);
  await page.waitForTimeout(1000);
  await input.press('Enter');
  mark('submit1');

  // skeleton/loading appears (best-effort; may flash fast with a warm cache)
  await page.waitForFunction(inputDisabled, undefined, { timeout: 15000 }).catch(() => {});

  // zoning + overlays cards painted
  await page.waitForFunction(hasZoningAndOverlays, undefined, { timeout: 90000 });
  mark('cards1Painted');

  // narrative first token
  await page.waitForFunction(narrativeReady, 'Zoning', { timeout: 90000 });
  mark('stream1Start');

  // streaming settled: loading indicator gone (isLoading -> input enabled)
  // AND narrative length stable ~1.5s
  await page.waitForFunction(inputEnabled, undefined, { timeout: 120000 });
  await waitNarrativeStable(page, 'Zoning', 1500, 120000);
  mark('stream1End');

  await page.waitForTimeout(2000); // settle beat (beat 1 carries no chips)

  // ---- Beat 2: assessor follow-up (YEAR BUILT 1951) --------------------
  mark('type2Start');
  await input.click();
  await typeWithJitter(page, input, QUERY_2);
  await page.waitForTimeout(1000);
  await input.press('Enter');
  mark('submit2');

  await page.waitForFunction(inputDisabled, undefined, { timeout: 15000 }).catch(() => {});

  await page.waitForFunction(hasAssessorCard, undefined, { timeout: 90000 });
  mark('assessor2Painted');

  await page.waitForFunction(narrativeReady, 'Assessor', { timeout: 90000 });
  mark('stream2Start');

  await page.waitForFunction(inputEnabled, undefined, { timeout: 120000 });
  await waitNarrativeStable(page, 'Assessor', 1500, 120000);
  mark('stream2End');

  await page.waitForTimeout(2000); // settle beat, transition to the money shot

  // ---- Beat 3: Title 26 code question -> amber citation chips ----------
  mark('type3Start');
  await input.click();
  await typeWithJitter(page, input, QUERY_3);
  await page.waitForTimeout(1000);
  await input.press('Enter');
  mark('submit3');

  await page.waitForFunction(inputDisabled, undefined, { timeout: 15000 }).catch(() => {});

  // Chips ride the meta frame -> they paint at stream start, before answer text.
  await page.waitForFunction(hasCitationChips, undefined, { timeout: 90000 });
  mark('chips3Painted');

  // Streaming settled: loading indicator gone AND the code answer text stable.
  await page.waitForFunction(inputEnabled, undefined, { timeout: 120000 });
  await waitCodeAnswerStable(page, 1500, 120000);

  // Center the chips so the polish push-in lands on them, then mark the shot.
  await scrollCitationsIntoView(page);
  mark('stream3End');

  await page.waitForTimeout(2600); // static final hold — polish zooms this span
  mark('takeEnd');

  // Extra buffer so context.close() doesn't finalize the webm mid-hold
  // (take 1's takeEnd overran the capture by ~0.9s and clipped the last frames).
  await page.waitForTimeout(1500);
}

// Type one character at a time with a jittered per-key delay (105ms +/-40ms).
// The deliberate cadence reads as a human composing the query and keeps the
// (un-ramped) typing on screen long enough to land the cut in the 35-45s band.
async function typeWithJitter(page: Page, input: Locator, text: string) {
  for (const ch of text) {
    await input.pressSequentially(ch, { delay: 0 });
    const d = 105 + (Math.random() * 2 - 1) * 40;
    await page.waitForTimeout(Math.max(15, Math.round(d)));
  }
}

// Settled once the narrative text length for `heading` is unchanged for stableMs.
async function waitNarrativeStable(page: Page, heading: string, stableMs: number, timeout: number) {
  const start = Date.now();
  let last = -1;
  let lastChange = Date.now();
  while (Date.now() - start < timeout) {
    const len = await page.evaluate(narrativeLen, heading);
    const now = Date.now();
    if (len !== last) {
      last = len;
      lastChange = now;
    } else if (now - lastChange >= stableMs) {
      return;
    }
    await page.waitForTimeout(200);
  }
}

// Beat 3 has no card heading, so settle on the MarkdownBubble's answer length.
// codeAnswerLen returns -1 until the chips row exists; -1 never counts as
// "stable" so we can't latch onto an earlier beat's prose before the answer.
async function waitCodeAnswerStable(page: Page, stableMs: number, timeout: number) {
  const start = Date.now();
  let last = -2;
  let lastChange = Date.now();
  while (Date.now() - start < timeout) {
    const len = await page.evaluate(codeAnswerLen);
    const now = Date.now();
    if (len !== last || len < 0) {
      last = len;
      lastChange = now;
    } else if (now - lastChange >= stableMs) {
      return;
    }
    await page.waitForTimeout(200);
  }
}

async function scrollCitationsIntoView(page: Page) {
  const has = await page.evaluate(() =>
    Array.from(document.querySelectorAll('span')).some(s => (s.textContent || '').trim() === 'Code sections')
  );
  if (!has) {
    console.log('[citations] none present');
    return;
  }
  await page.evaluate(() => {
    const label = Array.from(document.querySelectorAll('span')).find(
      s => (s.textContent || '').trim() === 'Code sections'
    );
    label?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  await page.waitForTimeout(900); // let the smooth scroll finish
}

// Full two-beat flow in a throwaway context to prime the GIS cache.
async function warmup(browser: Browser) {
  const ctx: BrowserContext = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    colorScheme: 'dark',
  });
  const page = await ctx.newPage();
  try {
    await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded' });
    await page.evaluate(key => localStorage.removeItem(key), STORAGE_KEY);
    await page.reload({ waitUntil: 'networkidle' });
    const input = page.locator(INPUT_SEL);

    await input.click();
    await input.fill(QUERY_1);
    await input.press('Enter');
    await page.waitForFunction(hasZoningAndOverlays, undefined, { timeout: 90000 });
    await page.waitForFunction(inputEnabled, undefined, { timeout: 120000 });

    await input.click();
    await input.fill(QUERY_2);
    await input.press('Enter');
    await page.waitForFunction(hasAssessorCard, undefined, { timeout: 90000 });
    await page.waitForFunction(inputEnabled, undefined, { timeout: 120000 });

    // Beat 3 warms nothing parcel-cached (RAG re-embeds + re-runs the LLM every
    // time), but it validates the citation-chip selector before a recorded take.
    await input.click();
    await input.fill(QUERY_3);
    await input.press('Enter');
    await page.waitForFunction(hasCitationChips, undefined, { timeout: 90000 });
    await page.waitForFunction(inputEnabled, undefined, { timeout: 120000 });
  } finally {
    await ctx.close();
  }
}

main().catch(err => {
  console.error('[record] failed:', err);
  process.exit(1);
});
