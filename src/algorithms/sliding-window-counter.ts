/**
 * @fileoverview Sliding Window Counter (Hybrid) — Redis-backed implementation.
 * Weights two adjacent fixed windows for an approximate sliding window.
 * Time Complexity: O(1) per hit | Space: O(1) — exactly 2 keys
 * @module algorithms/sliding-window-counter
 */

import Redis from 'ioredis';
import { IRateLimitStore, RateLimitResult } from '../types';
import { SLIDING_WINDOW_COUNTER_SCRIPT, SLIDING_WINDOW_COUNTER_PEEK_SCRIPT } from '../redis/lua-scripts';

export class SlidingWindowCounterStore implements IRateLimitStore {
  private redis: Redis;
  private clockSkewMs: number;
  private hitSha: string | null = null;
  private peekSha: string | null = null;

  constructor(redis: Redis, clockSkewMs = 1000) {
    this.redis = redis;
    this.clockSkewMs = clockSkewMs;
  }

  async initialize(): Promise<void> {
    this.hitSha = await this.redis.script('LOAD', SLIDING_WINDOW_COUNTER_SCRIPT) as string;
    this.peekSha = await this.redis.script('LOAD', SLIDING_WINDOW_COUNTER_PEEK_SCRIPT) as string;
  }

  private async execScript(sha: string | null, script: string, keys: string[], args: string[]): Promise<number[]> {
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

  /** Generate the window-scoped key pair for current and previous windows */
  private getWindowKeys(key: string, windowMs: number): [string, string] {
    const now = Date.now();
    const currWindow = Math.floor(now / windowMs);
    const prevWindow = currWindow - 1;
    return [`${key}:w:${currWindow}`, `${key}:w:${prevWindow}`];
  }

  async hit(key: string, windowMs: number, maxRequests: number): Promise<RateLimitResult> {
    const now = Date.now();
    const [currKey, prevKey] = this.getWindowKeys(key, windowMs);

    const result = await this.execScript(this.hitSha, SLIDING_WINDOW_COUNTER_SCRIPT, [currKey, prevKey], [
      now.toString(), windowMs.toString(), maxRequests.toString(), this.clockSkewMs.toString(),
    ]);

    const [allowed, remaining, resetTime] = result;
    return {
      allowed: allowed === 1, limit: maxRequests,
      remaining: Math.max(0, remaining), resetTime,
      retryAfter: allowed === 1 ? undefined : Math.max(0, resetTime - now),
    };
  }

  async peek(key: string, windowMs: number, maxRequests: number): Promise<RateLimitResult> {
    const now = Date.now();
    const [currKey, prevKey] = this.getWindowKeys(key, windowMs);

    const result = await this.execScript(this.peekSha, SLIDING_WINDOW_COUNTER_PEEK_SCRIPT, [currKey, prevKey], [
      now.toString(), windowMs.toString(), maxRequests.toString(), this.clockSkewMs.toString(),
    ]);

    const [allowed, remaining, resetTime] = result;
    return {
      allowed: allowed === 1, limit: maxRequests,
      remaining: Math.max(0, remaining), resetTime,
      retryAfter: allowed === 1 ? undefined : Math.max(0, resetTime - Date.now()),
    };
  }

  async reset(key: string): Promise<void> {
    // Delete all window keys matching this base key
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', `${key}:w:*`, 'COUNT', 100);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    if (keys.length > 0) { await this.redis.del(...keys); }
  }

  async getActiveKeys(): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', '*:w:*', 'COUNT', 100);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    // Extract base keys from window keys
    const baseKeys = new Set(keys.map(k => k.replace(/:w:\d+$/, '')));
    return [...baseKeys];
  }
}
