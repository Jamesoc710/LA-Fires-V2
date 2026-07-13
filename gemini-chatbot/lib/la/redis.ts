// lib/la/redis.ts
// Hardening WP1: Memoized Upstash Redis client factory. Absent-safe backend for
// the L2 cache and distributed rate limiter — with no env vars, everything falls
// back to pure in-memory behavior.

import { Redis } from "@upstash/redis";

// Module-level memo: undefined = not yet initialized, null = no config present.
let client: Redis | null | undefined = undefined;

/**
 * Get a memoized Upstash Redis client, or null when no config is present.
 *
 * Reads UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN, falling back to the
 * KV_REST_API_URL / KV_REST_API_TOKEN names used by the Vercel Marketplace
 * integration flavor. With neither pair configured this returns null and every
 * caller falls back to in-memory behavior.
 */
export function getRedis(): Redis | null {
  if (client !== undefined) {
    return client;
  }

  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

  client = url && token ? new Redis({ url, token }) : null;
  return client;
}

/**
 * Whether an Upstash Redis client is configured and available.
 */
export function redisEnabled(): boolean {
  return getRedis() !== null;
}
