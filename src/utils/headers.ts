/**
 * @fileoverview Rate limit response headers following RFC 6585 and draft-ietf-httpapi-ratelimit-headers.
 * @module utils/headers
 */

import { Response } from 'express';
import { RateLimitResult } from '../types';

/**
 * Set standard rate limit headers on the response.
 * Headers follow the IETF draft specification for HTTP rate limit headers.
 * 
 * Headers set:
 * - X-RateLimit-Limit: Maximum requests allowed in the window
 * - X-RateLimit-Remaining: Remaining requests in the current window
 * - X-RateLimit-Reset: Unix timestamp (seconds) when the window resets
 * - Retry-After: Seconds to wait before retrying (only on 429)
 */
export function setRateLimitHeaders(res: Response, result: RateLimitResult): void {
  res.setHeader('X-RateLimit-Limit', result.limit);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, result.remaining));
  res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetTime / 1000));

  if (!result.allowed && result.retryAfter) {
    res.setHeader('Retry-After', Math.ceil(result.retryAfter / 1000));
  }
}

/**
 * Set modern RateLimit headers (draft-ietf-httpapi-ratelimit-headers-07).
 * These use the standardized naming without the X- prefix.
 */
export function setStandardHeaders(res: Response, result: RateLimitResult): void {
  const resetSeconds = Math.max(0, Math.ceil((result.resetTime - Date.now()) / 1000));
  res.setHeader('RateLimit-Limit', result.limit);
  res.setHeader('RateLimit-Remaining', Math.max(0, result.remaining));
  res.setHeader('RateLimit-Reset', resetSeconds);

  if (!result.allowed && result.retryAfter) {
    res.setHeader('Retry-After', Math.ceil(result.retryAfter / 1000));
  }
}
