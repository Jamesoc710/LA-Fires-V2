// lib/la/cache.ts
// Phase 4 Fix #28: Simple in-memory LRU cache for parcel/zoning/overlay data

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

// ─────────────────────────────────────────────────────────────────────────────
// Singleton cache instances for different data types
// ─────────────────────────────────────────────────────────────────────────────

// Parcel geometry - rarely changes, cache for 10 minutes
export const parcelCache = new SimpleCache<any>("parcel", 100, 10);

// Jurisdiction - never changes, cache for 60 minutes
export const jurisdictionCache = new SimpleCache<any>("jurisdiction", 100, 60);

// Zoning data - rarely changes, cache for 10 minutes
export const zoningCache = new SimpleCache<any>("zoning", 100, 10);

// Overlay data - occasionally changes, cache for 5 minutes
export const overlayCache = new SimpleCache<any>("overlay", 100, 5);

// Assessor data - rarely changes, cache for 10 minutes
export const assessorCache = new SimpleCache<any>("assessor", 100, 10);

// ─────────────────────────────────────────────────────────────────────────────
// Request-scoped cache for deduplication within a single request
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a request-scoped cache that lives for the duration of one API request.
 * This prevents duplicate fetches within the same request (Fix #26).
 */
export function createRequestCache(): Map<string, any> {
  return new Map();
}

/**
 * Helper to get or fetch with request-scoped caching
 */
export async function getOrFetch<T>(
  cache: Map<string, any>,
  key: string,
  fetcher: () => Promise<T>
): Promise<T> {
  if (cache.has(key)) {
    return cache.get(key) as T;
  }
  
  const result = await fetcher();
  cache.set(key, result);
  return result;
}

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
