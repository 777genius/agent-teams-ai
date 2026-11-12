import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { OpenCodeV2ManagementHost } from '../dist/adapters/providers/OpenCodeV2ManagementHost.js';
import { ProviderManagementCoordinator } from '../dist/composition/ProviderManagementCoordinator.js';
import { openCodeManagementProfileSchema } from '../dist/management/profile.js';

for (const cleanup of ['confirmed', 'unknown', 'rejected'] as const) {
  test(`a failed V2 catalog retires only after ${cleanup} original cleanup`, async t => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-v2-catalog-recovery-')));
    const profile = openCodeManagementProfileSchema.parse({
      provider: 'opencode', nativeGeneration: 'v2', protocolRevision: '2.1.4',
      profileId: 'TEST-profile', configRevision: 'TEST-config', accountBinding: 'TEST-account',
      cwd: root, executable: { path: join(root, 'TEST-bun'), sha256: 'a'.repeat(64) },
      environment: Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']
        .map(key => [key, root])),
      endpoint: 'http://127.0.0.1:19332', timeoutMs: 1000,
      nativeModel: { providerId: 'TEST-provider', modelId: 'TEST-model' },
      embedded: { version: '2.1.4', platform: process.platform, arch: process.arch,
        directory: join(root, 'engine'), manifestSha256: 'b'.repeat(64), externalDirectory: 'deny' },
    });
    const seen: OpenCodeV2ManagementHost[] = [], sealed = new Set<OpenCodeV2ManagementHost>();
    const originalFailure = new Error('TEST original catalog deadline');
    const catalog = { profileId: profile.profileId, configRevision: profile.configRevision,
      configuredDefaultModelId: null, providers: [] };
    t.mock.method(OpenCodeV2ManagementHost.prototype, 'catalog', async function (this: OpenCodeV2ManagementHost) {
      seen.push(this);
      if (seen.length === 1) { sealed.add(this); throw originalFailure; }
      if (sealed.has(this)) throw new Error('TEST retained owner is sealed');
      return catalog;
    });
    t.mock.method(OpenCodeV2ManagementHost.prototype, 'close', async function (this: OpenCodeV2ManagementHost) {
      sealed.add(this);
      if (cleanup === 'rejected') throw new Error('TEST cleanup unavailable');
      return cleanup === 'confirmed';
    });
    const owner = new ProviderManagementCoordinator([profile], () => {}, root);
    try {
      const request = { profileId: profile.profileId, configRevision: profile.configRevision };
      await assert.rejects(owner.catalog(request), error => error === originalFailure,
        'cleanup failure never replaces the original catalog error');
      if (cleanup === 'confirmed') {
        assert.deepEqual(await owner.catalog(request), catalog);
        assert.notEqual(seen[1], seen[0], 'a later request obtains a fresh owner after confirmed retirement');
        assert.deepEqual(await owner.catalog(request), catalog);
        assert.equal(seen[2], seen[1], 'a successful owner remains shared');
      } else {
        await assert.rejects(owner.catalog(request), /retained owner is sealed/);
        assert.equal(seen[1], seen[0], 'unknown cleanup never allocates a replacement owner');
      }
    } finally {
      await owner.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });
}
