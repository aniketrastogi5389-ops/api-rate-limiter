/**
 * Unit tests for the in-memory fallback stores.
 */

import {
  MemorySlidingWindowLogStore,
  MemoryTokenBucketStore,
} from '../../src/fallback/memory-store';

describe('MemorySlidingWindowLogStore', () => {
  let store: MemorySlidingWindowLogStore;

  beforeEach(() => {
    store = new MemorySlidingWindowLogStore(100);
  });

  afterEach(() => {
    store.destroy();
  });

  it('should allow requests under the limit', async () => {
    const result = await store.hit('test', 60000, 5);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('should block requests over the limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.hit('test', 60000, 5);
    }
    const result = await store.hit('test', 60000, 5);
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it('should reset correctly', async () => {
    for (let i = 0; i < 5; i++) {
      await store.hit('test', 60000, 5);
    }
    await store.reset('test');
    const result = await store.hit('test', 60000, 5);
    expect(result.allowed).toBe(true);
  });

  it('should isolate keys', async () => {
    for (let i = 0; i < 5; i++) {
      await store.hit('key1', 60000, 5);
    }
    const result = await store.hit('key2', 60000, 5);
    expect(result.allowed).toBe(true);
  });

  it('should return active keys', async () => {
    await store.hit('k1', 60000, 5);
    await store.hit('k2', 60000, 5);
    const keys = await store.getActiveKeys();
    expect(keys).toContain('k1');
    expect(keys).toContain('k2');
  });
});

describe('MemoryTokenBucketStore', () => {
  let store: MemoryTokenBucketStore;

  beforeEach(() => {
    store = new MemoryTokenBucketStore();
  });

  afterEach(() => {
    store.destroy();
  });

  it('should allow when tokens available', async () => {
    const result = await store.consume('test', 10, 0.001, 1);
    expect(result.allowed).toBe(true);
    expect(result.tokensRemaining).toBe(9);
  });

  it('should deny when tokens exhausted', async () => {
    for (let i = 0; i < 10; i++) {
      await store.consume('test', 10, 0.001, 1);
    }
    const result = await store.consume('test', 10, 0.001, 1);
    expect(result.allowed).toBe(false);
  });

  it('should peek without consuming', async () => {
    await store.consume('test', 10, 0.001, 5);
    const p1 = await store.peek('test', 10, 0.001);
    const p2 = await store.peek('test', 10, 0.001);
    expect(p1.tokensRemaining).toBe(p2.tokensRemaining);
  });
});
