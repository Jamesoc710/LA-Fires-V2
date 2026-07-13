// lib/la/rateLimit.ts
// Phase 4 Fix #30: Simple in-memory rate limiter
// Hardening WP1: Optional Upstash-backed distributed rate limiting layered on top
// (see enforceRateLimit); the in-memory limiter below is the absent-safe fallback.

import { Ratelimit } from "@upstash/ratelimit";
import { getRedis } from "./redis";

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

// Cleanup counter - run cleanup every N checks
let checkCounter = 0;
const CLEANUP_INTERVAL = 100;

/**
 * Check if a request should be rate limited.
 * 
 * @param identifier - Unique identifier (usually IP address)
 * @param maxRequests - Maximum requests allowed in the window
 * @param windowMs - Time window in milliseconds
 * @returns Object with allowed status and metadata
 */
export function checkRateLimit(
  identifier: string,
  maxRequests: number = 20,
  windowMs: number = 60000 // 1 minute
): { 
  allowed: boolean; 
  remaining: number; 
  resetIn: number;
  total: number;
} {
  const now = Date.now();
  
  // Periodic cleanup of old entries
  checkCounter++;
  if (checkCounter >= CLEANUP_INTERVAL) {
    checkCounter = 0;
    cleanupExpiredEntries(now);
  }
  
  const entry = rateLimitMap.get(identifier);
  
  // No entry or expired window - start fresh
  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(identifier, {
      count: 1,
      resetTime: now + windowMs
    });
    return { 
      allowed: true, 
      remaining: maxRequests - 1, 
      resetIn: windowMs,
      total: maxRequests
    };
  }
  
  // Window still active
  const resetIn = entry.resetTime - now;
  
  // Check if limit exceeded
  if (entry.count >= maxRequests) {
    return { 
      allowed: false, 
      remaining: 0, 
      resetIn,
      total: maxRequests
    };
  }
  
  // Increment and allow
  entry.count++;
  return { 
    allowed: true, 
    remaining: maxRequests - entry.count, 
    resetIn,
    total: maxRequests
  };
}

/**
 * Clean up expired entries to prevent memory leaks
 */
function cleanupExpiredEntries(now: number): number {
  let removed = 0;
  
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetTime) {
      rateLimitMap.delete(key);
      removed++;
    }
  }
  
  return removed;
}

/**
 * Get client identifier from request headers.
 * Handles common proxy headers, in order of trust.
 *
 * Vercel sets x-vercel-forwarded-for on every request and it cannot be
 * overwritten by a fronting proxy, so it is preferred over the other,
 * client-spoofable headers.
 */
export function getClientIdentifier(headers: Headers): string {
  // Try various headers in order of preference
  const vercelForwardedFor = headers.get('x-vercel-forwarded-for');
  if (vercelForwardedFor) {
    // Take first IP in chain (original client)
    return vercelForwardedFor.split(',')[0].trim();
  }

  const realIp = headers.get('x-real-ip');
  if (realIp) {
    return realIp.trim();
  }

  const forwardedFor = headers.get('x-forwarded-for');
  if (forwardedFor) {
    // Take first IP in chain (original client)
    return forwardedFor.split(',')[0].trim();
  }

  const cfConnectingIp = headers.get('cf-connecting-ip');
  if (cfConnectingIp) {
    return cfConnectingIp.trim();
  }

  // Fallback (local dev / direct connections without any proxy headers)
  return 'local-dev';
}

/**
 * Format rate limit headers for response
 */
export function getRateLimitHeaders(result: {
  remaining: number;
  resetIn: number;
  total: number;
}): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(result.total),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(Math.ceil(result.resetIn / 1000)),
  };
}

/**
 * Get current rate limit stats (for debugging/monitoring)
 */
export function getRateLimitStats(): {
  activeEntries: number;
  totalRequests: number;
} {
  let totalRequests = 0;
  
  for (const entry of rateLimitMap.values()) {
    totalRequests += entry.count;
  }
  
  return {
    activeEntries: rateLimitMap.size,
    totalRequests,
  };
}

/**
 * Clear all rate limit entries (for testing)
 */
export function clearRateLimits(): void {
  rateLimitMap.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate limit presets for different endpoints
// ─────────────────────────────────────────────────────────────────────────────

export const RATE_LIMITS = {
  // Main chat endpoint - 20 requests per minute
  chat: { maxRequests: 20, windowMs: 60000 },

  // Individual tool endpoints - 30 requests per minute
  tools: { maxRequests: 30, windowMs: 60000 },

  // Burst protection - 5 requests per 5 seconds
  burst: { maxRequests: 5, windowMs: 5000 },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Upstash-backed distributed rate limiting (absent-safe)
//
// When Redis is configured, limits are enforced across all serverless instances
// via a sliding window. With no Redis, or on any Redis/network error, we fall
// back to the in-memory checkRateLimit above (fail open).
// ─────────────────────────────────────────────────────────────────────────────

// Module-level memo: undefined = not yet initialized, null = no Redis configured.
let upstashLimiter: Ratelimit | null | undefined = undefined;

/**
 * Get a memoized Upstash Ratelimit instance, or null when Redis is not configured.
 */
function getUpstashLimiter(): Ratelimit | null {
  if (upstashLimiter !== undefined) {
    return upstashLimiter;
  }

  const redis = getRedis();
  upstashLimiter = redis
    ? new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(RATE_LIMITS.chat.maxRequests, "60 s"),
        prefix: "lafires:rl",
        ephemeralCache: new Map(),
        analytics: false,
        timeout: 1000,
      })
    : null;
  return upstashLimiter;
}

/**
 * Enforce the rate limit, preferring the shared Upstash limiter when configured.
 *
 * Falls back to the in-memory limiter when no Redis is configured, and fails open
 * to it on any Redis/network error.
 */
export async function enforceRateLimit(
  identifier: string,
  max: number = RATE_LIMITS.chat.maxRequests,
  windowMs: number = RATE_LIMITS.chat.windowMs
): Promise<{ allowed: boolean; remaining: number; resetIn: number; total: number }> {
  const limiter = getUpstashLimiter();
  if (!limiter) {
    return checkRateLimit(identifier, max, windowMs);
  }

  try {
    // `limit()` also returns a `pending` promise for analytics flushing; we
    // ignore it since analytics is disabled.
    const { success, remaining, reset } = await limiter.limit(identifier);
    return {
      allowed: success,
      remaining,
      resetIn: Math.max(0, reset - Date.now()), // reset is a unix-ms timestamp
      total: max,
    };
  } catch {
    // Fail open to the in-memory limiter on any Redis/network error.
    return checkRateLimit(identifier, max, windowMs);
  }
}
