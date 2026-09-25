import crypto from 'node:crypto';

// A process-local salt keeps cache identifiers unlinkable across app restarts.
// Scrypt also limits offline guessing if a cache snapshot is exposed.
const CACHE_SALT = crypto.randomBytes(32);

export function hashCredentialForCache(value: string): string {
  return crypto.scryptSync(value, CACHE_SALT, 32, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 32 * 1024 * 1024,
  }).toString('hex');
}
