/**
 * @fileoverview Core type definitions for the API Rate Limiter.
 * All types are strict — no `any` allowed.
 * @module types
 */

import { Request } from 'express';

// ─────────────────────────────────────────────────────────
// Rate Limit Algorithm Types
// ─────────────────────────────────────────────────────────

/** Supported rate limiting algorithm variants */
export enum Algorithm {
  /** Stores individual request timestamps. O(N) per check. Most accurate. */
  SLIDING_WINDOW_LOG = 'sliding_window_log',
  /** Weighted counter across two fixed windows. O(1) per check. Approximate. */
  SLIDING_WINDOW_COUNTER = 'sliding_window_counter',
}

/** Result of a rate limit check operation */
export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Maximum requests permitted in the window */
  limit: number;
  /** Remaining requests in the current window */
  remaining: number;
  /** Unix timestamp (ms) when the window resets */
  resetTime: number;
  /** Milliseconds until the client should retry (only set when blocked) */
  retryAfter?: number;
}

/** Result of a token bucket check */
export interface TokenBucketResult {
  /** Whether tokens were available */
  allowed: boolean;
  /** Remaining tokens in the bucket */
  tokensRemaining: number;
  /** Milliseconds to wait if denied */
  retryAfterMs?: number;
}

// ─────────────────────────────────────────────────────────
// Rate Limit Store Interface (Strategy Pattern)
// ─────────────────────────────────────────────────────────

/**
 * Abstract interface for rate limit storage backends.
 * Implementations must be atomic and thread-safe.
 */
export interface IRateLimitStore {
  /** Check and consume a rate limit token */
  hit(key: string, windowMs: number, maxRequests: number): Promise<RateLimitResult>;
  /** Get current state without consuming */
  peek(key: string, windowMs: number, maxRequests: number): Promise<RateLimitResult>;
  /** Reset rate limit for a specific key */
  reset(key: string): Promise<void>;
  /** Get all active keys (for inspection) */
  getActiveKeys?(): Promise<string[]>;
}

/** Abstract interface for token bucket storage */
export interface ITokenBucketStore {
  /** Attempt to consume tokens from the bucket */
  consume(key: string, capacity: number, refillRatePerMs: number, tokens?: number): Promise<TokenBucketResult>;
  /** Get current bucket state without consuming */
  peek(key: string, capacity: number, refillRatePerMs: number): Promise<TokenBucketResult>;
}

// ─────────────────────────────────────────────────────────
// Middleware Configuration
// ─────────────────────────────────────────────────────────

/** Key generator function to extract the rate limit key from a request */
export type KeyGenerator = (req: Request) => string;

/** Skip predicate — return true to bypass rate limiting for this request */
export type SkipFunction = (req: Request) => boolean;

/** Handler called when a request is rate limited */
export type RateLimitHandler = (
  req: Request,
  res: import('express').Response,
  next: import('express').NextFunction,
  result: RateLimitResult
) => void;

/** Configuration for the rate limiter middleware factory */
export interface RateLimiterOptions {
  /** Window duration in milliseconds (default: 15 minutes) */
  windowMs: number;

  /** Maximum requests allowed per window (default: 100) */
  max: number;

  /** Function to generate the rate limit key from request */
  keyGenerator: KeyGenerator;

  /** Which algorithm to use */
  algorithm: Algorithm;

  /** Whether to skip counting failed requests (non-2xx responses) */
  skipFailedRequests: boolean;

  /** Whether to skip counting successful requests */
  skipSuccessfulRequests: boolean;

  /** Custom handler when rate limit is exceeded */
  handler: RateLimitHandler;

  /** Function to skip rate limiting entirely for certain requests */
  skip: SkipFunction;

  /** Custom message for 429 responses */
  message: string | Record<string, unknown>;

  /** HTTP status code for rate-limited responses (default: 429) */
  statusCode: number;

  /** Whether to send standard rate limit headers */
  standardHeaders: boolean;

  /** Whether to send legacy X-RateLimit headers */
  legacyHeaders: boolean;

  /** Enable burst allowance via token bucket */
  enableBurst: boolean;

  /** Burst capacity (max tokens in bucket) */
  burstCapacity: number;

  /** Burst refill rate (tokens per second) */
  burstRefillRate: number;

  /** Key prefix for Redis keys */
  keyPrefix: string;

  /** Store implementation override (for testing or custom backends) */
  store?: IRateLimitStore;

  /** Token bucket store override */
  burstStore?: ITokenBucketStore;
}

// ─────────────────────────────────────────────────────────
// Tier Configuration
// ─────────────────────────────────────────────────────────

/** Subscription tier names */
export enum Tier {
  FREE = 'free',
  PRO = 'pro',
  ENTERPRISE = 'enterprise',
}

/** Configuration for a specific subscription tier */
export interface TierConfig {
  /** Tier identifier */
  tier: Tier;
  /** Maximum requests per window */
  maxRequests: number;
  /** Window duration in milliseconds */
  windowMs: number;
  /** Burst capacity (token bucket) */
  burstCapacity: number;
  /** Burst refill rate (tokens per second) */
  burstRefillRate: number;
  /** Whether rate limiting is bypassed entirely */
  unlimited: boolean;
}

/** Maps tier to its configuration */
export type TierConfigMap = Record<Tier, TierConfig>;

/** Function to resolve a request's tier */
export type TierResolver = (req: Request) => Tier | Promise<Tier>;

// ─────────────────────────────────────────────────────────
// Redis / Failover Configuration
// ─────────────────────────────────────────────────────────

/** Redis connection configuration */
export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db: number;
  keyPrefix: string;
  /** Maximum reconnection attempts before failover */
  maxReconnectAttempts: number;
  /** Connection timeout in milliseconds */
  connectTimeout: number;
  /** Enable TLS for Redis connection */
  enableTLS: boolean;
}

/** Strategy when Redis is unavailable */
export enum FailoverStrategy {
  /** Allow all requests through (fail-open) — prioritizes availability */
  FAIL_OPEN = 'fail-open',
  /** Block all requests (fail-closed) — prioritizes security */
  FAIL_CLOSED = 'fail-closed',
  /** Fall back to in-memory store */
  IN_MEMORY_FALLBACK = 'in-memory-fallback',
}

/** Application-wide configuration */
export interface AppConfig {
  port: number;
  nodeEnv: string;
  redis: RedisConfig;
  failoverStrategy: FailoverStrategy;
  clockSkewToleranceMs: number;
  metricsEnabled: boolean;
}

// ─────────────────────────────────────────────────────────
// Metrics Types
// ─────────────────────────────────────────────────────────

/** Labels for Prometheus metrics */
export interface MetricLabels {
  tier?: string;
  algorithm?: string;
  key_type?: string;
  status?: 'allowed' | 'blocked';
}

// ─────────────────────────────────────────────────────────
// CLI Types
// ─────────────────────────────────────────────────────────

/** State of a rate limit key for CLI inspection */
export interface RateLimitKeyState {
  key: string;
  currentCount: number;
  maxRequests: number;
  remaining: number;
  windowMs: number;
  resetTime: number;
  ttlMs: number;
  algorithm: Algorithm;
}
