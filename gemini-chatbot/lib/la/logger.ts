// Phase 4 Fix #31: Structured logging with sequence numbers and elapsed time

/**
 * Request logger that tracks sequence and elapsed time.
 * Solves the out-of-order timestamp problem in async operations.
 */
export interface RequestLogger {
  log: (category: string, message: string, data?: any) => void;
  warn: (category: string, message: string, data?: any) => void;
  error: (category: string, message: string, data?: any) => void;
  elapsed: () => number;
  getRequestId: () => string;
  getBenchmarks: () => Record<string, number>;
  benchmark: (label: string) => void;
}

/**
 * Create a request-scoped logger with sequence numbers and elapsed time.
 * 
 * @param requestId - Unique identifier for this request (optional, will generate if not provided)
 * @returns Logger instance scoped to this request
 * 
 * @example
 * const log = createRequestLogger();
 * log.log('ARCGIS', 'Parcel query started', { apn: '5843004015' });
 * // Output: [0001] +0ms [a1b2c3d4] [ARCGIS] Parcel query started {"apn":"5843004015"}
 */
export function createRequestLogger(requestId?: string): RequestLogger {
  const startTime = Date.now();
  const id = requestId || generateRequestId();
  let sequence = 0;
  const benchmarks: Record<string, number> = {};
  
  const formatLog = (
    level: 'INFO' | 'WARN' | 'ERROR',
    category: string,
    message: string,
    data?: any
  ): string => {
    const seq = (++sequence).toString().padStart(4, '0');
    const elapsed = Date.now() - startTime;
    const dataStr = data ? ` ${JSON.stringify(data)}` : '';
    
    return `[${seq}] +${elapsed}ms [${id}] [${category}] ${message}${dataStr}`;
  };
  
  return {
    log(category: string, message: string, data?: any) {
      console.log(formatLog('INFO', category, message, data));
    },
    
    warn(category: string, message: string, data?: any) {
      console.warn(formatLog('WARN', category, message, data));
    },
    
    error(category: string, message: string, data?: any) {
      console.error(formatLog('ERROR', category, message, data));
    },
    
    elapsed() {
      return Date.now() - startTime;
    },
    
    getRequestId() {
      return id;
    },
    
    getBenchmarks() {
      return { ...benchmarks };
    },
    
    benchmark(label: string) {
      benchmarks[label] = Date.now() - startTime;
    }
  };
}

/**
 * Generate a short unique request ID
 */
function generateRequestId(): string {
  return Math.random().toString(36).substring(2, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// Performance timing utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Timer utility for measuring operation duration
 */
export function createTimer(label: string) {
  const start = Date.now();
  
  return {
    stop(): number {
      const elapsed = Date.now() - start;
      return elapsed;
    },
    
    stopAndLog(logger: RequestLogger): number {
      const elapsed = Date.now() - start;
      logger.log('PERF', `${label} completed`, { ms: elapsed });
      logger.benchmark(label);
      return elapsed;
    }
  };
}

/**
 * Wrap an async function with timing
 */
export async function timed<T>(
  label: string,
  fn: () => Promise<T>,
  logger?: RequestLogger
): Promise<{ result: T; elapsed: number }> {
  const start = Date.now();
  
  try {
    const result = await fn();
    const elapsed = Date.now() - start;
    
    if (logger) {
      logger.log('PERF', `${label} completed`, { ms: elapsed });
      logger.benchmark(label);
    }
    
    return { result, elapsed };
  } catch (error) {
    const elapsed = Date.now() - start;
    
    if (logger) {
      logger.error('PERF', `${label} failed`, { ms: elapsed, error: String(error) });
    }
    
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Request metrics logging
// ─────────────────────────────────────────────────────────────────────────────

export interface RequestMetrics {
  requestId: string;
  apn?: string;
  jurisdiction?: string;
  totalTime: number;
  cacheHits: number;
  cacheMisses: number;
  overlayCount?: number;
  benchmarks: Record<string, number>;
  timestamp: string;
}

/**
 * Log request metrics in a structured format for analysis
 */
export function logRequestMetrics(metrics: RequestMetrics): void {
  console.log(JSON.stringify({
    type: 'REQUEST_METRICS',
    ...metrics,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Category constants for consistent logging
// ─────────────────────────────────────────────────────────────────────────────

export const LOG_CATEGORIES = {
  CHAT: 'CHAT',
  ARCGIS: 'ARCGIS',
  CACHE: 'CACHE',
  OVERLAY: 'OVERLAY',
  ZONING: 'ZONING',
  ASSESSOR: 'ASSESSOR',
  JURISDICTION: 'JURISDICTION',
  OPENROUTER: 'OPENROUTER',
  PERF: 'PERF',
  RATELIMIT: 'RATELIMIT',
  ERROR: 'ERROR',
} as const;

export type LogCategory = typeof LOG_CATEGORIES[keyof typeof LOG_CATEGORIES];
