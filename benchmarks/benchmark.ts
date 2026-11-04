/**
 * @fileoverview Performance benchmark for rate limiter algorithms.
 * Measures throughput (ops/sec) and latency (p50, p95, p99) for each algorithm.
 * 
 * Run: npx ts-node benchmarks/benchmark.ts
 */

import { MemorySlidingWindowLogStore, MemoryTokenBucketStore } from '../src/fallback/memory-store';

interface BenchmarkResult {
  algorithm: string;
  totalOps: number;
  durationMs: number;
  opsPerSec: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  avgMs: number;
}

async function benchmark(
  name: string,
  fn: () => Promise<void>,
  iterations: number
): Promise<BenchmarkResult> {
  const latencies: number[] = [];

  // Warmup
  for (let i = 0; i < 100; i++) {
    await fn();
  }

  const startTime = performance.now();

  for (let i = 0; i < iterations; i++) {
    const opStart = performance.now();
    await fn();
    latencies.push(performance.now() - opStart);
  }

  const duration = performance.now() - startTime;
  latencies.sort((a, b) => a - b);

  return {
    algorithm: name,
    totalOps: iterations,
    durationMs: Math.round(duration),
    opsPerSec: Math.round(iterations / (duration / 1000)),
    p50Ms: parseFloat(latencies[Math.floor(latencies.length * 0.5)].toFixed(4)),
    p95Ms: parseFloat(latencies[Math.floor(latencies.length * 0.95)].toFixed(4)),
    p99Ms: parseFloat(latencies[Math.floor(latencies.length * 0.99)].toFixed(4)),
    avgMs: parseFloat((latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(4)),
  };
}

async function run(): Promise<void> {
  const ITERATIONS = 10000;

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║           Rate Limiter Performance Benchmark                ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`\nIterations per test: ${ITERATIONS.toLocaleString()}\n`);

  // ── Sliding Window Log (In-Memory) ──
  const logStore = new MemorySlidingWindowLogStore();
  let logCounter = 0;
  const logResult = await benchmark(
    'Sliding Window Log (Memory)',
    async () => {
      await logStore.hit(`bench:log:${logCounter++ % 100}`, 60000, 1000);
    },
    ITERATIONS
  );
  logStore.destroy();

  // ── Token Bucket (In-Memory) ──
  const bucketStore = new MemoryTokenBucketStore();
  let bucketCounter = 0;
  const bucketResult = await benchmark(
    'Token Bucket (Memory)',
    async () => {
      await bucketStore.consume(`bench:bucket:${bucketCounter++ % 100}`, 100, 0.01, 1);
    },
    ITERATIONS
  );
  bucketStore.destroy();

  // ── Mixed workload: Log + Burst ──
  const mixedLog = new MemorySlidingWindowLogStore();
  const mixedBucket = new MemoryTokenBucketStore();
  let mixedCounter = 0;
  const mixedResult = await benchmark(
    'Mixed: Log + Token Bucket',
    async () => {
      const key = `bench:mixed:${mixedCounter++ % 100}`;
      const result = await mixedLog.hit(key, 60000, 50);
      if (!result.allowed) {
        await mixedBucket.consume(key, 10, 0.005, 1);
      }
    },
    ITERATIONS
  );
  mixedLog.destroy();
  mixedBucket.destroy();

  // ── High contention (single key) ──
  const contentionStore = new MemorySlidingWindowLogStore();
  const contentionResult = await benchmark(
    'High Contention (1 key)',
    async () => {
      await contentionStore.hit('single-key', 60000, 100000);
    },
    ITERATIONS
  );
  contentionStore.destroy();

  // ── Print results ──
  const results = [logResult, bucketResult, mixedResult, contentionResult];

  console.log('┌─────────────────────────────────┬───────────┬───────────┬──────────┬──────────┬──────────┐');
  console.log('│ Algorithm                       │ Ops/sec   │ Avg (ms)  │ P50 (ms) │ P95 (ms) │ P99 (ms) │');
  console.log('├─────────────────────────────────┼───────────┼───────────┼──────────┼──────────┼──────────┤');

  for (const r of results) {
    console.log(
      `│ ${r.algorithm.padEnd(31)} │ ${r.opsPerSec.toLocaleString().padStart(9)} │ ${r.avgMs.toFixed(4).padStart(9)} │ ${r.p50Ms.toFixed(4).padStart(8)} │ ${r.p95Ms.toFixed(4).padStart(8)} │ ${r.p99Ms.toFixed(4).padStart(8)} │`
    );
  }

  console.log('└─────────────────────────────────┴───────────┴───────────┴──────────┴──────────┴──────────┘');

  console.log('\n✅ Benchmark complete');
  console.log('\nNote: Redis-backed benchmarks require a running Redis instance.');
  console.log('Run `docker-compose up redis` then modify this script to use Redis stores.');
}

run().catch(console.error);
