/**
 * @fileoverview Atomic Lua scripts for Redis-based rate limiting.
 * 
 * WHY LUA SCRIPTS?
 * ────────────────
 * Redis executes Lua scripts atomically — no other command can interleave.
 * This eliminates race conditions in distributed environments where multiple
 * servers might check-and-increment the same key simultaneously.
 * 
 * Without Lua: GET → check → INCR is 3 separate commands. Between GET and INCR,
 * another server could also GET the old value and both would INCR past the limit.
 * 
 * With Lua: The entire check-and-update runs as a single atomic transaction.
 * 
 * @module redis/lua-scripts
 */

// ─────────────────────────────────────────────────────────────────
// SLIDING WINDOW LOG — O(N) per operation, most accurate
// ─────────────────────────────────────────────────────────────────
//
// Data Structure: Redis Sorted Set (ZSET)
//   - Score = request timestamp (ms)
//   - Member = unique request ID (prevents deduplication)
//
// Algorithm:
//   1. Remove all entries older than (now - windowMs - clockSkew)
//   2. Count remaining entries
//   3. If under limit → add new entry, return allowed
//   4. If at limit → return denied with reset time
//
// Time Complexity: O(N) where N = number of entries to remove
// Space Complexity: O(M) where M = max requests per window
// ─────────────────────────────────────────────────────────────────

export const SLIDING_WINDOW_LOG_SCRIPT = `
-- KEYS[1] = rate limit key (sorted set)
-- ARGV[1] = current timestamp in milliseconds
-- ARGV[2] = window size in milliseconds
-- ARGV[3] = maximum allowed requests
-- ARGV[4] = unique request identifier (UUID)
-- ARGV[5] = clock skew tolerance in milliseconds

local key = KEYS[1]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local max_requests = tonumber(ARGV[3])
local request_id = ARGV[4]
local clock_skew = tonumber(ARGV[5])

-- Step 1: Calculate the window boundary with clock skew tolerance
-- This accounts for slight time differences between distributed servers
local window_start = now - window_ms - clock_skew

-- Step 2: Atomically remove all expired entries
-- ZREMRANGEBYSCORE removes entries with scores (timestamps) below window_start
local removed = redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

-- Step 3: Count remaining (non-expired) entries
local current_count = redis.call('ZCARD', key)

if current_count < max_requests then
    -- ALLOWED: Add the new request with its timestamp as score
    redis.call('ZADD', key, now, request_id)
    
    -- Set TTL to window + clock_skew to auto-cleanup
    -- This prevents orphaned keys from accumulating
    redis.call('PEXPIRE', key, window_ms + clock_skew + 1000)
    
    local remaining = max_requests - current_count - 1
    local reset_at = now + window_ms
    
    -- Return: {allowed=1, remaining, reset_timestamp, current_count}
    return {1, remaining, reset_at, current_count + 1}
else
    -- DENIED: Find when the oldest request will expire
    -- The oldest entry's timestamp + window = when a slot opens
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local reset_at = now + window_ms
    
    if oldest and #oldest >= 2 then
        reset_at = tonumber(oldest[2]) + window_ms + clock_skew
    end
    
    -- Return: {allowed=0, remaining=0, reset_timestamp, current_count}
    return {0, 0, reset_at, current_count}
end
`;

// ─────────────────────────────────────────────────────────────────
// SLIDING WINDOW LOG — PEEK (read-only, no mutation)
// ─────────────────────────────────────────────────────────────────

export const SLIDING_WINDOW_LOG_PEEK_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local max_requests = tonumber(ARGV[3])
local clock_skew = tonumber(ARGV[4])

local window_start = now - window_ms - clock_skew
local current_count = redis.call('ZCOUNT', key, window_start, '+inf')
local remaining = math.max(0, max_requests - current_count)
local reset_at = now + window_ms

return {remaining > 0 and 1 or 0, remaining, reset_at, current_count}
`;

// ─────────────────────────────────────────────────────────────────
// SLIDING WINDOW COUNTER (HYBRID) — O(1) per operation, approximate
// ─────────────────────────────────────────────────────────────────
//
// Data Structure: Two Redis keys (counters for current and previous window)
//
// Algorithm:
//   1. Determine current fixed window boundary
//   2. Calculate weight of previous window based on elapsed time
//   3. Weighted count = (prev_count × weight) + curr_count
//   4. If under limit → increment current counter, return allowed
//   5. If at limit → return denied
//
// Example with 15-minute window at minute 22:
//   - Previous window: 15:00-30:00 (had 80 requests)
//   - Current window:  30:00-45:00 (has 30 requests)
//   - Elapsed in current: 7 minutes → weight = (15-7)/15 = 0.533
//   - Weighted count: floor(80 × 0.533) + 30 = 42 + 30 = 72
//
// Time Complexity: O(1) — constant time operations
// Space Complexity: O(1) — exactly 2 keys
// ─────────────────────────────────────────────────────────────────

export const SLIDING_WINDOW_COUNTER_SCRIPT = `
-- KEYS[1] = current window counter key
-- KEYS[2] = previous window counter key
-- ARGV[1] = current timestamp in milliseconds
-- ARGV[2] = window size in milliseconds
-- ARGV[3] = maximum allowed requests
-- ARGV[4] = clock skew tolerance in milliseconds

local curr_key = KEYS[1]
local prev_key = KEYS[2]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local max_requests = tonumber(ARGV[3])
local clock_skew = tonumber(ARGV[4])

