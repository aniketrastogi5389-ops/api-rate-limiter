/**
 * @fileoverview Express application with rate-limited API routes and monitoring.
 * Demonstrates all rate limiter features with a production-ready setup.
 * @module index
 */

import express from 'express';
import { config } from './config';
import { redisManager, RedisState } from './redis/client';
import { createRateLimiter, createTieredRateLimiter } from './middleware/rate-limiter';
import { Algorithm } from './types';
import { byIP, byAPIKey, byAPIKeyAndRoute } from './utils/key-generators';
import { getMetrics, getContentType } from './metrics/prometheus';
import { metricsCollector } from './metrics/prometheus';

const app = express();
app.use(express.json());

// Trust proxy for accurate IP detection behind load balancers
app.set('trust proxy', 1);

// ─────────────────────────────────────────────────────────
// Health & Metrics Endpoints
// ─────────────────────────────────────────────────────────

app.get('/health', async (_req, res) => {
  const redisLatency = await redisManager.ping();
  const redisUp = redisManager.isAvailable();

  res.status(redisUp ? 200 : 503).json({
    status: redisUp ? 'healthy' : 'degraded',
    uptime: process.uptime(),
    redis: { connected: redisUp, latencyMs: redisLatency, state: redisManager.getState() },
    timestamp: new Date().toISOString(),
  });
});

app.get('/metrics', async (_req, res) => {
  if (!config.metricsEnabled) {
    res.status(404).json({ error: 'Metrics disabled' });
    return;
  }
  res.setHeader('Content-Type', getContentType());
  const metrics = await getMetrics();
  res.send(metrics);
});

// ─────────────────────────────────────────────────────────
// Rate-Limited API Routes
// ─────────────────────────────────────────────────────────

// ── Global rate limit: 200 req/15min per IP (Sliding Window Counter) ──
app.use('/api', createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 200,
  keyGenerator: byIP,
  algorithm: Algorithm.SLIDING_WINDOW_COUNTER,
}));

// ── Tiered API endpoint ──
app.use('/api/v1', createTieredRateLimiter({
  algorithm: Algorithm.SLIDING_WINDOW_COUNTER,
  keyGenerator: byAPIKey,
}));

// ── Strict login endpoint: 5 req/min with Sliding Window Log ──
app.post('/api/auth/login', createRateLimiter({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: byIP,
  algorithm: Algorithm.SLIDING_WINDOW_LOG,
  skipSuccessfulRequests: false,
  message: { error: 'Too many login attempts. Please wait before trying again.' },
}), (_req, res) => {
  res.json({ success: true, message: 'Login successful', token: 'jwt-token-here' });
});

// ── Search endpoint with burst allowance ──
app.get('/api/v1/search', createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: byAPIKeyAndRoute,
  algorithm: Algorithm.SLIDING_WINDOW_COUNTER,
  enableBurst: true,
  burstCapacity: 15,
  burstRefillRate: 5,
}), (req, res) => {
  const query = req.query.q || 'example';
  res.json({ results: [{ id: 1, title: `Result for: ${query}` }], query, timestamp: Date.now() });
});

// ── General data endpoint ──
app.get('/api/v1/data', (_req, res) => {
  res.json({
    message: 'Protected data endpoint',
    data: { items: Array.from({ length: 5 }, (_, i) => ({ id: i + 1, value: Math.random() })) },
    timestamp: Date.now(),
  });
});

// ── User profile ──
app.get('/api/v1/profile', (_req, res) => {
  res.json({ user: { id: 'usr_123', name: 'Demo User', tier: 'free' } });
});

// ─────────────────────────────────────────────────────────
// Server Bootstrap
// ─────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     API Rate Limiter — Starting...       ║');
  console.log('╚══════════════════════════════════════════╝');

  // Initialize Redis connection
  try {
    redisManager.connect();

    // Monitor Redis state changes for metrics
    redisManager.on('stateChange', ({ to }: { from: RedisState; to: RedisState }) => {
      metricsCollector.setRedisConnected(to === RedisState.CONNECTED);
      console.log(`[Redis] State → ${to}`);
    });

    // Wait briefly for connection
    await new Promise(resolve => setTimeout(resolve, 2000));

    if (redisManager.isAvailable()) {
      const latency = await redisManager.ping();
      console.log(`✓ Redis connected (${latency}ms latency)`);
    } else {
      console.warn(`⚠ Redis not available — using ${config.failoverStrategy} strategy`);
    }
  } catch (err) {
    console.warn(`⚠ Redis connection failed: ${(err as Error).message}`);
    console.warn(`  Failover strategy: ${config.failoverStrategy}`);
  }

  // Start HTTP server
  app.listen(config.port, () => {
    console.log(`\n🚀 Rate Limiter API running on http://localhost:${config.port}`);
    console.log(`📊 Metrics: http://localhost:${config.port}/metrics`);
    console.log(`💚 Health:  http://localhost:${config.port}/health`);
    console.log(`\nEndpoints:`);
    console.log(`  POST /api/auth/login    — 5 req/min  (Sliding Window Log)`);
    console.log(`  GET  /api/v1/data       — Tiered     (Free: 100, Pro: 1000)`);
    console.log(`  GET  /api/v1/search     — 30 req/min (+ burst allowance)`);
    console.log(`  GET  /api/v1/profile    — Tiered     (Free: 100, Pro: 1000)`);
  });
}

bootstrap().catch(console.error);

export { app };
