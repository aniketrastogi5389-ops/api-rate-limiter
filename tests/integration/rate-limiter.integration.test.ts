/**
 * Integration tests for the rate limiter middleware.
 * Tests the full middleware pipeline with mock Redis.
 */

import express, { Express } from 'express';
import http from 'http';

// Mock Redis and metrics before importing middleware
jest.mock('../../src/redis/client', () => {
  const { EventEmitter } = require('events');
  class MockRedisManager extends EventEmitter {
    isAvailable() { return false; }
    getState() { return 'disconnected'; }
    getClient() { throw new Error('Not connected'); }
    connect() { throw new Error('Not connected'); }
    async ping() { return -1; }
  }
  return { redisManager: new MockRedisManager(), RedisState: { CONNECTED: 'connected' } };
});

jest.mock('../../src/config', () => ({
  config: {
    port: 0,
    nodeEnv: 'test',
    redis: { host: 'localhost', port: 6379, keyPrefix: 'test:', maxReconnectAttempts: 1, connectTimeout: 100 },
    failoverStrategy: 'in-memory-fallback',
    clockSkewToleranceMs: 0,
    metricsEnabled: false,
  },
}));

jest.mock('../../src/metrics/prometheus', () => ({
  metricsCollector: {
    recordRequest: jest.fn(),
    recordRedisLatency: jest.fn(),
    recordFailover: jest.fn(),
    recordError: jest.fn(),
    setActiveKeys: jest.fn(),
    setRedisConnected: jest.fn(),
  },
  getMetrics: jest.fn(async () => ''),
  getContentType: jest.fn(() => 'text/plain'),
}));

import { createRateLimiter } from '../../src/middleware/rate-limiter';
import { Algorithm } from '../../src/types';
import { byIP } from '../../src/utils/key-generators';

function makeRequest(app: Express, path: string, headers: Record<string, string> = {}): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') { server.close(); reject(new Error('Bad addr')); return; }

      const req = http.request({ hostname: '127.0.0.1', port: addr.port, path, method: 'GET', headers }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode || 0, headers: res.headers, body });
        });
      });
      req.on('error', (err) => { server.close(); reject(err); });
      req.end();
    });
  });
}

describe('Rate Limiter Middleware (In-Memory Fallback)', () => {
  it('should allow requests under the limit', async () => {
    const app = express();
    app.use(createRateLimiter({ windowMs: 60000, max: 5, keyGenerator: byIP, algorithm: Algorithm.SLIDING_WINDOW_COUNTER }));
    app.get('/test', (_req, res) => res.json({ ok: true }));

    const resp = await makeRequest(app, '/test');
    expect(resp.status).toBe(200);
  });

  it('should set rate limit headers', async () => {
    const app = express();
    app.use(createRateLimiter({ windowMs: 60000, max: 10, keyGenerator: byIP }));
    app.get('/test', (_req, res) => res.json({ ok: true }));

    const resp = await makeRequest(app, '/test');
    expect(resp.headers['x-ratelimit-limit']).toBe('10');
    expect(resp.headers['x-ratelimit-remaining']).toBeDefined();
    expect(resp.headers['x-ratelimit-reset']).toBeDefined();
    expect(resp.headers['ratelimit-limit']).toBe('10');
  });

  it('should block requests exceeding the limit', async () => {
    const app = express();
    // Use a very low limit for testing
    app.use(createRateLimiter({ windowMs: 60000, max: 2, keyGenerator: () => 'fixed-key' }));
    app.get('/test', (_req, res) => res.json({ ok: true }));

    // First two should pass
    await makeRequest(app, '/test');
    await makeRequest(app, '/test');

    // Third should be blocked
    const resp = await makeRequest(app, '/test');
    expect(resp.status).toBe(429);

    const body = JSON.parse(resp.body);
    expect(body.error).toBe('Too Many Requests');
    expect(resp.headers['retry-after']).toBeDefined();
  });

  it('should skip rate limiting when skip function returns true', async () => {
    const app = express();
    app.use(createRateLimiter({
      windowMs: 60000, max: 1, keyGenerator: () => 'skip-key',
      skip: (req) => req.path === '/health',
    }));
    app.get('/health', (_req, res) => res.json({ ok: true }));
    app.get('/test', (_req, res) => res.json({ ok: true }));

    // Should always pass for /health
    const r1 = await makeRequest(app, '/health');
    const r2 = await makeRequest(app, '/health');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  it('should respect different API keys', async () => {
    const app = express();
    app.use(createRateLimiter({
      windowMs: 60000, max: 1,
      keyGenerator: (req) => req.headers['x-api-key'] as string || 'anon',
    }));
    app.get('/test', (_req, res) => res.json({ ok: true }));

    // User A: allowed then blocked
    const a1 = await makeRequest(app, '/test', { 'x-api-key': 'user-a' });
    expect(a1.status).toBe(200);
    const a2 = await makeRequest(app, '/test', { 'x-api-key': 'user-a' });
    expect(a2.status).toBe(429);

    // User B: still allowed (different key)
    const b1 = await makeRequest(app, '/test', { 'x-api-key': 'user-b' });
    expect(b1.status).toBe(200);
  });
});
