// lib/la/cache.ts
// Phase 4 Fix #28: Simple in-memory LRU cache for parcel/zoning/overlay data
// Hardening WP1: Optional shared L2 Redis tier (TieredCache) layered over the
// per-instance SimpleCache; absent-safe and fails open when Redis is unconfigured.

import { getRedis } from "./redis";

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

/**
 * Simple TTL cache with LRU-style eviction.
 * Designed for request-level and short-term caching of ArcGIS responses.
 */
export class SimpleCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private maxSize: number;
  private ttlMs: number;
  private name: string;

  constructor(name: string, maxSize: number = 100, ttlMinutes: number = 5) {
    this.name = name;
    this.maxSize = maxSize;
    this.ttlMs = ttlMinutes * 60 * 1000;
  }

  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }

    // Check TTL
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }

  set(key: string, data: T): void {
    // Evict oldest entries if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, { data, timestamp: Date.now() });
  }

  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    
    // Check TTL
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return false;
    }
    
    return true;
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }

  /**
   * Clean expired entries. Call periodically or before size checks.
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    
    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp > this.ttlMs) {
        this.cache.delete(key);
        removed++;
      }
    }
    
    return removed;
  }

  /**
   * Get cache stats for monitoring
   */
  stats(): { name: string; size: number; maxSize: number; ttlMinutes: number } {
    return {
      name: this.name,
      size: this.cache.size,
      maxSize: this.maxSize,
      ttlMinutes: this.ttlMs / 60000,
    };
  }
}

export class TieredCache<T> {
  // L1 = existing SimpleCache (per-instance). L2 = optional Upstash Redis, enabled
  // per-cache and only when Redis env vars are configured. All L2 ops fail open.
  private l1: SimpleCache<T>;
  private useL2: boolean;
  private ttlSeconds: number;
  private ns: string;

  constructor(name: string, maxSize: number, ttlMinutes: number, useL2: boolean) {
    this.l1 = new SimpleCache<T>(name, maxSize, ttlMinutes);
    this.useL2 = useL2;
    this.ttlSeconds = Math.round(ttlMinutes * 60);
    this.ns = `lafires:cache:${name}`;
  }

  private nsKey(key: string): string {
    return `${this.ns}:${key}`;
  }

  async get(key: string): Promise<T | null> {
    // L1 first.
    const l1Hit = this.l1.get(key);
    if (l1Hit !== null) {
      return l1Hit;
    }

    // L2 on L1 miss, if enabled and configured.
    if (this.useL2) {
      const redis = getRedis();
      if (redis) {
        try {
          const l2Hit = await redis.get<T>(this.nsKey(key));
          if (l2Hit !== null && l2Hit !== undefined) {
            // Backfill L1 so subsequent reads on this instance stay hot.
            this.l1.set(key, l2Hit);
            return l2Hit;
          }
        } catch {
          // L2 read failure -> treat as miss (fail open).
        }
      }
    }

    return null;
  }

  async set(key: string, data: T): Promise<void> {
    // Always write L1.
    this.l1.set(key, data);

    // Mirror to L2 if enabled and configured.
    if (this.useL2) {
      const redis = getRedis();
      if (redis) {
        try {
          // @upstash/redis JSON-serializes the value automatically.
          await redis.set(this.nsKey(key), data, { ex: this.ttlSeconds });
        } catch {
          // L2 write failure is non-fatal (fail open).
        }
      }
    }
  }

  stats(): { name: string; size: number; maxSize: number; ttlMinutes: number } {
    return this.l1.stats();
  }

  clear(): void {
    // Only clears this instance's L1. L2 entries are left to TTL-expire — no
    // cross-instance invalidation is needed for this (slowly-changing) data.
    this.l1.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton cache instances for different data types
// ─────────────────────────────────────────────────────────────────────────────

// Parcel geometry - rarely changes, cache for 10 minutes. L1-only: values are
// full ArcGIS features with geometry rings (tens of KB, low cross-user reuse),
// so L2 isn't worth the payload cost. Flip to true later if that changes.
export const parcelCache = new TieredCache<any>("parcel", 100, 10, false);

// Jurisdiction - never changes, cache for 60 minutes (shared via L2)
export const jurisdictionCache = new TieredCache<any>("jurisdiction", 100, 60, true);

// Zoning data - rarely changes, cache for 10 minutes (shared via L2)
export const zoningCache = new TieredCache<any>("zoning", 100, 10, true);

// Overlay data - occasionally changes, cache for 5 minutes (shared via L2)
export const overlayCache = new TieredCache<any>("overlay", 100, 5, true);

// Assessor data - rarely changes, cache for 10 minutes (shared via L2)
export const assessorCache = new TieredCache<any>("assessor", 100, 10, true);

// ─────────────────────────────────────────────────────────────────────────────
// Cache statistics for monitoring
// ─────────────────────────────────────────────────────────────────────────────

export function getAllCacheStats() {
  return {
    parcel: parcelCache.stats(),
    jurisdiction: jurisdictionCache.stats(),
    zoning: zoningCache.stats(),
    overlay: overlayCache.stats(),
    assessor: assessorCache.stats(),
  };
}

/**
 * Clear all caches - useful for testing or manual refresh
 */
export function clearAllCaches() {
  parcelCache.clear();
  jurisdictionCache.clear();
  zoningCache.clear();
  overlayCache.clear();
  assessorCache.clear();
}
