// @vitest-environment node
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Script } from 'node:vm';

import { expect, test } from 'vitest';

import { isOpenCodeV2ConfigurationKey, isOpenCodeV2DeferredConfigurationKey,
  OpenCodeV2CredentialScope } from '../../../packages/legacy-agent-host/src/adapters/providers/OpenCodeV2CredentialScope';
import { ManagementCommandError } from '../../../packages/legacy-agent-host/src/management/commandRecords';

import type { captureOpenCodeV2SessionCredential } from '../../../packages/legacy-agent-host/src/adapters/providers/OpenCodeV2SessionCredential';

// Execute the actual private helper with only its native credential client replaced.
// The original credential capture, currentness reads and prepare Promise remain real.
const source = readFileSync(resolve('packages/legacy-agent-host/src/adapters/providers/OpenCodeV2SessionCredential.ts'), 'utf8');
const declaration = 'export function captureOpenCodeV2SessionCredential(';
assert.equal(source.split(declaration).length, 2);
const original = new Script(stripTypeScriptTypes(source.slice(source.indexOf(declaration))
  .replace(declaration, 'function captureOpenCodeV2SessionCredential(') + '\ncaptureOpenCodeV2SessionCredential;'));
type Credential = ReturnType<typeof captureOpenCodeV2SessionCredential>;
type Phase = Parameters<NonNullable<Parameters<typeof captureOpenCodeV2SessionCredential>[5]>>[0];
const cases = ['no-key', 'connected', 'directory', 'restored', 'catalog-failed', 'directory-failed',
  'catalog-revoked', 'connect-failed', 'restore-failed', 'dispose-failed', 'connect-dispose-failed', 'dispose-revoked'] as const;

test.each(cases)('credential observations preserve original result, error, Promise and disposal for %s', async mode => {
  let baseline: unknown;
  for (const sink of ['absent', 'healthy', 'throws'] as const) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-credential-phases-')));
    const home = join(root, 'home'), data = join(root, 'data'), store = join(data, 'opencode');
    for (const path of [home, data, store]) mkdirSync(path, { mode: 0o700 });
    const secret = 'TEST-private-key', file = join(store, 'auth.json');
    writeFileSync(file, JSON.stringify(mode === 'no-key' ? {} : { 'TEST-provider': { type: 'api', key: secret } }), { mode: 0o600 });
    const profile = { environment: { HOME: home, XDG_DATA_HOME: data }, accountBinding: 'TEST-account' };
    const calls: string[] = [], phases: Phase[] = [];
    const failure = Error('TEST original operation'), cleanupFailure = Error('TEST original dispose');
    let current = true, checks = 0;
    const isCurrent = () => { checks++; return current; };
    const scopeDigest = new OpenCodeV2CredentialScope(profile, 'TEST-provider', isCurrent).capture().digest;
    const restore = mode === 'restored' || mode === 'restore-failed';
    const directory = mode === 'directory' || mode === 'directory-failed';
    const native = {
      connectKey: async (key: string) => {
        expect(key).toBe(secret); calls.push('connect');
        if (mode === 'connect-failed' || mode === 'connect-dispose-failed') throw failure;
        return { credentialId: 'cred_TEST' };
      },
      read: async () => {
        calls.push('read'); if (mode === 'restore-failed') throw failure;
        return { plainKey: true, connections: [{ type: 'credential', method: 'key', id: 'cred_TEST' }] };
      },
      dispose: async () => {
        calls.push('dispose');
        if (mode === 'dispose-failed' || mode === 'connect-dispose-failed') throw cleanupFailure;
        if (mode === 'dispose-revoked') current = false;
      },
    };
    const capture = original.runInNewContext({ OpenCodeV2CredentialScope,
      isOpenCodeV2ConfigurationKey, isOpenCodeV2DeferredConfigurationKey,
      held: () => { throw new ManagementCommandError('held'); },
      createOpenCodeV2CredentialClient: () => { calls.push('client'); return native; },
    }) as typeof captureOpenCodeV2SessionCredential;
    try {
      const credential = capture(profile, 'TEST-provider', isCurrent, undefined, undefined,
        sink === 'absent' ? undefined : phase => {
          phases.push(phase); if (sink === 'throws') throw Error('TEST private diagnostic failure');
        });
      const owner = {
        readCatalog: async () => {
          calls.push('catalog'); if (mode === 'catalog-failed') throw failure;
          if (mode === 'catalog-revoked') current = false;
          return { provider: { integrationId: directory ? undefined : 'TEST-integration' } };
        },
        readDirectory: async () => {
          calls.push('directory'); if (mode === 'directory-failed') throw failure;
          return { integrations: [{ id: 'TEST-provider' }] };
        },
      } as unknown as Parameters<Credential['prepare']>[1];
      const wire = { endpoint: 'http://127.0.0.1:19332', directory: root, version: '2.1.4' as const,
        deadline: Date.now() + 5000, readPassword: () => { throw Error('TEST unexpected transport'); } };
      const restored = restore ? { credential: { scopeDigest, credentialId: 'cred_TEST' } } as Parameters<Credential['prepare']>[2] : undefined;
      checks = 0;
      const pending = credential.prepare(wire, owner, restored);
      expect(credential.prepare(wire, owner, restored)).toBe(pending);
      if (mode === 'dispose-failed' || mode === 'connect-dispose-failed') await expect(pending).rejects.toBe(cleanupFailure);
      else if (mode.endsWith('-failed')) await expect(pending).rejects.toBe(failure);
      else if (mode.endsWith('-revoked')) await expect(pending).rejects.toMatchObject({ code: 'held' });
      else if (mode === 'no-key') await expect(pending).resolves.toBeUndefined();
      else {
        const witness = await pending;
        expect(witness).toEqual({ scopeDigest, credentialId: 'cred_TEST' });
        if (restored) expect(witness).toBe(restored.credential);
      }
      expect(credential.prepare(wire, owner, restored)).toBe(pending);
      baseline ??= { calls: [...calls], checks }; expect({ calls, checks }).toEqual(baseline);
      const expected: Phase[] = mode === 'no-key' ? [] : ['credential-catalog-start'];
      if (mode !== 'no-key' && mode !== 'catalog-failed') expected.push('credential-catalog-returned');
      if (directory) expected.push('credential-directory-start');
      if (mode === 'directory') expected.push('credential-directory-returned');
      const nativeCalled = calls.includes('client');
      if (nativeCalled) {
        expected.push(restore ? 'credential-restore-start' : 'credential-connect-start');
        if (!['connect-failed', 'restore-failed', 'connect-dispose-failed'].includes(mode))
          expected.push(restore ? 'credential-restore-returned' : 'credential-connect-returned');
        expected.push('credential-dispose-start');
        if (!['dispose-failed', 'connect-dispose-failed'].includes(mode)) expected.push('credential-dispose-returned');
      }
      expect(phases).toEqual(sink === 'absent' ? [] : expected);
      expect(calls.filter(call => call === 'dispose')).toHaveLength(nativeCalled ? 1 : 0);
      expect(JSON.stringify(phases)).not.toContain(secret);
      expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(mode === 'no-key' ? {} : { 'TEST-provider': { type: 'api', key: secret } }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
