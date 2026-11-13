// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RetainedWindowsCustody } from '@agent-teams/legacy-agent-host/owned-process';
import { expect, it } from 'vitest';

import { captureMainWindowsCustody } from '../../../src/features/agent-backend/main/infrastructure/CapturedWindowsCustody';

import type { SelectedHostProfile } from '../../../src/features/agent-backend/main/infrastructure/selectedHostProfile';

it('Main admits each finite process-backed provider without requiring a Claude member', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-windows-selection-')));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const path = join(root, 'profile.json');
  const selected = (members: unknown[]): SelectedHostProfile => {
    const bytes = JSON.stringify({ processCustody: { kind: 'main-windows-v1' },
      runtime: { members, providerTemplates: [] } });
    writeFileSync(path, bytes);
    return { profileId: 'TEST-profile', nodeExecutable: process.execPath, nodeVersion: process.version,
      nodeSha256: 'a'.repeat(64), hostEntry: path, hostEntrySha256: 'b'.repeat(64),
      expectedBuildId: 'TEST-build', cwd: root,
      env: { LEGACY_AGENT_HOST_PROFILE_PATH: path,
        LEGACY_AGENT_HOST_PROFILE_SHA256: createHash('sha256').update(bytes).digest('hex') },
      startupTimeoutMs: 1000, requestTimeoutMs: 1000, writeTimeoutMs: 1000, shutdownTimeoutMs: 1000 };
  };
  const member = (provider: string, nativeGeneration?: string) => ({
    provider, ...(nativeGeneration ? { nativeGeneration } : {}), cwd: 'C:\\TEST\\workspace',
    environment: {}, executable: { path: 'C:\\TEST\\provider.exe', sha256: 'c'.repeat(64) },
    windowsBroker: { path: 'C:\\TEST\\broker.exe', sha256: 'd'.repeat(64), arch: process.arch,
      protocol: 1, capability: 'service-scopes-v1' },
  });
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    for (const provider of ['claude', 'codex', 'opencode']) {
      expect(captureMainWindowsCustody(selected([member(provider)]))).toBeInstanceOf(RetainedWindowsCustody);
    }
    for (const unsupported of [member('unknown'), member('opencode', 'v2')]) {
      expect(() => captureMainWindowsCustody(selected([unsupported]))).toThrow('Captured Main custody unavailable');
    }
    const captured = selected([member('codex')]);
    writeFileSync(path, '{}');
    expect(() => captureMainWindowsCustody(captured)).toThrow('Invalid host profile');
  } finally {
    Object.defineProperty(process, 'platform', platform);
    rmSync(root, { recursive: true, force: true });
  }
});
