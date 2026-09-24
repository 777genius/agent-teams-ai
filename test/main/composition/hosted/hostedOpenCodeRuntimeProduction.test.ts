import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  configureHostedOpenCodeRuntimeAtStartup,
  HOSTED_OPENCODE_RUNTIME_MODE,
  prepareHostedOpenCodeRuntimeFromEnvironment,
  readHostedOpenCodeProductionLock,
} from '@main/composition/hosted/hostedOpenCodeRuntimeProduction';

import type { HostedOpenCodeCurrentManifestV2 } from '@features/hosted-opencode-runtime';

const LOCK_FILE = path.resolve('opencode-hosted-runtime.lock.json');

describe('hosted official OpenCode startup', () => {
  it('does no filesystem or network work when the mode is absent', async () => {
    await expect(
      prepareHostedOpenCodeRuntimeFromEnvironment({
        environment: {},
        authDataDirectory: '/does-not-exist',
        lockFilePath: '/does-not-exist',
      })
    ).resolves.toBeNull();
  });

  it('rejects unknown modes before installation', async () => {
    await expect(
      prepareHostedOpenCodeRuntimeFromEnvironment({
        environment: { HOSTED_OPENCODE_RUNTIME_MODE: 'latest' },
        authDataDirectory: '/does-not-exist',
        lockFilePath: LOCK_FILE,
      })
    ).rejects.toThrow('hosted_opencode_runtime_mode_invalid');
  });

  it('reads only the reviewed official lock bytes', async () => {
    const lock = await readHostedOpenCodeProductionLock(LOCK_FILE);
    expect(lock).toMatchObject({
      version: '1.18.32',
      source: { repository: 'anomalyco/opencode' },
      platforms: {
        'linux-x64': {
          binarySha256: '513f500a1a5ea1dc7d865547ac87b32a8936334e8d5abd5b3ff585c45a170080',
        },
      },
    });
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'hosted-opencode-lock-'));
    try {
      const modified = path.join(temporary, 'modified.json');
      await fs.writeFile(modified, `${await fs.readFile(LOCK_FILE, 'utf8')} `);
      await expect(readHostedOpenCodeProductionLock(modified)).rejects.toThrow(
        'hosted_opencode_lock_file_digest_mismatch'
      );
      const linked = path.join(temporary, 'linked.json');
      await fs.symlink(LOCK_FILE, linked);
      await expect(readHostedOpenCodeProductionLock(linked)).rejects.toThrow(
        'hosted_opencode_lock_file_unavailable'
      );
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });

  it('installs only when absent and resolves the verified binary afterwards', async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'hosted-opencode-runtime-'));
    const binaryPath = path.join(temporary, 'hosted-opencode-runtime', 'versions', 'opencode');
    const calls: string[] = [];
    try {
      const resolved = await prepareHostedOpenCodeRuntimeFromEnvironment({
        environment: { HOSTED_OPENCODE_RUNTIME_MODE },
        authDataDirectory: temporary,
        lockFilePath: LOCK_FILE,
        createComposition: ({ runtimeRoot, loadLock }) => {
          expect(runtimeRoot).toBe(path.join(temporary, 'hosted-opencode-runtime'));
          return {
            async resolveBinary() {
              calls.push('resolve');
              expect((await loadLock()) as { version: string }).toMatchObject({
                version: '1.18.32',
              });
              if (calls.length === 1) throw new Error('hosted_opencode_current_manifest_missing');
              return binaryPath;
            },
            async install() {
              calls.push('install');
              return {} as HostedOpenCodeCurrentManifestV2;
            },
          };
        },
      });
      expect(resolved).toBe(binaryPath);
      expect(calls).toEqual(['resolve', 'install', 'resolve']);
      expect((await fs.stat(path.join(temporary, 'hosted-opencode-runtime'))).mode & 0o777).toBe(
        0o700
      );
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });

  it('configures startup provider paths only after composition resolves the official runtime', async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'hosted-opencode-runtime-'));
    const binaryPath = path.join(temporary, 'hosted-opencode-runtime', 'versions', 'opencode');
    const runtimeEnvironment: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      OPENCODE_BIN_PATH: '/untrusted/opencode',
    };
    try {
      await expect(
        configureHostedOpenCodeRuntimeAtStartup({
          environment: { HOSTED_OPENCODE_RUNTIME_MODE },
          runtimeEnvironment,
          authDataDirectory: temporary,
          lockFilePath: LOCK_FILE,
          createComposition: ({ loadLock }) => ({
            async resolveBinary() {
              expect((await loadLock()) as { version: string }).toMatchObject({
                version: '1.18.32',
              });
              return binaryPath;
            },
            async install() {
              throw new Error('already installed');
            },
          }),
        })
      ).resolves.toBe(true);
      expect(runtimeEnvironment.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(binaryPath);
      expect(runtimeEnvironment.OPENCODE_BIN_PATH).toBe(binaryPath);
      expect(runtimeEnvironment.PATH?.split(path.delimiter)[0]).toBe(path.dirname(binaryPath));
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });

  it('does not reinstall after a corrupt or mismatched manifest', async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'hosted-opencode-runtime-'));
    const runtimeEnvironment: NodeJS.ProcessEnv = { OPENCODE_BIN_PATH: '/previous/path' };
    let installed = false;
    try {
      await expect(
        configureHostedOpenCodeRuntimeAtStartup({
          environment: { HOSTED_OPENCODE_RUNTIME_MODE },
          runtimeEnvironment,
          authDataDirectory: temporary,
          lockFilePath: LOCK_FILE,
          createComposition: () => ({
            resolveBinary: async () => {
              throw new Error('hosted_opencode_current_manifest_invalid');
            },
            install: async () => {
              installed = true;
              throw new Error('should not install');
            },
          }),
        })
      ).rejects.toThrow('hosted_opencode_current_manifest_invalid');
      expect(installed).toBe(false);
      expect(runtimeEnvironment).toEqual({ OPENCODE_BIN_PATH: '/previous/path' });
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });
});
