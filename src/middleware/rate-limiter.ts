/**
 * @fileoverview Rate limiter middleware factory.
 * 
 * This is the main entry point for the rate limiter. It creates Express middleware
 * that enforces rate limits using configurable algorithms, stores, and policies.
 * 
 * Features:
 * - Pluggable algorithm selection (log vs counter)
 * - Automatic Redis failover to in-memory store
 * - Tiered rate limiting with dynamic tier resolution
 * - Burst allowance via token bucket hybrid
 * - Standard rate limit response headers
 * - Skip predicates for whitelisting
 * - Prometheus metrics integration
 * 
 * @module middleware/rate-limiter
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';
import {
  RateLimiterOptions,
  Algorithm,
  IRateLimitStore,
  ITokenBucketStore,
  RateLimitResult,
  FailoverStrategy,
  TierResolver,
  TierConfigMap,
} from '../types';
import { redisManager } from '../redis/client';
import { SlidingWindowLogStore } from '../algorithms/sliding-window-log';
import { SlidingWindowCounterStore } from '../algorithms/sliding-window-counter';
import { TokenBucketStore } from '../algorithms/token-bucket';
import {
  MemorySlidingWindowLogStore,
  MemoryTokenBucketStore,
} from '../fallback/memory-store';
import { setRateLimitHeaders, setStandardHeaders } from '../utils/headers';
import { byIP } from '../utils/key-generators';
import { config } from '../config';
import { metricsCollector } from '../metrics/prometheus';
import { defaultTierResolver, getTierConfig } from './tiers';

/** Default options for the rate limiter */
const DEFAULT_OPTIONS: RateLimiterOptions = {
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  keyGenerator: byIP,
  algorithm: Algorithm.SLIDING_WINDOW_COUNTER,
  skipFailedRequests: false,
  skipSuccessfulRequests: false,
  handler: defaultHandler,
  skip: () => false,
  message: { error: 'Too many requests, please try again later.' },
  statusCode: 429,
  standardHeaders: true,
  legacyHeaders: true,
  enableBurst: false,
  burstCapacity: 10,
  burstRefillRate: 2,
  keyPrefix: config.redis.keyPrefix,
};

/** Default 429 handler */
function defaultHandler(
  _req: Request,
  res: Response,
  _next: NextFunction,
  result: RateLimitResult
): void {
  const retryAfterSec = result.retryAfter ? Math.ceil(result.retryAfter / 1000) : 60;

  res.status(429).json({
    error: 'Too Many Requests',
    message: `Rate limit exceeded. Try again in ${retryAfterSec} seconds.`,
    limit: result.limit,
    remaining: result.remaining,
    resetAt: new Date(result.resetTime).toISOString(),
    retryAfterSeconds: retryAfterSec,
  });
}

// ─────────────────────────────────────────────────────────────────
// Store Management (Singleton with failover)
// ─────────────────────────────────────────────────────────────────

let redisLogStore: SlidingWindowLogStore | null = null;
let redisCounterStore: SlidingWindowCounterStore | null = null;
let redisTokenBucket: TokenBucketStore | null = null;
const memoryLogStore = new MemorySlidingWindowLogStore();
const memoryBurstStore = new MemoryTokenBucketStore();

/** Lazy-initialize Redis-backed stores */
async function getRedisStores(): Promise<{
  log: SlidingWindowLogStore;
  counter: SlidingWindowCounterStore;
  bucket: TokenBucketStore;
}> {
  const client = redisManager.getClient();

  if (!redisLogStore) {
    redisLogStore = new SlidingWindowLogStore(client, config.clockSkewToleranceMs);
    await redisLogStore.initialize();
  }
  if (!redisCounterStore) {
    redisCounterStore = new SlidingWindowCounterStore(client, config.clockSkewToleranceMs);
    await redisCounterStore.initialize();
  }
  if (!redisTokenBucket) {
    redisTokenBucket = new TokenBucketStore(client);
    await redisTokenBucket.initialize();
  }

  return { log: redisLogStore, counter: redisCounterStore, bucket: redisTokenBucket };
}

/**
 * Resolve the appropriate store based on Redis availability and failover strategy.
 */
async function resolveStore(algorithm: Algorithm): Promise<{
  store: IRateLimitStore;
  burstStore: ITokenBucketStore;
  isFailover: boolean;
}> {
  const redisAvailable = redisManager.isAvailable();

  if (redisAvailable) {
    try {
      const stores = await getRedisStores();
      return {
        store: algorithm === Algorithm.SLIDING_WINDOW_LOG ? stores.log : stores.counter,
        burstStore: stores.bucket,
        isFailover: false,
      };
    } catch {
      // Redis call failed — fall through to failover
    }
  }

  // ── Failover logic ──
  const strategy = config.failoverStrategy;

  switch (strategy) {
    case FailoverStrategy.FAIL_OPEN:
      // Create a pass-through store that allows everything
      return {
        store: {
          async hit(_k: string, _w: number, max: number) {
            return { allowed: true, limit: max, remaining: max, resetTime: Date.now() + _w };
          },
          async peek(_k: string, _w: number, max: number) {
            return { allowed: true, limit: max, remaining: max, resetTime: Date.now() + _w };
          },
          async reset() { /* noop */ },
        },
        burstStore: memoryBurstStore,
        isFailover: true,
      };

    case FailoverStrategy.FAIL_CLOSED:
      // Create a blocking store that denies everything
      return {
        store: {
          async hit(_k: string, _w: number, max: number) {
            return { allowed: false, limit: max, remaining: 0, resetTime: Date.now() + 60000, retryAfter: 60000 };
          },
          async peek(_k: string, _w: number, max: number) {
            return { allowed: false, limit: max, remaining: 0, resetTime: Date.now() + 60000 };
          },
          async reset() { /* noop */ },
        },
        burstStore: memoryBurstStore,
        isFailover: true,
      };

    case FailoverStrategy.IN_MEMORY_FALLBACK:
    default:
      return {
        store: memoryLogStore,
        burstStore: memoryBurstStore,
        isFailover: true,
      };
  }
}

