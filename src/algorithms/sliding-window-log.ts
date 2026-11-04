/**
 * @fileoverview Sliding Window Log algorithm — Redis-backed implementation.
 * Uses a Redis Sorted Set (ZSET) for per-request timestamp tracking.
 * Time Complexity: O(N) per hit | Space: O(M) where M = max requests
 * @module algorithms/sliding-window-log
 */

import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { IRateLimitStore, RateLimitResult } from '../types';
import { SLIDING_WINDOW_LOG_SCRIPT, SLIDING_WINDOW_LOG_PEEK_SCRIPT } from '../redis/lua-scripts';

export class SlidingWindowLogStore implements IRateLimitStore {
  private redis: Redis;
  private clockSkewMs: number;
  private hitSha: string | null = null;
  private peekSha: string | null = null;

  constructor(redis: Redis, clockSkewMs = 1000) {
    this.redis = redis;
    this.clockSkewMs = clockSkewMs;
  }

  /** Pre-load Lua scripts into Redis (EVALSHA is faster than EVAL) */
  async initialize(): Promise<void> {
    this.hitSha = await this.redis.script('LOAD', SLIDING_WINDOW_LOG_SCRIPT) as string;
    this.peekSha = await this.redis.script('LOAD', SLIDING_WINDOW_LOG_PEEK_SCRIPT) as string;
  }

  /** Execute a Lua script with EVALSHA, falling back to EVAL on NOSCRIPT */
  private async execScript(
    sha: string | null,
    script: string,
    keys: string[],
    args: string[]
  ): Promise<number[]> {
    if (sha) {
      try {
        return await this.redis.evalsha(sha, keys.length, ...keys, ...args) as number[];
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('NOSCRIPT')) {
          await this.initialize();
          return await this.redis.evalsha(this.hitSha!, keys.length, ...keys, ...args) as number[];
        }
        throw err;
      }
    }
    return await this.redis.eval(script, keys.length, ...keys, ...args) as number[];
  }

  /** Check rate limit and record the request atomically */
  async hit(key: string, windowMs: number, maxRequests: number): Promise<RateLimitResult> {
    const now = Date.now();
    const result = await this.execScript(this.hitSha, SLIDING_WINDOW_LOG_SCRIPT, [key], [
      now.toString(), windowMs.toString(), maxRequests.toString(), uuidv4(), this.clockSkewMs.toString(),
    ]);
    const [allowed, remaining, resetTime] = result;
    return {
      allowed: allowed === 1,
      limit: maxRequests,
      remaining: Math.max(0, remaining),
      resetTime,
      retryAfter: allowed === 1 ? undefined : Math.max(0, resetTime - now),
    };
  }

  /** Peek at current state without recording */
  async peek(key: string, windowMs: number, maxRequests: number): Promise<RateLimitResult> {
    const now = Date.now();
    const result = await this.execScript(this.peekSha, SLIDING_WINDOW_LOG_PEEK_SCRIPT, [key], [
      now.toString(), windowMs.toString(), maxRequests.toString(), this.clockSkewMs.toString(),
    ]);
    const [allowed, remaining, resetTime] = result;
    return {
      allowed: allowed === 1, limit: maxRequests,
      remaining: Math.max(0, remaining), resetTime,
      retryAfter: allowed === 1 ? undefined : Math.max(0, resetTime - Date.now()),
    };
  }

  /** Reset rate limit for a specific key */
  async reset(key: string): Promise<void> { await this.redis.del(key); }

  /** Get all active keys using non-blocking SCAN */
  async getActiveKeys(): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', '*', 'COUNT', 100);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }
}
