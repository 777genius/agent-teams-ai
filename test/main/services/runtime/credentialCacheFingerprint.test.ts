// @vitest-environment node
import { hashCredentialForCache } from '@main/services/runtime/credentialCacheFingerprint';
import { describe, expect, it, vi } from 'vitest';

describe('credential cache fingerprint', () => {
  it('is stable within a process, distinct for another credential, and unlinkable after restart', async () => {
    const credential = 'test-api-key-not-a-real-credential';
    const fingerprint = hashCredentialForCache(credential);

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(fingerprint).not.toContain(credential);
    expect(hashCredentialForCache(credential)).toBe(fingerprint);
    expect(hashCredentialForCache('different-test-api-key')).not.toBe(fingerprint);

    vi.resetModules();
    const reloaded = await import('@main/services/runtime/credentialCacheFingerprint');
    expect(reloaded.hashCredentialForCache(credential)).not.toBe(fingerprint);
  });
});
