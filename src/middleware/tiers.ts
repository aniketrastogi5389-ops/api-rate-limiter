/**
 * @fileoverview Tiered rate limiting configuration.
 * Defines limits for Free, Pro, and Enterprise subscription tiers.
 * @module middleware/tiers
 */

import { Request } from 'express';
import { Tier, TierConfig, TierConfigMap, TierResolver } from '../types';

/** Default tier configurations */
export const DEFAULT_TIER_CONFIGS: TierConfigMap = {
  [Tier.FREE]: {
    tier: Tier.FREE,
    maxRequests: 100,
    windowMs: 15 * 60 * 1000,  // 15 minutes
    burstCapacity: 10,          // Allow burst of 10 requests
    burstRefillRate: 2,         // 2 tokens/second refill
    unlimited: false,
  },
  [Tier.PRO]: {
    tier: Tier.PRO,
    maxRequests: 1000,
    windowMs: 15 * 60 * 1000,
    burstCapacity: 50,
    burstRefillRate: 10,
    unlimited: false,
  },
  [Tier.ENTERPRISE]: {
    tier: Tier.ENTERPRISE,
    maxRequests: Infinity,
    windowMs: 15 * 60 * 1000,
    burstCapacity: Infinity,
    burstRefillRate: Infinity,
    unlimited: true,
  },
};

/**
 * Default tier resolver — determines tier from API key header.
 * 
 * Convention:
 * - Keys starting with 'ent_' → Enterprise
 * - Keys starting with 'pro_' → Pro
 * - Everything else → Free
 * 
 * In production, replace this with a database/cache lookup.
 */
export const defaultTierResolver: TierResolver = (req: Request): Tier => {
  const apiKey = req.headers['x-api-key'] as string;

  if (!apiKey) return Tier.FREE;
  if (apiKey.startsWith('ent_')) return Tier.ENTERPRISE;
  if (apiKey.startsWith('pro_')) return Tier.PRO;
  return Tier.FREE;
};

/**
 * Get the tier configuration for a given tier.
 * @param tier - Subscription tier
 * @param overrides - Optional custom tier configs
 */
export function getTierConfig(tier: Tier, overrides?: Partial<TierConfigMap>): TierConfig {
  const configs = { ...DEFAULT_TIER_CONFIGS, ...overrides };
  return configs[tier];
}
