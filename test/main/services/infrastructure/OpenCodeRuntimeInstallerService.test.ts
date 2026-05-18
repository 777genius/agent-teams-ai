import { createHash } from 'crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { gzipSync } from 'zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execCliMock = vi.hoisted(() => vi.fn());
const getCachedShellEnvMock = vi.hoisted(() => vi.fn());
const resolveInteractiveShellEnvBestEffortMock = vi.hoisted(() => vi.fn());

vi.mock('@main/utils/childProcess', () => ({
  execCli: execCliMock,
}));

vi.mock('@main/utils/shellEnv', () => ({
  getCachedShellEnv: () => getCachedShellEnvMock(),
  resolveInteractiveShellEnvBestEffort: (
    ...args: Parameters<typeof resolveInteractiveShellEnvBestEffortMock>
  ) => resolveInteractiveShellEnvBestEffortMock(...args),
}));

import {
  extractOpenCodeRuntimeBinaryFromTarball,
  getOpenCodeRuntimePlatformCandidates,
  OpenCodeRuntimeInstallerService,
  resolveAppManagedOpenCodeRuntimeBinaryPath,
  resolveVerifiedAppManagedOpenCodeRuntimeBinaryPath,
  resolveVerifiedOpenCodeRuntimeBinaryPath,
  verifyOpenCodeRuntimePackageIntegrity,
} from '@main/services/infrastructure/OpenCodeRuntimeInstallerService';
import { setAppDataBasePath } from '@main/utils/pathDecoder';

let tempRoot: string | null = null;
let originalPath: string | undefined;

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  const encoded = value
    .toString(8)
    .padStart(length - 1, '0')
    .slice(-(length - 1));
  header.write(`${encoded}\0`, offset, length, 'ascii');
}

function createTarEntry(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, Math.min(Buffer.byteLength(name), 100), 'utf8');
  writeOctal(header, 100, 8, 0o755);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, data.length);
  writeOctal(header, 136, 12, 0);
  header.fill(' ', 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, '0');
  header.write(`${checksumText}\0 `, 148, 8, 'ascii');

  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

function createTarball(entries: { name: string; data: string }[]): Buffer {
  return gzipSync(
    Buffer.concat([
      ...entries.map((entry) => createTarEntry(entry.name, Buffer.from(entry.data))),
      Buffer.alloc(1024),
    ])
  );
}

