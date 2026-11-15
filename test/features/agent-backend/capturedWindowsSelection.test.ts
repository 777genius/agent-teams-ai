// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RetainedWindowsCustody } from '@agent-teams/legacy-agent-host/owned-process';
import { expect, it, vi } from 'vitest';

import { captureMainWindowsCustody } from '../../../src/features/agent-backend/main/infrastructure/CapturedWindowsCustody';

import type { SelectedHostProfile } from '../../../src/features/agent-backend/main/infrastructure/selectedHostProfile';
import type { PathLike, ReadStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

type CustodyOptions = ConstructorParameters<typeof RetainedWindowsCustody>[0];
const inspection = vi.hoisted(() => ({
  options: undefined as CustodyOptions | undefined,
  paths: new Map<string, string>(),
  opened: [] as FileHandle[],
  streams: new Map<string, ReadStream>(),
  duringRead: undefined as ((path: string, stream: ReadStream) => void) | undefined,
}));

// Observe the original constructor callback; no native port or provider process is created.
vi.mock('@agent-teams/legacy-agent-host/owned-process', async importOriginal => {
  const original = await importOriginal<typeof import('@agent-teams/legacy-agent-host/owned-process')>();
  return { ...original,
    RetainedWindowsCustody: class extends original.RetainedWindowsCustody {
      constructor(options: CustodyOptions) { super(options); inspection.options = options; }
    },
    verifyStagedBroker: (...args: Parameters<typeof original.verifyStagedBroker>) => {
      args[0] = inspection.paths.get(args[0]) ?? args[0];
      return original.verifyStagedBroker(...args);
    },
  };
});

// Translate only the closed TEST Windows names to real private files on this runner. Schema,
// captured profile, launcher, broker manifest and all file identity/hash checks remain real.
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  const local = (path: PathLike): PathLike => typeof path === 'string'
    ? inspection.paths.get(path) ?? path : path;
  return { ...original,
    lstat: (...args: Parameters<typeof original.lstat>) => {
      args[0] = local(args[0]); return original.lstat(...args);
    },
    realpath: async (...args: Parameters<typeof original.realpath>) => {
      const selected = args[0]; args[0] = local(selected);
      const result = await original.realpath(...args);
      return selected !== args[0] && result === args[0] ? selected : result;
    },
    open: async (...args: Parameters<typeof original.open>) => {
      const selected = args[0]; args[0] = local(selected);
      const file = await original.open(...args);
      if (typeof selected === 'string' && inspection.paths.has(selected)) {
        inspection.opened.push(file);
        const readStream = file.createReadStream.bind(file);
        file.createReadStream = options => {
          const stream = readStream(options), iterator = stream[Symbol.asyncIterator]();
          const next = iterator.next.bind(iterator);
          let first = true;
          iterator.next = async (...values) => {
            const chunk = await next(...values);
            if (!chunk.done && first) {
              first = false; inspection.duringRead?.(selected, stream);
            }
            return chunk;
          };
          stream[Symbol.asyncIterator] = () => iterator;
          inspection.streams.set(selected, stream);
          return stream;
        };
      }
      return file;
    },
  };
});

