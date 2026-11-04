/**
 * @fileoverview Prometheus metrics for rate limiter observability.
 * Exposes request rates, Redis latency, failover events, and error counts.
 * @module metrics/prometheus
 */

import client from 'prom-client';

// Create a custom registry to avoid conflicts
const register = new client.Registry();

// Add default Node.js metrics (GC, event loop, memory)
client.collectDefaultMetrics({ register, prefix: 'ratelimiter_' });

// ─────────────────────────────────────────────────────────
// Custom Metrics
// ─────────────────────────────────────────────────────────

/** Total rate limit decisions (allowed vs blocked) */
const requestsTotal = new client.Counter({
  name: 'ratelimiter_requests_total',
  help: 'Total number of rate limit checks',
  labelNames: ['status', 'algorithm'] as const,
  registers: [register],
});

/** Redis operation latency histogram */
const redisLatency = new client.Histogram({
  name: 'ratelimiter_redis_latency_ms',
  help: 'Redis operation latency in milliseconds',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 25, 50, 100],
  registers: [register],
});

/** Number of failover events (Redis → in-memory) */
const failoverEvents = new client.Counter({
  name: 'ratelimiter_failover_events_total',
  help: 'Total failover events from Redis to fallback store',
  registers: [register],
});

/** Rate limiter errors */
const errors = new client.Counter({
  name: 'ratelimiter_errors_total',
  help: 'Total rate limiter errors',
  registers: [register],
});

/** Currently active rate limit keys gauge */
const activeKeys = new client.Gauge({
  name: 'ratelimiter_active_keys',
  help: 'Number of currently active rate limit keys',
  registers: [register],
});

/** Redis connection state gauge (1=connected, 0=disconnected) */
const redisConnected = new client.Gauge({
  name: 'ratelimiter_redis_connected',
  help: 'Redis connection state (1=connected, 0=disconnected)',
  registers: [register],
});

// ─────────────────────────────────────────────────────────
// Metrics Collector (facade for easy recording)
// ─────────────────────────────────────────────────────────

export const metricsCollector = {
  recordRequest(status: 'allowed' | 'blocked', algorithm: string): void {
    requestsTotal.inc({ status, algorithm });
  },

  recordRedisLatency(latencyMs: number): void {
    redisLatency.observe(latencyMs);
  },

  recordFailover(): void {
    failoverEvents.inc();
  },

  recordError(): void {
    errors.inc();
  },

  setActiveKeys(count: number): void {
    activeKeys.set(count);
  },

  setRedisConnected(connected: boolean): void {
    redisConnected.set(connected ? 1 : 0);
  },
};

/** Get the Prometheus metrics registry */
export function getMetricsRegistry(): client.Registry {
  return register;
}

/** Render metrics as Prometheus text format */
export async function getMetrics(): Promise<string> {
  return register.metrics();
}

/** Get content type for Prometheus scraping */
export function getContentType(): string {
  return register.contentType;
}