describe('OpenCodeRuntimeInstallerService resolver', () => {
  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-runtime-resolver-'));
    setAppDataBasePath(tempRoot);
    originalPath = process.env.PATH;
    process.env.PATH = '';
    execCliMock.mockReset();
    execCliMock.mockResolvedValue({ stdout: 'opencode 1.0.0\n', stderr: '' });
    getCachedShellEnvMock.mockReset();
    getCachedShellEnvMock.mockReturnValue(null);
    resolveInteractiveShellEnvBestEffortMock.mockReset();
    resolveInteractiveShellEnvBestEffortMock.mockResolvedValue(process.env);
  });

  afterEach(async () => {
    setAppDataBasePath(null);
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    originalPath = undefined;
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it('returns the current app-managed OpenCode binary path only when manifest and binary exist', async () => {
    const binaryPath = path.join(
      tempRoot!,
      'data',
      'runtimes',
      'opencode',
      'versions',
      '1.0.0',
      'opencode-test',
      'opencode'
    );
    const manifestPath = path.join(tempRoot!, 'data', 'runtimes', 'opencode', 'current.json');
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(binaryPath, 'binary', { mode: 0o755 });
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        version: '1.0.0',
        platformPackage: 'opencode-test',
        binaryPath,
        integrity: 'sha512-test',
        installedAt: '2026-05-12T00:00:00.000Z',
      })}\n`,
      'utf8'
    );

    expect(resolveAppManagedOpenCodeRuntimeBinaryPath()).toBe(binaryPath);
  });

  it('ignores a manifest whose binary path is missing', async () => {
    const manifestPath = path.join(tempRoot!, 'data', 'runtimes', 'opencode', 'current.json');
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        version: '1.0.0',
        platformPackage: 'opencode-test',
        binaryPath: path.join(tempRoot!, 'missing-opencode'),
        integrity: 'sha512-test',
        installedAt: '2026-05-12T00:00:00.000Z',
      })}\n`,
      'utf8'
    );

    expect(resolveAppManagedOpenCodeRuntimeBinaryPath()).toBeNull();
  });

  it('returns the verified app-managed binary path only when --version succeeds', async () => {
    const binaryPath = path.join(
      tempRoot!,
      'data',
      'runtimes',
      'opencode',
      'versions',
      '1.0.0',
      'opencode-test',
      'opencode'
    );
    const manifestPath = path.join(tempRoot!, 'data', 'runtimes', 'opencode', 'current.json');
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(binaryPath, 'binary', { mode: 0o755 });
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        version: '1.0.0',
        platformPackage: 'opencode-test',
        binaryPath,
        integrity: 'sha512-test',
        installedAt: '2026-05-12T00:00:00.000Z',
      })}\n`,
      'utf8'
    );

    await expect(resolveVerifiedAppManagedOpenCodeRuntimeBinaryPath()).resolves.toBe(binaryPath);
    expect(execCliMock).toHaveBeenCalledWith(binaryPath, ['--version'], {
      timeout: 10_000,
      windowsHide: true,
    });

    execCliMock.mockRejectedValueOnce(new Error('broken binary'));

    await expect(resolveVerifiedAppManagedOpenCodeRuntimeBinaryPath()).resolves.toBeNull();
  });

  it('returns a verified OpenCode binary from best-effort shell PATH when app-managed runtime is absent', async () => {
    const binaryPath = path.join(tempRoot!, 'homebrew', 'bin', 'opencode');
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, 'binary', { mode: 0o755 });
    resolveInteractiveShellEnvBestEffortMock.mockResolvedValue({
      PATH: path.dirname(binaryPath),
    });

    await expect(resolveVerifiedOpenCodeRuntimeBinaryPath({ shellEnvTimeoutMs: 0 })).resolves.toBe(
      binaryPath
    );
    expect(resolveInteractiveShellEnvBestEffortMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 0,
        fallbackEnv: process.env,
      })
    );
    expect(execCliMock).toHaveBeenCalledWith(binaryPath, ['--version'], {
      timeout: 10_000,
      windowsHide: true,
    });
  });

  it('reports PATH-installed OpenCode as installed after best-effort shell env resolution', async () => {
    const binaryPath = path.join(tempRoot!, 'homebrew', 'bin', 'opencode');
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, 'binary', { mode: 0o755 });
    resolveInteractiveShellEnvBestEffortMock.mockResolvedValue({
      PATH: path.dirname(binaryPath),
    });

    await expect(new OpenCodeRuntimeInstallerService().getStatus()).resolves.toMatchObject({
      installed: true,
      source: 'path',
      state: 'ready',
      binaryPath,
      version: 'opencode 1.0.0',
    });
  });
});

describe('OpenCodeRuntimeInstallerService package safety helpers', () => {
  it('selects expected platform packages with Linux musl and baseline fallbacks', () => {
    expect(
      getOpenCodeRuntimePlatformCandidates('darwin', 'arm64', false).map((item) => item.packageName)
    ).toEqual(['opencode-darwin-arm64']);
    expect(
      getOpenCodeRuntimePlatformCandidates('darwin', 'x64', false).map((item) => item.packageName)
    ).toEqual(['opencode-darwin-x64', 'opencode-darwin-x64-baseline']);
    expect(
      getOpenCodeRuntimePlatformCandidates('linux', 'x64', false).map((item) => item.packageName)
    ).toEqual(['opencode-linux-x64', 'opencode-linux-x64-baseline', 'opencode-linux-x64-musl']);
    expect(
      getOpenCodeRuntimePlatformCandidates('linux', 'x64', true).map((item) => item.packageName)
    ).toEqual([
      'opencode-linux-x64-musl',
      'opencode-linux-x64-baseline-musl',
      'opencode-linux-x64',
    ]);
    expect(
      getOpenCodeRuntimePlatformCandidates('linux', 'arm64', false).map((item) => item.packageName)
    ).toEqual(['opencode-linux-arm64', 'opencode-linux-arm64-musl']);
    expect(
      getOpenCodeRuntimePlatformCandidates('linux', 'arm64', true).map((item) => item.packageName)
    ).toEqual(['opencode-linux-arm64-musl', 'opencode-linux-arm64']);
    expect(
      getOpenCodeRuntimePlatformCandidates('win32', 'x64', false).map((item) => item.packageName)
    ).toEqual(['opencode-windows-x64', 'opencode-windows-x64-baseline']);
    expect(
      getOpenCodeRuntimePlatformCandidates('win32', 'arm64', false).map((item) => item.packageName)
    ).toEqual(['opencode-windows-arm64']);
  });

  it('fails npm integrity mismatches', () => {
    const payload = Buffer.from('actual package');
    const wrongHash = createHash('sha512').update('different package').digest('base64');

    expect(() => verifyOpenCodeRuntimePackageIntegrity(payload, `sha512-${wrongHash}`)).toThrow(
      'integrity check failed'
    );
  });

  it('extracts only the expected OpenCode binary from the package tarball', () => {
    const tarball = createTarball([
      { name: 'package/bin/not-opencode', data: 'wrong' },
      {
        name: process.platform === 'win32' ? 'package/bin/opencode.exe' : 'package/bin/opencode',
        data: 'right',
      },
    ]);

    expect(extractOpenCodeRuntimeBinaryFromTarball(tarball).toString()).toBe('right');
  });

  it('rejects tar path traversal before extraction', () => {
    const tarball = createTarball([
      { name: '../opencode', data: 'unsafe' },
      {
        name: process.platform === 'win32' ? 'package/bin/opencode.exe' : 'package/bin/opencode',
        data: 'right',
      },
    ]);

    expect(() => extractOpenCodeRuntimeBinaryFromTarball(tarball)).toThrow(
      'Unsafe OpenCode package tar entry'
    );
  });
});
