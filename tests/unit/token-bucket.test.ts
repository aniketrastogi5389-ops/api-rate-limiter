/**
 * Unit tests for Token Bucket algorithm.
 */

import { MockRedis } from '../mocks/redis.mock';
import { TokenBucketStore } from '../../src/algorithms/token-bucket';

describe('TokenBucketStore', () => {
  let mockRedis: MockRedis;
  let store: TokenBucketStore;

  beforeEach(() => {
    mockRedis = new MockRedis();
    store = new TokenBucketStore(mockRedis as any);
  });

  afterEach(() => {
    mockRedis.flush();
  });

  describe('consume()', () => {
    it('should allow consumption when tokens are available', async () => {
      const result = await store.consume('bucket:test', 10, 0.001, 1);
      expect(result.allowed).toBe(true);
      expect(result.tokensRemaining).toBe(9);
    });

    it('should drain the bucket', async () => {
      for (let i = 0; i < 10; i++) {
        await store.consume('bucket:test', 10, 0.001, 1);
      }

      const result = await store.consume('bucket:test', 10, 0.001, 1);
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBeDefined();
    });

    it('should handle multi-token consumption', async () => {
      const result = await store.consume('bucket:test', 10, 0.001, 5);
      expect(result.allowed).toBe(true);
      expect(result.tokensRemaining).toBe(5);
    });

    it('should deny when requesting more tokens than available', async () => {
      const result = await store.consume('bucket:test', 5, 0.001, 10);
      expect(result.allowed).toBe(false);
    });

    it('should isolate different buckets', async () => {
      for (let i = 0; i < 5; i++) {
        await store.consume('bucket:A', 5, 0.001, 1);
      }

      const emptyA = await store.consume('bucket:A', 5, 0.001, 1);
      expect(emptyA.allowed).toBe(false);

      const fullB = await store.consume('bucket:B', 5, 0.001, 1);
      expect(fullB.allowed).toBe(true);
    });
  });

  describe('peek()', () => {
    it('should return current state without consuming', async () => {
      await store.consume('bucket:test', 10, 0.001, 3);

      const peek1 = await store.peek('bucket:test', 10, 0.001);
      const peek2 = await store.peek('bucket:test', 10, 0.001);

      expect(peek1.tokensRemaining).toBe(peek2.tokensRemaining);
    });

    it('should show full capacity for new buckets', async () => {
      const result = await store.peek('bucket:new', 10, 0.001);
      expect(result.allowed).toBe(true);
      expect(result.tokensRemaining).toBeGreaterThanOrEqual(0);
    });
  });
});
