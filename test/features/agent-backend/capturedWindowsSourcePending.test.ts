// @vitest-environment node
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runtimeSourceVersionProfile, windowsLaunchSpec } from '@agent-teams/legacy-agent-host/owned-process';
import { afterEach, expect, it, vi } from 'vitest';

import { CapturedWindowsRuntimeSources } from '../../../src/features/agent-backend/main/infrastructure/CapturedWindowsRuntimeSources';

import type { NativeProcessProfile } from '@agent-teams/legacy-agent-host/owned-process';
import type { RuntimeSourceGrant, RuntimeSourcePublishIntent } from '@agent-teams/legacy-agent-host/runtime-sources';

// Isolate only native pathname encoding on non-Windows. The original Main lifecycle, exact encoded
// spec digest, shared filtered environment, original grants and read-only history remain real.
// Actual launcher encoding and Job ownership have separate repository-fixture Windows acceptance.
vi.mock('@agent-teams/legacy-agent-host/owned-process', async importOriginal => {
  const original = await importOriginal<typeof import('@agent-teams/legacy-agent-host/owned-process')>();
  return { ...original, windowsLaunchSpec: (profile: NativeProcessProfile, args: readonly string[]) => ({
    executable: `C:\\TEST\\${profile.executable.sha256}.exe`, cwd: 'C:\\TEST\\workspace',
    commandLine: JSON.stringify([profile.executable.path, ...args]),
    environment: Object.entries(profile.environment).map(([key, value]) => `${key}=${value}`),
  }) };
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-main-source-pending-'))); roots.push(root);
  const broker = { path: 'C:\\TEST\\broker.exe', sha256: 'b'.repeat(64), arch: process.arch as 'x64' | 'arm64',
    protocol: 1 as const, capability: 'service-scopes-v1' as const };
  const seed = { provider: 'codex' as const, protocolRevision: '0.162.0' as const, profileId: 'TEST-profile',
    configRevision: 'TEST-config', accountBinding: 'TEST-account', executable: { path: process.execPath, sha256: 'c'.repeat(64) },
    environment: { HOME: root, CODEX_HOME: root, PATH: root, TEST_SECRET: 'TEST-secret', NODE_OPTIONS: '--require TEST' },
    cwd: root, timeoutMs: 1000, windowsBroker: broker };
  const context = { owner: { ownerId: 'TEST-owner', revision: 'TEST-v1', storageRoot: root }, teams: [], management: [seed] };
  const grant: RuntimeSourceGrant = { targetId: 'd'.repeat(64), ownerId: context.owner.ownerId, ownerRevision: context.owner.revision,
    contextId: 'TEST-context', projectPath: root, runtimeId: 'codex', profileId: seed.profileId, configRevision: seed.configRevision, teamScopes: [] };
  const executable = { path: join(root, 'TEST-next.exe'), sha256: 'e'.repeat(64) };
  const input: RuntimeSourcePublishIntent = { commandId: 'TEST-command', expectedRevision: 'f'.repeat(64),
    nativeSelection: { sourceKind: 'app-managed', nativeCli: { executable, version: '0.162.0' } } };
  let original = true, current = true;
  const main = new CapturedWindowsRuntimeSources(context, [grant], [], () => { if (!original) throw new Error('TEST original lost'); });
  const spec = windowsLaunchSpec(runtimeSourceVersionProfile(seed, executable), ['--version']);
  return { main, grant, input, broker, spec, executable,
    current: () => current, stale: () => { current = false; }, loseOriginal: () => { original = false; } };
}

it('one pending source grants only exact --version with filtered original environment and same capability', () => {
  const f = fixture();
  expect(f.main.select(f.spec, f.executable.sha256, f.broker, { capability: 'TEST-root', phase: 'prepare' })).toBeUndefined();
  const release = f.main.prepare(f.grant, f.input, f.current);
  expect(f.spec.environment.some(value => value.startsWith('NODE_OPTIONS=') || value.startsWith('TEST_SECRET='))).toBe(false);
  expect(f.main.select({ ...f.spec, commandLine: f.spec.commandLine + ' --login' }, f.executable.sha256,
    f.broker, { capability: 'TEST-root', phase: 'prepare' })).toBeUndefined();
  expect(f.main.select({ ...f.spec, environment: [...f.spec.environment, 'TEST_SECRET=wrong'] }, f.executable.sha256,
    f.broker, { capability: 'TEST-root', phase: 'prepare' })).toBeUndefined();
  expect(f.main.select({ ...f.spec, cwd: 'C:\\TEST\\foreign' }, f.executable.sha256,
    f.broker, { capability: 'TEST-root', phase: 'prepare' })).toBeUndefined();
  expect(f.main.select(f.spec, f.executable.sha256, { ...f.broker, sha256: '0'.repeat(64) },
    { capability: 'TEST-root', phase: 'prepare' })).toBeUndefined();
  const prepared = f.main.select(f.spec, f.executable.sha256, f.broker, { capability: 'TEST-root', phase: 'prepare' })!;
  expect(prepared).toBeDefined();
  expect(f.main.select(f.spec, f.executable.sha256, f.broker, { capability: 'TEST-root', phase: 'resume' })).toBeDefined();
  expect(() => f.main.select(f.spec, f.executable.sha256, f.broker, { capability: 'TEST-other', phase: 'prepare' })).toThrow();
  expect(() => f.main.select(f.spec, f.executable.sha256, f.broker, { capability: 'TEST-root', phase: 'service' })).toThrow();
  release(); release();
  expect(() => prepared.assertCurrent()).toThrow();
  expect(f.main.select(f.spec, f.executable.sha256, f.broker, { capability: 'TEST-root', phase: 'resume' })).toBeUndefined();
});

it('foreign grants, stale original guards and changed duplicate intents never acquire pending authority', () => {
  const f = fixture();
  expect(() => f.main.prepare({ ...f.grant, contextId: 'TEST-foreign' }, f.input, f.current)).toThrow();
  const release = f.main.prepare(f.grant, f.input, f.current);
  expect(() => f.main.prepare(f.grant, { ...f.input, expectedRevision: '0'.repeat(64) }, f.current)).toThrow();
  expect(() => f.main.select(f.spec, f.executable.sha256, f.broker, { capability: 'TEST-root', phase: 'resume' })).toThrow();
  const prepared = f.main.select(f.spec, f.executable.sha256, f.broker, { capability: 'TEST-root', phase: 'prepare' })!;
  f.stale();
  expect(() => prepared.assertCurrent()).toThrow();
  expect(() => f.main.select(f.spec, f.executable.sha256, f.broker, { capability: 'TEST-root', phase: 'resume' })).toThrow();
  release();
  const another = fixture(); another.loseOriginal();
  expect(() => another.main.prepare(another.grant, another.input, another.current)).toThrow();
});
