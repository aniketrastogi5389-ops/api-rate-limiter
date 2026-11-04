/**
 * @fileoverview Redis client with connection management, health monitoring,
 * and automatic failover detection.
 * @module redis/client
 */

import Redis from 'ioredis';
import { config } from '../config';
import { EventEmitter } from 'events';

/** Redis connection state */
export enum RedisState {
  CONNECTED = 'connected',
  CONNECTING = 'connecting',
  DISCONNECTED = 'disconnected',
  ERROR = 'error',
}

/**
 * Managed Redis client with health monitoring and event emission.
 * Emits 'stateChange' events when connection status changes.
 */
class RedisManager extends EventEmitter {
  private client: Redis | null = null;
  private state: RedisState = RedisState.DISCONNECTED;
  private reconnectAttempts = 0;

  /** Get the current connection state */
  getState(): RedisState {
    return this.state;
  }

  /** Check if Redis is currently available */
  isAvailable(): boolean {
    return this.state === RedisState.CONNECTED;
  }

  /**
   * Initialize the Redis connection.
   * Sets up event handlers for connection lifecycle management.
   */
  connect(): Redis {
    if (this.client) {
      return this.client;
    }

    this.client = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      db: config.redis.db,
      keyPrefix: config.redis.keyPrefix,
      connectTimeout: config.redis.connectTimeout,
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number): number | null => {
        this.reconnectAttempts = times;
        if (times > config.redis.maxReconnectAttempts) {
          this.setState(RedisState.ERROR);
          console.error(
            `[RedisManager] Max reconnection attempts (${config.redis.maxReconnectAttempts}) exceeded. Entering failover mode.`
          );
          return null; // Stop retrying
        }
        // Exponential backoff: 50ms, 100ms, 200ms, ... capped at 3s
        const delay = Math.min(times * 50, 3000);
        console.warn(`[RedisManager] Reconnecting in ${delay}ms (attempt ${times}/${config.redis.maxReconnectAttempts})`);
        return delay;
      },
      lazyConnect: false,
      enableReadyCheck: true,
      ...(config.redis.enableTLS ? { tls: {} } : {}),
    });

    // ── Connection lifecycle events ──────────────────────
    this.client.on('connect', () => {
      this.reconnectAttempts = 0;
      this.setState(RedisState.CONNECTED);
      console.log('[RedisManager] ✓ Connected to Redis');
    });

    this.client.on('ready', () => {
      this.setState(RedisState.CONNECTED);
    });

    this.client.on('error', (err: Error) => {
      console.error(`[RedisManager] Redis error: ${err.message}`);
      // Don't set ERROR state on transient errors while connected
      if (this.state !== RedisState.CONNECTED) {
        this.setState(RedisState.ERROR);
      }
    });

    this.client.on('close', () => {
      this.setState(RedisState.DISCONNECTED);
      console.warn('[RedisManager] Redis connection closed');
    });

    this.client.on('reconnecting', () => {
      this.setState(RedisState.CONNECTING);
    });

    this.client.on('end', () => {
      this.setState(RedisState.DISCONNECTED);
    });

    return this.client;
  }

  /**
   * Get the Redis client instance.
   * @throws Error if not initialized
   */
  getClient(): Redis {
    if (!this.client) {
      return this.connect();
    }
    return this.client;
  }

  /**
   * Gracefully disconnect from Redis.
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      this.setState(RedisState.DISCONNECTED);
      console.log('[RedisManager] Disconnected from Redis');
    }
  }

  /**
   * Health check — ping Redis and return latency in ms.
   * Returns -1 if unreachable.
   */
  async ping(): Promise<number> {
    if (!this.client || !this.isAvailable()) {
      return -1;
    }
    const start = performance.now();
    try {
      await this.client.ping();
      return Math.round(performance.now() - start);
    } catch {
      return -1;
    }
  }

  /** Get reconnection attempt count */
  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  private setState(newState: RedisState): void {
    if (this.state !== newState) {
      const oldState = this.state;
      this.state = newState;
      this.emit('stateChange', { from: oldState, to: newState });
    }
  }
}

/** Singleton Redis manager instance */
export const redisManager = new RedisManager();