-- Step 1: Calculate current window boundaries
-- Floor division to find the start of the current fixed window
local curr_window_start = math.floor(now / window_ms) * window_ms
local elapsed = now - curr_window_start

-- Step 2: Calculate the weight of the previous window
-- The more time has elapsed in the current window, the less weight the previous has
-- At window start: weight = 1.0 (full previous window counts)
-- At window end: weight = 0.0 (previous window irrelevant)
local weight = math.max(0, (window_ms - elapsed - clock_skew)) / window_ms

-- Step 3: Get counters for both windows
local prev_count = tonumber(redis.call('GET', prev_key) or '0')
local curr_count = tonumber(redis.call('GET', curr_key) or '0')

-- Step 4: Calculate the weighted sliding window count
local weighted_count = math.floor(prev_count * weight) + curr_count

if weighted_count < max_requests then
    -- ALLOWED: Increment current window counter
    local new_count = redis.call('INCR', curr_key)
    
    -- Set TTL to 2x window to keep prev window available for next window's calculation
    redis.call('PEXPIRE', curr_key, window_ms * 2 + clock_skew)
    
    local remaining = max_requests - weighted_count - 1
    local reset_at = curr_window_start + window_ms
    
    return {1, remaining, reset_at, weighted_count + 1}
else
    -- DENIED: Calculate when capacity opens
    local reset_at = curr_window_start + window_ms
    
    return {0, 0, reset_at, weighted_count}
end
`;

// ─────────────────────────────────────────────────────────────────
// SLIDING WINDOW COUNTER — PEEK (read-only)
// ─────────────────────────────────────────────────────────────────

export const SLIDING_WINDOW_COUNTER_PEEK_SCRIPT = `
local curr_key = KEYS[1]
local prev_key = KEYS[2]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local max_requests = tonumber(ARGV[3])
local clock_skew = tonumber(ARGV[4])

local curr_window_start = math.floor(now / window_ms) * window_ms
local elapsed = now - curr_window_start
local weight = math.max(0, (window_ms - elapsed - clock_skew)) / window_ms

local prev_count = tonumber(redis.call('GET', prev_key) or '0')
local curr_count = tonumber(redis.call('GET', curr_key) or '0')
local weighted_count = math.floor(prev_count * weight) + curr_count

local remaining = math.max(0, max_requests - weighted_count)
local reset_at = curr_window_start + window_ms

return {remaining > 0 and 1 or 0, remaining, reset_at, weighted_count}
`;

// ─────────────────────────────────────────────────────────────────
// TOKEN BUCKET — For burst allowance
// ─────────────────────────────────────────────────────────────────
//
// Data Structure: Redis Hash with 'tokens' and 'last_refill' fields
//
// Algorithm:
//   1. Read current bucket state (tokens + last refill time)
//   2. Calculate tokens to add based on elapsed time × refill rate
//   3. Cap tokens at bucket capacity
//   4. If enough tokens → consume and allow
//   5. If not enough → deny and calculate wait time
//
// Properties:
//   - Allows burst traffic up to bucket capacity
//   - Steady-state rate equals refill rate
//   - Smooths out traffic spikes without hard cutoffs
//
// Time Complexity: O(1)
// Space Complexity: O(1) — single hash key
// ─────────────────────────────────────────────────────────────────

export const TOKEN_BUCKET_SCRIPT = `
-- KEYS[1] = bucket key (hash)
-- ARGV[1] = current timestamp in milliseconds
-- ARGV[2] = bucket capacity (maximum tokens)
-- ARGV[3] = refill rate (tokens per millisecond)
-- ARGV[4] = tokens to consume (usually 1)

local key = KEYS[1]
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refill_rate = tonumber(ARGV[3])
local consume = tonumber(ARGV[4])

-- Step 1: Get current bucket state
local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(bucket[1])
local last_refill = tonumber(bucket[2])

-- Step 2: Initialize if bucket doesn't exist
if tokens == nil then
    tokens = capacity
    last_refill = now
end

-- Step 3: Refill tokens based on elapsed time
local elapsed = math.max(0, now - last_refill)
local refill = elapsed * refill_rate
tokens = math.min(capacity, tokens + refill)

if tokens >= consume then
    -- ALLOWED: Consume tokens
    tokens = tokens - consume
    redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
    
    -- TTL: time to fully refill from 0 + buffer
    local ttl_ms = math.ceil(capacity / refill_rate) + 5000
    redis.call('PEXPIRE', key, ttl_ms)
    
    return {1, math.floor(tokens)}
else
    -- DENIED: Update last_refill for accurate future calculations
    redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
    
    local ttl_ms = math.ceil(capacity / refill_rate) + 5000
    redis.call('PEXPIRE', key, ttl_ms)
    
    -- Calculate how long until enough tokens are available
    local deficit = consume - tokens
    local wait_ms = math.ceil(deficit / refill_rate)
    
    return {0, math.floor(tokens), wait_ms}
end
`;

// ─────────────────────────────────────────────────────────────────
// TOKEN BUCKET — PEEK (read-only)
// ─────────────────────────────────────────────────────────────────

export const TOKEN_BUCKET_PEEK_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refill_rate = tonumber(ARGV[3])

local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(bucket[1])
local last_refill = tonumber(bucket[2])

if tokens == nil then
    return {1, capacity}
end

local elapsed = math.max(0, now - last_refill)
local refill = elapsed * refill_rate
tokens = math.min(capacity, tokens + refill)

return {tokens >= 1 and 1 or 0, math.floor(tokens)}
`;
