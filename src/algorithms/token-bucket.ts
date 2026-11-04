/**
 * @fileoverview Token Bucket algorithm — Redis-backed implementation for burst handling.
 * Allows temporary traffic spikes up to bucket capacity while maintaining average rate.
 * Time Complexity: O(1) | Space: O(1)
 * @module algorithms/token-bucket
 */

import Redis from 'ioredis';
import { ITokenBucketStore, TokenBucketResult } from '../types';
import { TOKEN_BUCKET_SCRIPT, TOKEN_BUCKET_PEEK_SCRIPT } from '../redis/lua-scripts';

export class TokenBucketStore implements ITokenBucketStore {
  private redis: Redis;
  private hitSha: string | null = null;
  private peekSha: string | null = null;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async initialize(): Promise<void> {
    this.hitSha = await this.redis.script('LOAD', TOKEN_BUCKET_SCRIPT) as string;
    this.peekSha = await this.redis.script('LOAD', TOKEN_BUCKET_PEEK_SCRIPT) as string;
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

  /**
   * Attempt to consume tokens from the bucket.
   * @param key - Bucket key
   * @param capacity - Maximum tokens the bucket can hold
   * @param refillRatePerMs - Tokens added per millisecond
   * @param tokens - Number of tokens to consume (default: 1)
   */
  async consume(key: string, capacity: number, refillRatePerMs: number, tokens = 1): Promise<TokenBucketResult> {
    const bucketKey = `${key}:burst`;
    const now = Date.now();

    const result = await this.execScript(this.hitSha, TOKEN_BUCKET_SCRIPT, [bucketKey], [
      now.toString(), capacity.toString(), refillRatePerMs.toString(), tokens.toString(),
    ]);

    if (result.length === 3) {
      return { allowed: false, tokensRemaining: result[1], retryAfterMs: result[2] };
    }
    return { allowed: result[0] === 1, tokensRemaining: result[1] };
  }

  async peek(key: string, capacity: number, refillRatePerMs: number): Promise<TokenBucketResult> {
    const bucketKey = `${key}:burst`;
    const now = Date.now();

    const result = await this.execScript(this.peekSha, TOKEN_BUCKET_PEEK_SCRIPT, [bucketKey], [
      now.toString(), capacity.toString(), refillRatePerMs.toString(),
    ]);

    return { allowed: result[0] === 1, tokensRemaining: result[1] };
  }
}