// ─────────────────────────────────────────────────────────────────
// Middleware Factory
// ─────────────────────────────────────────────────────────────────

/**
 * Create a rate limiter Express middleware.
 * 
 * @example
 * ```typescript
 * // Basic usage
 * app.use(createRateLimiter({ windowMs: 15 * 60 * 1000, max: 100 }));
 * 
 * // Per-API-key with burst
 * app.use('/api', createRateLimiter({
 *   windowMs: 60000,
 *   max: 60,
 *   keyGenerator: byAPIKey,
 *   enableBurst: true,
 *   burstCapacity: 20,
 * }));
 * ```
 */
export function createRateLimiter(
  userOptions: Partial<RateLimiterOptions> = {}
): RequestHandler {
  const opts = { ...DEFAULT_OPTIONS, ...userOptions };

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Skip check
    if (opts.skip(req)) { next(); return; }

    const key = `${opts.keyPrefix}${opts.keyGenerator(req)}`;
    const startTime = performance.now();

    try {
      const { store, burstStore, isFailover } = await resolveStore(opts.algorithm);
      const actualStore = opts.store || store;
      const actualBurstStore = opts.burstStore || burstStore;

      // Check main rate limit
      const result = await actualStore.hit(key, opts.windowMs, opts.max);

      // Check burst allowance if enabled and main limit is exceeded
      if (!result.allowed && opts.enableBurst) {
        const burstResult = await actualBurstStore.consume(
          key,
          opts.burstCapacity,
          opts.burstRefillRate / 1000 // Convert tokens/sec to tokens/ms
        );

        if (burstResult.allowed) {
          // Burst token consumed — allow this request
          result.allowed = true;
          result.remaining = 0; // Main limit is still exhausted
        }
      }

      // Set response headers
      if (opts.legacyHeaders) setRateLimitHeaders(res, result);
      if (opts.standardHeaders) setStandardHeaders(res, result);

      // Record metrics
      const latency = performance.now() - startTime;
      metricsCollector.recordRequest(result.allowed ? 'allowed' : 'blocked', opts.algorithm);
      metricsCollector.recordRedisLatency(latency);
      if (isFailover) metricsCollector.recordFailover();

      if (!result.allowed) {
        opts.handler(req, res, next, result);
        return;
      }

      // Handle skipFailedRequests / skipSuccessfulRequests
      if (opts.skipFailedRequests || opts.skipSuccessfulRequests) {
        const originalEnd = res.end;
        // @ts-expect-error — overriding res.end for post-response processing
        res.end = function (...args: Parameters<typeof originalEnd>) {
          const shouldSkip =
            (opts.skipFailedRequests && res.statusCode >= 400) ||
            (opts.skipSuccessfulRequests && res.statusCode < 400);

          if (shouldSkip && opts.store) {
            // Decrement the count (best-effort, non-blocking)
            opts.store.reset(key).catch(() => { /* swallow */ });
          }

          return originalEnd.apply(res, args);
        };
      }

      next();
    } catch (err) {
      console.error(`[RateLimiter] Error: ${(err as Error).message}`);
      const latency = performance.now() - startTime;
      metricsCollector.recordRedisLatency(latency);
      metricsCollector.recordError();

      // On error, fail according to strategy
      if (config.failoverStrategy === FailoverStrategy.FAIL_CLOSED) {
        res.status(503).json({ error: 'Service temporarily unavailable' });
        return;
      }
      next(); // Fail open
    }
  };
}

// ─────────────────────────────────────────────────────────────────
// Tiered Rate Limiter Factory
// ─────────────────────────────────────────────────────────────────

/**
 * Create a tiered rate limiter that dynamically adjusts limits based on subscription tier.
 * 
 * @example
 * ```typescript
 * app.use('/api', createTieredRateLimiter({
 *   tierResolver: (req) => req.user?.tier || Tier.FREE,
 *   algorithm: Algorithm.SLIDING_WINDOW_COUNTER,
 * }));
 * ```
 */
export function createTieredRateLimiter(options: {
  tierResolver?: TierResolver;
  tierConfigs?: Partial<TierConfigMap>;
  algorithm?: Algorithm;
  keyGenerator?: (req: Request) => string;
  keyPrefix?: string;
}): RequestHandler {
  const {
    tierResolver = defaultTierResolver,
    tierConfigs,
    algorithm = Algorithm.SLIDING_WINDOW_COUNTER,
    keyGenerator = byIP,
    keyPrefix = config.redis.keyPrefix,
  } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const tier = await tierResolver(req);
    const tierConfig = getTierConfig(tier, tierConfigs as TierConfigMap);

    // Enterprise with unlimited flag bypasses entirely
    if (tierConfig.unlimited) {
      res.setHeader('X-RateLimit-Tier', tier);
      next();
      return;
    }

    // Create middleware on-the-fly with tier-specific config
    const middleware = createRateLimiter({
      windowMs: tierConfig.windowMs,
      max: tierConfig.maxRequests,
      keyGenerator,
      algorithm,
      enableBurst: tierConfig.burstCapacity > 0,
      burstCapacity: tierConfig.burstCapacity,
      burstRefillRate: tierConfig.burstRefillRate,
      keyPrefix: `${keyPrefix}${tier}:`,
    });

    // Inject tier header
    res.setHeader('X-RateLimit-Tier', tier);

    await middleware(req, res, next);
  };
}
