import { NextRequest, NextResponse } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import { redisEnabled } from "@/lib/la/redis";
import { getAllCacheStats } from "@/lib/la/cache";
import { getRateLimitStats } from "@/lib/la/rateLimit";
import { getDailyStats } from "@/lib/la/stats";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  noStore();

  const body: Record<string, unknown> = {
    ok: true,
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev",
    timestamp: new Date().toISOString(),
  };

  // Extended diagnostics only when a HEALTH_TOKEN is configured AND matches the
  // ?token= param exactly. On no token / mismatch, never hint the token exists.
  const token = process.env.HEALTH_TOKEN;
  if (token && request.nextUrl.searchParams.get("token") === token) {
    body.redis = redisEnabled() ? "configured" : "memory";
    body.caches = getAllCacheStats();
    body.rateLimit = getRateLimitStats();
    // Anonymous aggregate usage: last 7 days of each counter (null when no Redis).
    const daily = await getDailyStats(7);
    if (daily) body.daily = daily;
  }

  return NextResponse.json(body);
}
