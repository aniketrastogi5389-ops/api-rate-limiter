/**
 * @fileoverview Redis mock for unit testing.
 * Simulates Redis commands used by the rate limiter.
 */

export interface MockRedisData {
  zsets: Map<string, Map<string, number>>;
  strings: Map<string, string>;
  hashes: Map<string, Map<string, string>>;
  ttls: Map<string, number>;
}

export class MockRedis {
  private data: MockRedisData = {
    zsets: new Map(),
    strings: new Map(),
    hashes: new Map(),
    ttls: new Map(),
  };

  private scripts = new Map<string, string>();
  private scriptCounter = 0;
  public isConnected = true;

  // ── Basic commands ──

  async ping(): Promise<string> {
    if (!this.isConnected) throw new Error('Connection refused');
    return 'PONG';
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.data.zsets.delete(key)) deleted++;
      if (this.data.strings.delete(key)) deleted++;
      if (this.data.hashes.delete(key)) deleted++;
      this.data.ttls.delete(key);
    }
    return deleted;
  }

  async type(key: string): Promise<string> {
    if (this.data.zsets.has(key)) return 'zset';
    if (this.data.strings.has(key)) return 'string';
    if (this.data.hashes.has(key)) return 'hash';
    return 'none';
  }

  async pttl(key: string): Promise<number> {
    return this.data.ttls.get(key) ?? -2;
  }

  // ── Sorted Set commands ──

  async zadd(key: string, score: number, member: string): Promise<number> {
    if (!this.data.zsets.has(key)) this.data.zsets.set(key, new Map());
    this.data.zsets.get(key)!.set(member, score);
    return 1;
  }

  async zcard(key: string): Promise<number> {
    return this.data.zsets.get(key)?.size ?? 0;
  }

  async zremrangebyscore(key: string, min: string | number, max: string | number): Promise<number> {
    const set = this.data.zsets.get(key);
    if (!set) return 0;
    let removed = 0;
    const minScore = min === '-inf' ? -Infinity : Number(min);
    const maxScore = max === '+inf' ? Infinity : Number(max);
    for (const [member, score] of set.entries()) {
      if (score >= minScore && score <= maxScore) {
        set.delete(member);
        removed++;
      }
    }
    return removed;
  }

  async zrange(key: string, start: number, stop: number, ..._opts: string[]): Promise<string[]> {
    const set = this.data.zsets.get(key);
    if (!set) return [];
    const sorted = [...set.entries()].sort((a, b) => a[1] - b[1]);
    const end = stop === -1 ? sorted.length : stop + 1;
    const slice = sorted.slice(start, end);
    if (_opts.includes('WITHSCORES')) {
      return slice.flatMap(([member, score]) => [member, score.toString()]);
    }
    return slice.map(([member]) => member);
  }

  async zcount(key: string, min: string | number, max: string | number): Promise<number> {
    const set = this.data.zsets.get(key);
    if (!set) return 0;
    const minScore = min === '-inf' ? -Infinity : Number(min);
    const maxScore = max === '+inf' ? Infinity : Number(max);
    let count = 0;
    for (const score of set.values()) {
      if (score >= minScore && score <= maxScore) count++;
    }
    return count;
  }

  // ── String commands ──

  async get(key: string): Promise<string | null> {
    return this.data.strings.get(key) ?? null;
  }

  async incr(key: string): Promise<number> {
    const val = parseInt(this.data.strings.get(key) ?? '0', 10) + 1;
    this.data.strings.set(key, val.toString());
    return val;
  }

  // ── Hash commands ──

  async hmset(key: string, ...args: string[]): Promise<'OK'> {
    if (!this.data.hashes.has(key)) this.data.hashes.set(key, new Map());
    const hash = this.data.hashes.get(key)!;
    for (let i = 0; i < args.length; i += 2) {
      hash.set(args[i], args[i + 1]);
    }
    return 'OK';
  }

  async hmget(key: string, ...fields: string[]): Promise<(string | null)[]> {
    const hash = this.data.hashes.get(key);
    if (!hash) return fields.map(() => null);
    return fields.map(f => hash.get(f) ?? null);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const hash = this.data.hashes.get(key);
    if (!hash) return {};
    return Object.fromEntries(hash.entries());
  }

  // ── TTL ──

  async pexpire(key: string, ms: number): Promise<number> {
    this.data.ttls.set(key, ms);
    return 1;
  }

  // ── Scripting ──

  async script(cmd: string, script: string): Promise<string> {
    if (cmd === 'LOAD') {
      const sha = `sha_${++this.scriptCounter}`;
      this.scripts.set(sha, script);
      return sha;
    }
    return '';
  }

  async eval(_script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    return this.executeLuaSimulation(numKeys, args);
  }

  async evalsha(_sha: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    return this.executeLuaSimulation(numKeys, args);
  }

  // ── Scan ──

  async scan(_cursor: string, ..._args: string[]): Promise<[string, string[]]> {
    const allKeys = [
      ...this.data.zsets.keys(),
      ...this.data.strings.keys(),
      ...this.data.hashes.keys(),
    ];
    return ['0', allKeys];
  }

  async quit(): Promise<void> {
    this.isConnected = false;
  }

  // ── Helpers ──

  /** Simplified Lua simulation — supports the sliding window log pattern */
  private executeLuaSimulation(numKeys: number, args: (string | number)[]): number[] {
    const keys = args.slice(0, numKeys).map(String);
    const argv = args.slice(numKeys).map(String);

    // Detect script type by argument count and key count
    if (numKeys === 1 && argv.length === 5) {
      // Sliding Window Log HIT
      return this.simSlidingWindowLogHit(keys[0], argv);
    } else if (numKeys === 2 && argv.length === 4) {
      // Sliding Window Counter HIT
      return this.simSlidingWindowCounterHit(keys[0], keys[1], argv);
    } else if (numKeys === 1 && argv.length === 4) {
      // Token Bucket
      return this.simTokenBucket(keys[0], argv);
    }

    // Peek variants (read-only)
    if (numKeys === 1 && argv.length === 4) {
      return this.simSlidingWindowLogPeek(keys[0], argv);
    }

    return [1, 100, Date.now() + 900000, 0];
  }

  private simSlidingWindowLogHit(key: string, argv: string[]): number[] {
    const now = parseInt(argv[0], 10);
    const windowMs = parseInt(argv[1], 10);
    const maxReqs = parseInt(argv[2], 10);
    const reqId = argv[3];
    const clockSkew = parseInt(argv[4], 10);
    const windowStart = now - windowMs - clockSkew;

    if (!this.data.zsets.has(key)) this.data.zsets.set(key, new Map());
    const set = this.data.zsets.get(key)!;

    // Remove expired
    for (const [member, score] of set.entries()) {
      if (score <= windowStart) set.delete(member);
    }

    if (set.size < maxReqs) {
      set.set(reqId, now);
      return [1, maxReqs - set.size, now + windowMs, set.size];
    }

    return [0, 0, now + windowMs, set.size];
  }

  private simSlidingWindowCounterHit(currKey: string, prevKey: string, argv: string[]): number[] {
    const now = parseInt(argv[0], 10);
    const windowMs = parseInt(argv[1], 10);
    const maxReqs = parseInt(argv[2], 10);
    const clockSkew = parseInt(argv[3], 10);

    const currWindowStart = Math.floor(now / windowMs) * windowMs;
    const elapsed = now - currWindowStart;
    const weight = Math.max(0, (windowMs - elapsed - clockSkew)) / windowMs;

    const prevCount = parseInt(this.data.strings.get(prevKey) ?? '0', 10);
    const currCount = parseInt(this.data.strings.get(currKey) ?? '0', 10);
    const weighted = Math.floor(prevCount * weight) + currCount;

    if (weighted < maxReqs) {
      this.data.strings.set(currKey, (currCount + 1).toString());
      return [1, maxReqs - weighted - 1, currWindowStart + windowMs, weighted + 1];
    }

    return [0, 0, currWindowStart + windowMs, weighted];
  }

  private simTokenBucket(key: string, argv: string[]): number[] {
    const now = parseInt(argv[0], 10);
    const capacity = parseInt(argv[1], 10);
    const refillRate = parseFloat(argv[2]);
    const consume = parseInt(argv[3], 10);

    if (!this.data.hashes.has(key)) {
      this.data.hashes.set(key, new Map([['tokens', capacity.toString()], ['last_refill', now.toString()]]));
    }

    const hash = this.data.hashes.get(key)!;
    let tokens = parseFloat(hash.get('tokens') ?? capacity.toString());
    const lastRefill = parseInt(hash.get('last_refill') ?? now.toString(), 10);

    const elapsed = Math.max(0, now - lastRefill);
    tokens = Math.min(capacity, tokens + elapsed * refillRate);

    if (tokens >= consume) {
      tokens -= consume;
      hash.set('tokens', tokens.toString());
      hash.set('last_refill', now.toString());
      return [1, Math.floor(tokens)];
    }

    hash.set('tokens', tokens.toString());
    hash.set('last_refill', now.toString());
    const waitMs = Math.ceil((consume - tokens) / refillRate);
    return [0, Math.floor(tokens), waitMs];
  }

  private simSlidingWindowLogPeek(key: string, argv: string[]): number[] {
    const now = parseInt(argv[0], 10);
    const windowMs = parseInt(argv[1], 10);
    const maxReqs = parseInt(argv[2], 10);
    const clockSkew = parseInt(argv[3], 10);
    const windowStart = now - windowMs - clockSkew;

    const set = this.data.zsets.get(key);
    if (!set) return [1, maxReqs, now + windowMs, 0];

    let count = 0;
    for (const score of set.values()) {
      if (score > windowStart) count++;
    }

    const remaining = Math.max(0, maxReqs - count);
    return [remaining > 0 ? 1 : 0, remaining, now + windowMs, count];
  }

  /** Clear all data (useful between tests) */
  flush(): void {
    this.data.zsets.clear();
    this.data.strings.clear();
    this.data.hashes.clear();
    this.data.ttls.clear();
  }
}
