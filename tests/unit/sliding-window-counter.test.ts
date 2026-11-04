/**
 * Unit tests for Sliding Window Counter (Hybrid) algorithm.
 */

import { MockRedis } from '../mocks/redis.mock';
import { SlidingWindowCounterStore } from '../../src/algorithms/sliding-window-counter';

describe('SlidingWindowCounterStore', () => {
  let mockRedis: MockRedis;
  let store: SlidingWindowCounterStore;

  beforeEach(() => {
    mockRedis = new MockRedis();
    store = new SlidingWindowCounterStore(mockRedis as any, 0);
  });

  afterEach(() => {
    mockRedis.flush();
  });

  describe('hit()', () => {
    it('should allow requests under the limit', async () => {
      const result = await store.hit('test:counter', 60000, 10);
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(10);
    });

    it('should decrement remaining with each request', async () => {
      const r1 = await store.hit('test:counter', 60000, 5);
      const r2 = await store.hit('test:counter', 60000, 5);
      const r3 = await store.hit('test:counter', 60000, 5);

      expect(r1.remaining).toBeGreaterThan(r2.remaining);
      expect(r2.remaining).toBeGreaterThan(r3.remaining);
    });

    it('should block when limit is reached', async () => {
      for (let i = 0; i < 5; i++) {
        await store.hit('test:counter', 60000, 5);
      }

      const result = await store.hit('test:counter', 60000, 5);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should isolate different keys', async () => {
      for (let i = 0; i < 5; i++) {
        await store.hit('user:A', 60000, 5);
      }

      const blockedA = await store.hit('user:A', 60000, 5);
      expect(blockedA.allowed).toBe(false);

      const allowedB = await store.hit('user:B', 60000, 5);
      expect(allowedB.allowed).toBe(true);
    });

    it('should handle high limits', async () => {
      for (let i = 0; i < 100; i++) {
        const result = await store.hit('test:high', 60000, 1000);
        expect(result.allowed).toBe(true);
      }
    });
  });

  describe('reset()', () => {
    it('should clear the counter', async () => {
      for (let i = 0; i < 5; i++) {
        await store.hit('test:counter', 60000, 5);
      }

      await store.reset('test:counter');

      const result = await store.hit('test:counter', 60000, 5);
      expect(result.allowed).toBe(true);
    });
  });
});
