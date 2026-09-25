import { createHash, createPrivateKey, createPublicKey, timingSafeEqual } from 'node:crypto';
import { closeSync, fstatSync, readSync } from 'node:fs';

import type { KeyObject } from 'node:crypto';

const MAX_PKCS8_BYTES = 4096;
const SPKI_SHA256 = /^[0-9a-f]{64}$/u;

/**
 * Inactive Product key custody port. The trusted launcher supplies a fixed inherited FD,
 * never a path, argv value, or environment variable. The FD must refer to a private,
 * already-unlinked regular file and is consumed once, then closed even on failure.
 */
export function createHostedMemberPrivateKeyFdProvider(input: {
  readonly fd: number;
  readonly spkiSha256: string;
}): { loadPrivateKey(): Promise<KeyObject>; dispose(): void } {
  if (
    !input ||
    !Number.isSafeInteger(input.fd) ||
    input.fd < 3 ||
    typeof input.spkiSha256 !== 'string' ||
    !SPKI_SHA256.test(input.spkiSha256)
  ) {
    throw new Error('member-admission-key-fd-invalid');
  }
  const fd = input.fd;
  const expectedPin = Buffer.from(input.spkiSha256, 'hex');
  let consumed = false;
  let closed = false;
  let cached: KeyObject | undefined;
  return Object.freeze({
    dispose(): void {
      cached = undefined;
      consumed = true;
      if (!closed) {
        closed = true;
        closeSync(fd);
      }
    },
    async loadPrivateKey(): Promise<KeyObject> {
      if (cached) return cached;
      if (consumed) throw new Error('member-admission-key-fd-consumed');
      consumed = true;
      let bytes: Buffer | undefined;
      let key: KeyObject | undefined;
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 0 || (stat.mode & 0o077) !== 0) {
          throw new Error('member-admission-key-fd-unsafe');
        }
        if (!Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > MAX_PKCS8_BYTES) {
          throw new Error('member-admission-key-size-invalid');
        }
        bytes = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < bytes.length) {
          const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
          if (count < 1) throw new Error('member-admission-key-read-incomplete');
          offset += count;
        }
        try {
          key = createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' });
        } catch {
          throw new Error('member-admission-key-invalid');
        }
        if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
          throw new Error('member-admission-key-invalid');
        }
        const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
        const actualPin = createHash('sha256').update(spki).digest();
        if (!timingSafeEqual(actualPin, expectedPin)) {
          throw new Error('member-admission-key-pin-mismatch');
        }
      } finally {
        bytes?.fill(0);
        closed = true;
        closeSync(fd);
      }
      if (!key) throw new Error('member-admission-key-invalid');
      cached = key;
      return key;
    },
  });
}
