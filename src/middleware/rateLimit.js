// ============================================================================
// FILE: src/middleware/rateLimit.js
// PURPOSE: Server-side sliding window rate limiting for Cloudflare Workers.
// ============================================================================

const rateLimitStore = new Map();

/**
 * Creates a rate limit middleware guard.
 * @param {string} keyPrefix - Unique identifier for the route type
 * @param {number} maxRequests - Max requests allowed in the time window
 * @param {number} windowSec - Time window in seconds
 */
export function rateLimiter(keyPrefix, maxRequests = 30, windowSec = 60) {
  return async (c, next) => {
    // Identify client by Cloudflare connecting IP or fallback header
    const clientIp = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
    const rateKey = `${keyPrefix}:${clientIp}`;
    const now = Math.floor(Date.now() / 1000);

    let record = rateLimitStore.get(rateKey);

    if (!record || now > record.resetAt) {
      record = { count: 1, resetAt: now + windowSec };
      rateLimitStore.set(rateKey, record);
    } else {
      record.count++;
    }

    if (record.count > maxRequests) {
      return c.json(
        {
          success: false,
          error: 'Rate limit exceeded. Too many requests, please try again later.',
        },
        429
      );
    }

    // Clean up old memory records periodically
    if (rateLimitStore.size > 5000) {
      for (const [k, v] of rateLimitStore.entries()) {
        if (now > v.resetAt) rateLimitStore.delete(k);
      }
    }

    await next();
  };
}
