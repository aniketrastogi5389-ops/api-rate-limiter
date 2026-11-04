/**
 * Unit tests for Sliding Window Log algorithm.
 */

import { MockRedis } from '../mocks/redis.mock';
import { SlidingWindowLogStore } from '../../src/algorithms/sliding-window-log';

describe('SlidingWindowLogStore', () => {
  let mockRedis: MockRedis;
  let store: SlidingWindowLogStore;

  beforeEach(() => {
    mockRedis = new MockRedis();
    store = new SlidingWindowLogStore(mockRedis as any, 0); // 0 clock skew for deterministic tests
  });

  afterEach(() => {
    mockRedis.flush();
  });

  describe('hit()', () => {
    it('should allow requests under the limit', async () => {
      const result = await store.hit('test:key', 60000, 5);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);
      expect(result.limit).toBe(5);
    });

    it('should track remaining requests correctly', async () => {
      for (let i = 0; i < 4; i++) {
        await store.hit('test:key', 60000, 5);
      }
      const result = await store.hit('test:key', 60000, 5);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0);
    });

    it('should block requests exceeding the limit', async () => {
      for (let i = 0; i < 5; i++) {
        await store.hit('test:key', 60000, 5);
      }
      const result = await store.hit('test:key', 60000, 5);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBeDefined();
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('should isolate different keys', async () => {
      for (let i = 0; i < 5; i++) {
        await store.hit('user:alice', 60000, 5);
      }

      const aliceResult = await store.hit('user:alice', 60000, 5);
      expect(aliceResult.allowed).toBe(false);

      const bobResult = await store.hit('user:bob', 60000, 5);
      expect(bobResult.allowed).toBe(true);
      expect(bobResult.remaining).toBe(4);
    });

    it('should respect different window sizes', async () => {
      const result1 = await store.hit('test:key', 1000, 100);
      expect(result1.allowed).toBe(true);

      const result2 = await store.hit('test:key', 60000, 100);
      expect(result2.allowed).toBe(true);
    });

    it('should handle single-request limit', async () => {
      const result1 = await store.hit('test:key', 60000, 1);
      expect(result1.allowed).toBe(true);
      expect(result1.remaining).toBe(0);

      const result2 = await store.hit('test:key', 60000, 1);
      expect(result2.allowed).toBe(false);
    });
  });

  describe('peek()', () => {
    it('should return current state without consuming', async () => {
      await store.hit('test:key', 60000, 5);
      await store.hit('test:key', 60000, 5);

      const peek1 = await store.peek('test:key', 60000, 5);
      const peek2 = await store.peek('test:key', 60000, 5);

      // Peeking shouldn't change the count
      expect(peek1.remaining).toBe(peek2.remaining);
    });

    it('should show full capacity for unknown keys', async () => {
      const result = await store.peek('nonexistent', 60000, 10);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
    });
  });

  describe('reset()', () => {
    it('should clear rate limit for a key', async () => {
      for (let i = 0; i < 5; i++) {
        await store.hit('test:key', 60000, 5);
      }

      const blocked = await store.hit('test:key', 60000, 5);
      expect(blocked.allowed).toBe(false);

      await store.reset('test:key');

      const afterReset = await store.hit('test:key', 60000, 5);
      expect(afterReset.allowed).toBe(true);
      expect(afterReset.remaining).toBe(4);
    });
  });

  describe('getActiveKeys()', () => {
    it('should return all active keys', async () => {
      await store.hit('key:1', 60000, 5);
      await store.hit('key:2', 60000, 5);
      await store.hit('key:3', 60000, 5);

      const keys = await store.getActiveKeys();
      expect(keys.length).toBeGreaterThanOrEqual(3);
    });
  });
});
