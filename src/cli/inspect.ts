/**
 * @fileoverview CLI tool to inspect current rate limit state for any key.
 * Usage: npx ts-node src/cli/inspect.ts --key "ip:192.168.1.1"
 * @module cli/inspect
 */

import { Command } from 'commander';
import Redis from 'ioredis';
import { config } from '../config';

const program = new Command();

program
  .name('rl-inspect')
  .description('Inspect rate limit state for any key')
  .version('1.0.0');

program
  .command('inspect')
  .description('Inspect a specific rate limit key')
  .requiredOption('-k, --key <key>', 'Rate limit key to inspect')
  .option('-p, --prefix <prefix>', 'Key prefix', config.redis.keyPrefix)
  .action(async (opts: { key: string; prefix: string }) => {
    const redis = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      db: config.redis.db,
      keyPrefix: opts.prefix,
    });

    try {
      const fullKey = opts.key;
      console.log(`\n🔍 Inspecting key: ${opts.prefix}${fullKey}\n`);

      // Check if it's a ZSET (sliding window log)
      const type = await redis.type(fullKey);
      console.log(`  Type: ${type}`);

      if (type === 'zset') {
        const count = await redis.zcard(fullKey);
        const entries = await redis.zrange(fullKey, 0, -1, 'WITHSCORES');
        const ttl = await redis.pttl(fullKey);

        console.log(`  Current count: ${count}`);
        console.log(`  TTL: ${ttl}ms`);
        console.log(`  Entries:`);

        for (let i = 0; i < entries.length; i += 2) {
          const timestamp = parseInt(entries[i + 1], 10);
          console.log(`    ${entries[i]} → ${new Date(timestamp).toISOString()}`);
        }
      } else if (type === 'string') {
        const value = await redis.get(fullKey);
        const ttl = await redis.pttl(fullKey);
        console.log(`  Count: ${value}`);
        console.log(`  TTL: ${ttl}ms`);
      } else if (type === 'hash') {
        const values = await redis.hgetall(fullKey);
        const ttl = await redis.pttl(fullKey);
        console.log(`  Bucket state:`, values);
        console.log(`  TTL: ${ttl}ms`);
      } else {
        console.log(`  Key not found or unsupported type`);
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
    } finally {
      await redis.quit();
    }
  });

program
  .command('list')
  .description('List all active rate limit keys')
  .option('-p, --prefix <prefix>', 'Key prefix', config.redis.keyPrefix)
  .option('-l, --limit <limit>', 'Max keys to show', '50')
  .action(async (opts: { prefix: string; limit: string }) => {
    const redis = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      db: config.redis.db,
    });

    try {
      const keys: string[] = [];
      let cursor = '0';
      const maxKeys = parseInt(opts.limit, 10);

      do {
        const [next, batch] = await redis.scan(cursor, 'MATCH', `${opts.prefix}*`, 'COUNT', 100);
        cursor = next;
        keys.push(...batch);
        if (keys.length >= maxKeys) break;
      } while (cursor !== '0');

      console.log(`\n📋 Active rate limit keys (${keys.length}):\n`);
      for (const key of keys.slice(0, maxKeys)) {
        const type = await redis.type(key);
        const ttl = await redis.pttl(key);
        console.log(`  ${key} [${type}] TTL: ${ttl}ms`);
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
    } finally {
      await redis.quit();
    }
  });

program
  .command('reset')
  .description('Reset rate limit for a key')
  .requiredOption('-k, --key <key>', 'Rate limit key to reset')
  .option('-p, --prefix <prefix>', 'Key prefix', config.redis.keyPrefix)
  .action(async (opts: { key: string; prefix: string }) => {
    const redis = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      db: config.redis.db,
    });

    try {
      // Delete all related keys (base, window variants, burst)
      const patterns = [
        `${opts.prefix}${opts.key}`,
        `${opts.prefix}${opts.key}:w:*`,
        `${opts.prefix}${opts.key}:burst`,
      ];

      let deleted = 0;
      for (const pattern of patterns) {
        let cursor = '0';
        do {
          const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
          cursor = next;
          if (batch.length > 0) {
            deleted += await redis.del(...batch);
          }
        } while (cursor !== '0');
      }

      console.log(`\n✅ Reset ${deleted} key(s) for: ${opts.key}\n`);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
    } finally {
      await redis.quit();
    }
  });

program.parse();
