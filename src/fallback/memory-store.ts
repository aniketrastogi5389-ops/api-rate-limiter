/**
 * @fileoverview In-memory rate limit store for Redis failover scenarios.
 * Implements the same interface as Redis stores for transparent fallback.
 * 
 * LIMITATIONS (by design — this is a fallback, not a primary store):
 * - Not shared across processes/servers
 * - Data lost on restart
 * - Memory-bounded with LRU eviction
 * 
 * @module fallback/memory-store
 */

import { IRateLimitStore, ITokenBucketStore, RateLimitResult, TokenBucketResult } from '../types';

/** Entry in the sliding window log */
interface LogEntry {
  timestamps: number[];
  lastCleanup: number;
}

/** Token bucket state */
interface BucketEntry {
  tokens: number;
  lastRefill: number;
}

/**
 * In-memory Sliding Window Log store.
 * Uses Map with periodic cleanup to prevent memory leaks.
 */
export class MemorySlidingWindowLogStore implements IRateLimitStore {
  private store = new Map<string, LogEntry>();
  private readonly maxKeys: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(maxKeys = 10000) {
    this.maxKeys = maxKeys;
    // Periodic cleanup every 60s to prevent memory leaks
    this.cleanupTimer = setInterval(() => this.cleanup(), 60000);
  }

  async hit(key: string, windowMs: number, maxRequests: number): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - windowMs;

    let entry = this.store.get(key);
    if (!entry) {
      entry = { timestamps: [], lastCleanup: now };
      this.evictIfNeeded();
      this.store.set(key, entry);
    }

    // Remove expired timestamps
    entry.timestamps = entry.timestamps.filter(ts => ts > windowStart);
    entry.lastCleanup = now;

    if (entry.timestamps.length < maxRequests) {
      entry.timestamps.push(now);
      return {
        allowed: true, limit: maxRequests,
        remaining: maxRequests - entry.timestamps.length,
        resetTime: now + windowMs,
      };
    }

    const oldestTs = entry.timestamps[0];
    const resetTime = oldestTs + windowMs;
    return {
      allowed: false, limit: maxRequests, remaining: 0,
      resetTime, retryAfter: Math.max(0, resetTime - now),
    };
  }

  async peek(key: string, windowMs: number, maxRequests: number): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - windowMs;
    const entry = this.store.get(key);

    if (!entry) {
      return { allowed: true, limit: maxRequests, remaining: maxRequests, resetTime: now + windowMs };
    }

    const activeCount = entry.timestamps.filter(ts => ts > windowStart).length;
    const remaining = Math.max(0, maxRequests - activeCount);
    return {
      allowed: remaining > 0, limit: maxRequests, remaining, resetTime: now + windowMs,
      retryAfter: remaining > 0 ? undefined : windowMs,
    };
  }

  async reset(key: string): Promise<void> { this.store.delete(key); }

  async getActiveKeys(): Promise<string[]> { return [...this.store.keys()]; }

  /** LRU-style eviction when at capacity */
  private evictIfNeeded(): void {
    if (this.store.size >= this.maxKeys) {
      const firstKey = this.store.keys().next().value;
      if (firstKey) this.store.delete(firstKey);
    }
  }

  /** Remove entries with all-expired timestamps */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now - entry.lastCleanup > 300000) { // 5 minutes stale
        this.store.delete(key);
      }
    }
  }

  /** Stop cleanup timer (for graceful shutdown) */
  destroy(): void {
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
    this.store.clear();
  }
}

/**
 * In-memory Token Bucket store for burst fallback.
 */
export class MemoryTokenBucketStore implements ITokenBucketStore {
  private store = new Map<string, BucketEntry>();

  async consume(key: string, capacity: number, refillRatePerMs: number, tokens = 1): Promise<TokenBucketResult> {
    const now = Date.now();
    let bucket = this.store.get(key);

    if (!bucket) {
      bucket = { tokens: capacity, lastRefill: now };
      this.store.set(key, bucket);
    }

    // Refill tokens
    const elapsed = Math.max(0, now - bucket.lastRefill);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillRatePerMs);
    bucket.lastRefill = now;

    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens;
      return { allowed: true, tokensRemaining: Math.floor(bucket.tokens) };
    }

    const deficit = tokens - bucket.tokens;
    const waitMs = Math.ceil(deficit / refillRatePerMs);
    return { allowed: false, tokensRemaining: Math.floor(bucket.tokens), retryAfterMs: waitMs };
  }

  async peek(key: string, capacity: number, refillRatePerMs: number): Promise<TokenBucketResult> {
    const now = Date.now();
    const bucket = this.store.get(key);
    if (!bucket) return { allowed: true, tokensRemaining: capacity };

    const elapsed = Math.max(0, now - bucket.lastRefill);
    const currentTokens = Math.min(capacity, bucket.tokens + elapsed * refillRatePerMs);
    return { allowed: currentTokens >= 1, tokensRemaining: Math.floor(currentTokens) };
  }

  destroy(): void { this.store.clear(); }
}
