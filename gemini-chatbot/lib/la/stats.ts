// lib/la/stats.ts
// Anonymous, aggregate daily usage counters. Keys hold pure integers only — no
// IPs, APNs, or per-user data. Everything fails open: with no Redis configured,
// or on any error, these helpers silently no-op so they can never break a request.

import { getRedis } from "./redis";

export type DailyMetric = "chats_started" | "lookups_ok" | "llm_fallback" | "errors";

const DAILY_METRICS: DailyMetric[] = ["chats_started", "lookups_ok", "llm_fallback", "errors"];

// 90-day retention: counters self-expire so old days don't accumulate forever.
const NINETY_DAYS_SECONDS = 90 * 24 * 60 * 60;

// YYYY-MM-DD for a date in America/Los_Angeles. The daily boundary aligns with
// the Gemini free-tier quota reset at midnight PT. en-CA formats as ISO YYYY-MM-DD.
function laDateKey(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function statKey(metric: DailyMetric, day: string): string {
  return `lafires:stats:${metric}:${day}`;
}

// The last `days` LA calendar-day keys (oldest first, ending today). Anchored at
// noon UTC of the current LA day so stepping back whole days never slips across a
// DST boundary (a 1-hour shift around midday stays within the same calendar day).
function laDayKeysBack(days: number): string[] {
  const [y, m, d] = laDateKey().split("-").map(Number);
  const anchor = Date.UTC(y, m - 1, d, 12, 0, 0);
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    keys.push(laDateKey(new Date(anchor - i * 86_400_000)));
  }
  return keys;
}

/**
 * Increment today's counter for `metric`. First write of the day sets a 90-day
 * TTL so the key self-expires. Fails open (no Redis / any error => no-op).
 */
export async function incrementDailyStat(metric: DailyMetric): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    const key = statKey(metric, laDateKey());
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, NINETY_DAYS_SECONDS);
  } catch {
    // best-effort telemetry — never surface to the request
  }
}

/**
 * Read the last `days` days of all four counters via a single MGET. Missing days
 * resolve to 0. Returns null when Redis is unconfigured or on error.
 * Shape: { [metric]: { [YYYY-MM-DD]: count } }.
 */
export async function getDailyStats(
  days = 7
): Promise<Record<DailyMetric, Record<string, number>> | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const dayKeys = laDayKeysBack(days);
    // Flatten metric x day into one key list for a single round trip.
    const redisKeys = DAILY_METRICS.flatMap(metric => dayKeys.map(day => statKey(metric, day)));
    const values = await redis.mget<(number | string | null)[]>(redisKeys);

    const result = {} as Record<DailyMetric, Record<string, number>>;
    let idx = 0;
    for (const metric of DAILY_METRICS) {
      const perDay: Record<string, number> = {};
      for (const day of dayKeys) {
        const raw = values[idx++];
        const n = raw == null ? 0 : Number(raw);
        perDay[day] = Number.isFinite(n) ? n : 0;
      }
      result[metric] = perDay;
    }
    return result;
  } catch {
    return null;
  }
}

/** Map a request outcome to the counter it increments. */
export function statForOutcome(outcome: "ok" | "llm_fallback" | "error"): DailyMetric {
  if (outcome === "ok") return "lookups_ok";
  if (outcome === "llm_fallback") return "llm_fallback";
  return "errors";
}