it('Main admits each finite process-backed provider without requiring a Claude member', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-windows-selection-')));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const path = join(root, 'profile.json');
  const selected = (members: unknown[] | undefined, management: unknown[] = []): SelectedHostProfile => {
    const bytes = JSON.stringify({ processCustody: { kind: 'main-windows-v1' },
      ...(members ? { runtime: { members, providerTemplates: [] } } : {}), management });
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
      expect(captureMainWindowsCustody(selected(undefined, [member(provider)]))).toBeInstanceOf(RetainedWindowsCustody);
    }
    for (const unsupported of [member('unknown'), member('opencode', 'v2'), member('opencode', 'v3'),
      { ...member('codex'), provider: { toString: () => 'codex' } }]) {
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


for (const outcome of ['intact', 'changed-tail', 'replaced-during-read', 'read-error'] as const) {
  it(`Main streaming verification keeps full-file and descriptor guarantees: ${outcome}`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-windows-stream-')));
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const providerPath = join(root, 'provider.exe'), brokerPath = join(root, 'owned-process-broker.exe');
    const selectedProvider = 'C:\\TEST\\provider.exe', selectedBroker = 'C:\\TEST\\owned-process-broker.exe';
    const providerBytes = Buffer.alloc(2 * 1024 * 1024 + 41, 0x61);
    providerBytes.write('TEST complete executable tail', providerBytes.length - 29);
    const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
    const executableSha256 = digest(providerBytes), brokerBytes = Buffer.alloc(128);
    brokerBytes.write('MZ'); brokerBytes.writeUInt32LE(64, 60); brokerBytes.write('PE\0\0', 64);
    brokerBytes.writeUInt16LE(process.arch === 'x64' ? 0x8664 : 0xaa64, 68);
    const broker = { path: selectedBroker, sha256: digest(brokerBytes), arch: process.arch as 'x64' | 'arm64',
      protocol: 1 as const, capability: 'service-scopes-v1' as const };
    const path = join(root, 'profile.json');
    const bytes = JSON.stringify({ processCustody: { kind: 'main-windows-v1' }, runtime: { members: [{
      provider: 'codex', cwd: 'C:\\TEST\\workspace', environment: {},
      executable: { path: selectedProvider, sha256: executableSha256 }, windowsBroker: broker,
    }] } });
    const profile: SelectedHostProfile = { profileId: 'TEST-stream', nodeExecutable: process.execPath,
      nodeVersion: process.version, nodeSha256: 'a'.repeat(64), hostEntry: path, hostEntrySha256: 'b'.repeat(64),
      expectedBuildId: 'TEST-build', cwd: root, env: { LEGACY_AGENT_HOST_PROFILE_PATH: path,
        LEGACY_AGENT_HOST_PROFILE_SHA256: digest(bytes) }, startupTimeoutMs: 1000, requestTimeoutMs: 1000,
      writeTimeoutMs: 1000, shutdownTimeoutMs: 1000 };
    const failure = Object.assign(new Error('TEST read error'), { code: 'EIO' });
    let observedRead = false;
    try {
      writeFileSync(providerPath, providerBytes); writeFileSync(brokerPath, brokerBytes); writeFileSync(path, bytes);
      writeFileSync(join(root, 'manifest.json'), JSON.stringify({ schema: 2, protocol: 1, platform: 'win32',
        arch: process.arch, file: 'owned-process-broker.exe', sha256: broker.sha256, capability: 'service-scopes-v1' }));
      inspection.paths.set(selectedProvider, providerPath); inspection.paths.set(selectedBroker, brokerPath);
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      expect(captureMainWindowsCustody(profile)).toBeInstanceOf(RetainedWindowsCustody);
      if (outcome === 'changed-tail') {
        const changed = Buffer.from(providerBytes);
        changed.writeUInt8(changed.readUInt8(changed.length - 1) ^ 1, changed.length - 1);
        writeFileSync(providerPath, changed);
      }
      inspection.duringRead = (selected, stream) => {
        if (selected !== selectedProvider) return;
        observedRead = true;
        if (outcome === 'replaced-during-read') {
          renameSync(providerPath, join(root, 'original-provider.exe'));
          writeFileSync(providerPath, providerBytes); // Same SHA, different pathname identity while the original FD is open.
        } else if (outcome === 'read-error') stream.destroy(failure);
      };
      const verification = inspection.options!.verifyLaunch({ executable: selectedProvider,
        commandLine: '"C:\\TEST\\provider.exe"', cwd: root, environment: [] }, executableSha256, broker,
      { capability: 'TEST-stream-root', phase: 'prepare' });
      if (outcome === 'intact') await expect(verification).resolves.toBeUndefined();
      else if (outcome === 'read-error') await expect(verification).rejects.toBe(failure);
      else await expect(verification).rejects.toThrow('Captured Main custody unavailable');
      expect(observedRead).toBe(true);
      expect(inspection.opened).toHaveLength(2);
      expect(inspection.opened.every(file => file.fd === -1)).toBe(true);
      if (outcome !== 'read-error') expect(inspection.streams.get(selectedProvider)?.bytesRead).toBe(providerBytes.length);
    } finally {
      inspection.duringRead = undefined; inspection.paths.clear(); inspection.streams.clear();
      inspection.options = undefined;
      Object.defineProperty(process, 'platform', platform);
      try { await Promise.all(inspection.opened.splice(0).map(file => file.close())); }
      finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
}
