import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { canonicalManagementValue } from './identity.js';

export { canonicalManagementValue } from './identity.js';

export const secretFingerprintKdfSchema = z.object({
  version: z.literal(1),
  salt: z.string().regex(/^[a-f0-9]{32}$/),
}).strict();
export type SecretFingerprintKdf = z.infer<typeof secretFingerprintKdfSchema>;
export interface SecretFingerprint {
  fingerprint: string;
  fingerprintKdf: SecretFingerprintKdf;
}

export class SecretFingerprintError extends Error {
  constructor(readonly code: 'busy' | 'invalid' | 'failed') {
    super(`Secret fingerprint ${code}`);
  }
}

interface PendingFingerprint {
  input: Buffer;
  salt: Buffer;
  descriptor: SecretFingerprintKdf;
  resolve(value: SecretFingerprint): void;
  reject(error: SecretFingerprintError): void;
}
const pending: PendingFingerprint[] = [];
const maximumRetainedBytes = 8 * 1024 * 1024;
let active = false;
let retainedBytes = 0;

/** A single bounded process-wide queue; only the actual crypto callback releases its input. */
export function deriveSecretFingerprint(
  value: unknown,
  original?: SecretFingerprintKdf
): Promise<SecretFingerprint> {
  let descriptor: SecretFingerprintKdf;
  let input: Buffer;
  try {
    descriptor = original === undefined
      ? { version: 1, salt: randomBytes(16).toString('hex') }
      : secretFingerprintKdfSchema.parse(original);
    if (active && pending.length >= 8) throw new SecretFingerprintError('busy');
    const canonical = canonicalManagementValue(value);
    if (Buffer.byteLength(canonical) + retainedBytes > maximumRetainedBytes)
      throw new SecretFingerprintError('busy');
    input = Buffer.from(canonical);
  } catch (error) {
    return Promise.reject(error instanceof SecretFingerprintError
      ? error : new SecretFingerprintError('invalid'));
  }
  return new Promise((resolve, reject) => {
    retainedBytes += input.length;
    pending.push({ input, salt: Buffer.from(descriptor.salt, 'hex'), descriptor, resolve, reject });
    startNext();
  });
}

function startNext(): void {
  if (active) return;
  const next = pending.shift();
  if (!next) return;
  active = true;
  let finished = false;
  const complete = (error: Error | null, derived?: Buffer): void => {
    if (finished) return;
    finished = true;
    try {
      if (error || !derived || derived.length !== 32)
        next.reject(new SecretFingerprintError('failed'));
      else next.resolve({ fingerprint: derived.toString('hex'), fingerprintKdf: next.descriptor });
    } finally {
      next.input.fill(0);
      next.salt.fill(0);
      derived?.fill(0);
      retainedBytes -= next.input.length;
      active = false;
      startNext();
    }
  };
  try {
    scrypt(next.input, next.salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, complete);
  } catch {
    complete(new Error('Secret fingerprint derivation unavailable'));
  }
}

export function secretFingerprintsEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right))
    throw new SecretFingerprintError('invalid');
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
