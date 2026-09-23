import crypto from 'node:crypto';

// A per-process HMAC key prevents cache identifiers from becoming offline API-key guesses.
const CACHE_HMAC_KEY = crypto.randomBytes(32);

export function hashCredentialForCache(value: string): string {
  return crypto.createHmac('sha256', CACHE_HMAC_KEY).update(value).digest('hex');
}
