/**
 * @fileoverview Application configuration loaded from environment variables.
 * Uses dotenv for local development, environment variables in production.
 * @module config
 */

import dotenv from 'dotenv';
import { AppConfig, FailoverStrategy } from './types';

// Load .env file in non-production environments
dotenv.config();

/**
 * Parse a failover strategy string into the enum value.
 * Defaults to FAIL_OPEN for maximum availability.
 */
function parseFailoverStrategy(value: string | undefined): FailoverStrategy {
  switch (value?.toLowerCase()) {
    case 'fail-closed':
      return FailoverStrategy.FAIL_CLOSED;
    case 'in-memory-fallback':
      return FailoverStrategy.IN_MEMORY_FALLBACK;
    case 'fail-open':
    default:
      return FailoverStrategy.FAIL_OPEN;
  }
}

/** Validated application configuration */
export const config: AppConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB || '0', 10),
    keyPrefix: process.env.REDIS_KEY_PREFIX || 'rl:',
    maxReconnectAttempts: parseInt(process.env.REDIS_MAX_RECONNECT || '10', 10),
    connectTimeout: parseInt(process.env.REDIS_CONNECT_TIMEOUT || '5000', 10),
    enableTLS: process.env.REDIS_TLS === 'true',
  },

  failoverStrategy: parseFailoverStrategy(process.env.REDIS_FAILOVER_STRATEGY),
  clockSkewToleranceMs: parseInt(process.env.CLOCK_SKEW_TOLERANCE_MS || '1000', 10),
  metricsEnabled: process.env.METRICS_ENABLED !== 'false',
};
