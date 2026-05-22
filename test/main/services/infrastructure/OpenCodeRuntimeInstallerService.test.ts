import { createHash } from 'crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'zlib';

const execCliMock = vi.hoisted(() => vi.fn());
const buildMergedCliPathMock = vi.hoisted(() => vi.fn());
const getCachedShellEnvMock = vi.hoisted(() => vi.fn());
const getShellPreferredHomeMock = vi.hoisted(() => vi.fn());
const resolveInteractiveShellEnvBestEffortMock = vi.hoisted(() => vi.fn());

vi.mock('@main/utils/childProcess', () => ({
  execCli: execCliMock,
}));

vi.mock('@main/utils/cliPathMerge', () => ({
  buildMergedCliPath: () => buildMergedCliPathMock(),
}));

vi.mock('@main/utils/shellEnv', () => ({
  getCachedShellEnv: () => getCachedShellEnvMock(),
  getShellPreferredHome: () => getShellPreferredHomeMock(),
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
    buildMergedCliPathMock.mockReset();
    buildMergedCliPathMock.mockReturnValue('');
    getCachedShellEnvMock.mockReset();
    getCachedShellEnvMock.mockReturnValue(null);
    getShellPreferredHomeMock.mockReset();
    getShellPreferredHomeMock.mockReturnValue(os.homedir());
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

  it('returns a verified OpenCode binary from the merged CLI PATH after zero-wait shell fallback', async () => {
    const binaryPath = path.join(tempRoot!, 'merged-cli-path', 'bin', 'opencode');
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, 'binary', { mode: 0o755 });
    buildMergedCliPathMock.mockReturnValue(path.dirname(binaryPath));

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

  it('returns a verified OpenCode binary from nvm when desktop PATH misses npm globals', async () => {
    const olderBinaryPath = path.join(
      tempRoot!,
      '.nvm',
      'versions',
      'node',
      'v20.10.0',
      'bin',
      'opencode'
    );
    const binaryPath = path.join(
      tempRoot!,
      '.nvm',
      'versions',
      'node',
      'v22.22.1',
      'bin',
      'opencode'
    );
    await mkdir(path.dirname(olderBinaryPath), { recursive: true });
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(olderBinaryPath, 'older binary', { mode: 0o755 });
    await writeFile(binaryPath, 'binary', { mode: 0o755 });
    getCachedShellEnvMock.mockReturnValue({ HOME: tempRoot! });
    getShellPreferredHomeMock.mockReturnValue(tempRoot!);

    await expect(resolveVerifiedOpenCodeRuntimeBinaryPath({ shellEnvTimeoutMs: 0 })).resolves.toBe(
      binaryPath
    );
    expect(resolveInteractiveShellEnvBestEffortMock).not.toHaveBeenCalled();
    expect(execCliMock).toHaveBeenCalledWith(binaryPath, ['--version'], {
      timeout: 10_000,
      windowsHide: true,
    });
  });

  it('returns a verified OpenCode cmd shim from nvm-windows when desktop PATH misses npm globals', async () => {
    const originalPlatform = process.platform;
    const originalAppData = process.env.APPDATA;

    try {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
        writable: true,
      });
      process.env.APPDATA = tempRoot!;

      const olderBinaryPath = path.join(tempRoot!, 'nvm', 'v20.10.0', 'opencode.cmd');
      const binaryPath = path.join(tempRoot!, 'nvm', 'v22.22.1', 'opencode.cmd');
      await mkdir(path.dirname(olderBinaryPath), { recursive: true });
      await mkdir(path.dirname(binaryPath), { recursive: true });
      await writeFile(olderBinaryPath, 'older binary', { mode: 0o755 });
      await writeFile(binaryPath, 'binary', { mode: 0o755 });

      await expect(
        resolveVerifiedOpenCodeRuntimeBinaryPath({ shellEnvTimeoutMs: 0 })
      ).resolves.toBe(binaryPath);
      expect(resolveInteractiveShellEnvBestEffortMock).not.toHaveBeenCalled();
      expect(execCliMock).toHaveBeenCalledWith(binaryPath, ['--version'], {
        timeout: 10_000,
        windowsHide: true,
      });
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
        writable: true,
      });
      if (originalAppData === undefined) {
        delete process.env.APPDATA;
      } else {
        process.env.APPDATA = originalAppData;
      }
    }
  });

  it('skips a broken newer nvm OpenCode binary and reports the next working install', async () => {
    const brokenBinaryPath = path.join(
      tempRoot!,
      '.nvm',
      'versions',
      'node',
      'v23.0.0',
      'bin',
      'opencode'
    );
    const workingBinaryPath = path.join(
      tempRoot!,
      '.nvm',
      'versions',
      'node',
      'v22.22.1',
      'bin',
      'opencode'
    );
    await mkdir(path.dirname(brokenBinaryPath), { recursive: true });
    await mkdir(path.dirname(workingBinaryPath), { recursive: true });
    await writeFile(brokenBinaryPath, 'broken binary', { mode: 0o755 });
    await writeFile(workingBinaryPath, 'working binary', { mode: 0o755 });
    getCachedShellEnvMock.mockReturnValue({ HOME: tempRoot! });
    getShellPreferredHomeMock.mockReturnValue(tempRoot!);
    execCliMock.mockImplementation(async (binaryPath: string) => {
      if (binaryPath === brokenBinaryPath) {
        throw new Error('broken nvm runtime');
      }
      return { stdout: 'opencode 1.15.6\n', stderr: '' };
    });

    await expect(resolveVerifiedOpenCodeRuntimeBinaryPath({ shellEnvTimeoutMs: 0 })).resolves.toBe(
      workingBinaryPath
    );
    await expect(new OpenCodeRuntimeInstallerService().getStatus()).resolves.toMatchObject({
      installed: true,
      source: 'path',
      state: 'ready',
      binaryPath: workingBinaryPath,
      version: 'opencode 1.15.6',
    });
  });

  it('falls through to shell PATH when all fast nvm candidates are broken', async () => {
    const brokenBinaryPath = path.join(
      tempRoot!,
      '.nvm',
      'versions',
      'node',
      'v23.0.0',
      'bin',
      'opencode'
    );
    const shellBinaryPath = path.join(tempRoot!, 'custom-npm-prefix', 'bin', 'opencode');
    await mkdir(path.dirname(brokenBinaryPath), { recursive: true });
    await mkdir(path.dirname(shellBinaryPath), { recursive: true });
    await writeFile(brokenBinaryPath, 'broken binary', { mode: 0o755 });
    await writeFile(shellBinaryPath, 'working binary', { mode: 0o755 });
    getCachedShellEnvMock.mockReturnValue({ HOME: tempRoot! });
    getShellPreferredHomeMock.mockReturnValue(tempRoot!);
    resolveInteractiveShellEnvBestEffortMock.mockResolvedValue({
      PATH: path.dirname(shellBinaryPath),
      HOME: tempRoot!,
    });
    execCliMock.mockImplementation(async (binaryPath: string) => {
      if (binaryPath === brokenBinaryPath) {
        throw new Error('broken nvm runtime');
      }
      return { stdout: 'opencode 1.15.6\n', stderr: '' };
    });

    await expect(resolveVerifiedOpenCodeRuntimeBinaryPath({ shellEnvTimeoutMs: 0 })).resolves.toBe(
      shellBinaryPath
    );
    expect(resolveInteractiveShellEnvBestEffortMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 0,
        fallbackEnv: process.env,
      })
    );
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

  it('prefers a working PATH OpenCode binary over a broken app-managed manifest', async () => {
    const appManagedBinaryPath = path.join(
      tempRoot!,
      'data',
      'runtimes',
      'opencode',
      'versions',
      '1.0.0',
      'opencode-test',
      'opencode'
    );
    const pathBinaryPath = path.join(tempRoot!, 'homebrew', 'bin', 'opencode');
    const manifestPath = path.join(tempRoot!, 'data', 'runtimes', 'opencode', 'current.json');
    await mkdir(path.dirname(appManagedBinaryPath), { recursive: true });
    await mkdir(path.dirname(pathBinaryPath), { recursive: true });
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(appManagedBinaryPath, 'broken binary', { mode: 0o755 });
    await writeFile(pathBinaryPath, 'path binary', { mode: 0o755 });
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        version: '1.0.0',
        platformPackage: 'opencode-test',
        binaryPath: appManagedBinaryPath,
        integrity: 'sha512-test',
        installedAt: '2026-05-12T00:00:00.000Z',
      })}\n`,
      'utf8'
    );
    buildMergedCliPathMock.mockReturnValue(path.dirname(pathBinaryPath));
    execCliMock.mockImplementation(async (binaryPath: string) => {
      if (binaryPath === appManagedBinaryPath) {
        throw new Error('broken app-managed runtime');
      }
      return { stdout: 'opencode 1.0.0\n', stderr: '' };
    });

    await expect(new OpenCodeRuntimeInstallerService().getStatus()).resolves.toMatchObject({
      installed: true,
      source: 'path',
      state: 'ready',
      binaryPath: pathBinaryPath,
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
