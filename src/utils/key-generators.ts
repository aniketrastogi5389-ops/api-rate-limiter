/**
 * @fileoverview Key generation strategies for rate limiting.
 * Supports per-IP, per-user, per-API-key, and composite keys.
 * @module utils/key-generators
 */

import { Request } from 'express';
import { KeyGenerator } from '../types';

/**
 * Extract client IP address from request.
 * Handles proxy headers (X-Forwarded-For, X-Real-IP) for deployments behind load balancers.
 */
export const byIP: KeyGenerator = (req: Request): string => {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = typeof forwarded === 'string'
    ? forwarded.split(',')[0].trim()
    : req.headers['x-real-ip'] as string || req.ip || req.socket.remoteAddress || 'unknown';
  return `ip:${ip}`;
};

/** Rate limit by API key from X-API-Key header */
export const byAPIKey: KeyGenerator = (req: Request): string => {
  const apiKey = req.headers['x-api-key'] as string;
  if (!apiKey) return byIP(req); // Fall back to IP if no API key
  return `apikey:${apiKey}`;
};

/** Rate limit by authenticated user ID (assumes req.user is set by auth middleware) */
export const byUser: KeyGenerator = (req: Request): string => {
  const user = (req as unknown as Record<string, unknown>).user as { id: string } | undefined;
  if (!user?.id) return byIP(req);
  return `user:${user.id}`;
};

/** Composite key: combines API key/user with route path */
export const byAPIKeyAndRoute: KeyGenerator = (req: Request): string => {
  const base = byAPIKey(req);
  const route = req.baseUrl + req.path;
  return `${base}:${route}`;
};

/** Rate limit by custom header value */
export function byHeader(headerName: string): KeyGenerator {
  return (req: Request): string => {
    const value = req.headers[headerName.toLowerCase()] as string;
    if (!value) return byIP(req);
    return `header:${headerName}:${value}`;
  };
}
