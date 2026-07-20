import { createHash } from 'crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
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
  clearOpenCodeRuntimeBinaryResolverCache,
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
let originalAppData: string | undefined;
let originalNvmHome: string | undefined;
let originalNvmSymlink: string | undefined;

function restoreEnvValue(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function getTestNvmOpenCodeBinaryPath(version: string): string {
  return process.platform === 'win32'
    ? path.join(tempRoot!, 'nvm', version, 'opencode.exe')
    : path.join(tempRoot!, '.nvm', 'versions', 'node', version, 'bin', 'opencode');
}

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
    originalAppData = process.env.APPDATA;
    originalNvmHome = process.env.NVM_HOME;
    originalNvmSymlink = process.env.NVM_SYMLINK;
    process.env.PATH = '';
    process.env.APPDATA = tempRoot;
    delete process.env.NVM_HOME;
    delete process.env.NVM_SYMLINK;
    clearOpenCodeRuntimeBinaryResolverCache();
    execCliMock.mockReset();
    execCliMock.mockResolvedValue({ stdout: 'opencode 1.18.3\n', stderr: '' });
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
    vi.unstubAllGlobals();
    clearOpenCodeRuntimeBinaryResolverCache();
    setAppDataBasePath(null);
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalAppData;
    }
    restoreEnvValue('NVM_HOME', originalNvmHome);
    restoreEnvValue('NVM_SYMLINK', originalNvmSymlink);
    originalPath = undefined;
    originalAppData = undefined;
    originalNvmHome = undefined;
    originalNvmSymlink = undefined;
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
      timeout: 20_000,
      windowsHide: true,
    });

    clearOpenCodeRuntimeBinaryResolverCache();
    execCliMock.mockRejectedValueOnce(new Error('broken binary'));

    await expect(resolveVerifiedAppManagedOpenCodeRuntimeBinaryPath()).resolves.toBeNull();
  });

  it('rejects an executable old enough to corrupt a newer managed OpenCode profile', async () => {
    const binaryPath = path.join(
      tempRoot!,
      'data',
      'runtimes',
      'opencode',
      'versions',
      '1.15.6',
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
        version: '1.15.6',
        platformPackage: 'opencode-test',
        binaryPath,
        integrity: 'sha512-test',
        installedAt: '2026-07-20T00:00:00.000Z',
      })}\n`,
      'utf8'
    );
    execCliMock.mockResolvedValue({ stdout: 'opencode 1.15.6\n', stderr: '' });

    await expect(resolveVerifiedAppManagedOpenCodeRuntimeBinaryPath()).resolves.toBeNull();
    await expect(new OpenCodeRuntimeInstallerService().getStatus()).resolves.toMatchObject({
      installed: false,
      source: 'app-managed',
      state: 'failed',
      error: expect.stringContaining('below the supported minimum 1.16.0'),
    });
  });

  it('coalesces concurrent app-managed OpenCode verification probes', async () => {
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
    const versionProbe = deferred<{ stdout: string; stderr: string }>();
    execCliMock.mockReturnValue(versionProbe.promise);

    const first = resolveVerifiedAppManagedOpenCodeRuntimeBinaryPath();
    const second = resolveVerifiedAppManagedOpenCodeRuntimeBinaryPath();
    await vi.waitFor(() => expect(execCliMock).toHaveBeenCalledTimes(1));

    versionProbe.resolve({ stdout: 'opencode 1.18.3\n', stderr: '' });
    await expect(Promise.all([first, second])).resolves.toEqual([binaryPath, binaryPath]);

    await expect(resolveVerifiedAppManagedOpenCodeRuntimeBinaryPath()).resolves.toBe(binaryPath);
    expect(execCliMock).toHaveBeenCalledTimes(1);
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
      timeout: 20_000,
      windowsHide: true,
    });
  });

  it('coalesces concurrent verified OpenCode PATH probes and reuses the warm result', async () => {
    const binaryPath = path.join(tempRoot!, 'homebrew', 'bin', 'opencode');
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, 'binary', { mode: 0o755 });
    resolveInteractiveShellEnvBestEffortMock.mockResolvedValue({
      PATH: path.dirname(binaryPath),
    });
    getShellPreferredHomeMock.mockReturnValue(tempRoot!);
    const versionProbe = deferred<{ stdout: string; stderr: string }>();
    execCliMock.mockReturnValue(versionProbe.promise);

    const first = resolveVerifiedOpenCodeRuntimeBinaryPath({ shellEnvTimeoutMs: 0 });
    const second = resolveVerifiedOpenCodeRuntimeBinaryPath({ shellEnvTimeoutMs: 0 });
    await vi.waitFor(() => expect(execCliMock).toHaveBeenCalledTimes(1));

    versionProbe.resolve({ stdout: 'opencode 1.18.3\n', stderr: '' });
    await expect(Promise.all([first, second])).resolves.toEqual([binaryPath, binaryPath]);

    await expect(resolveVerifiedOpenCodeRuntimeBinaryPath({ shellEnvTimeoutMs: 0 })).resolves.toBe(
      binaryPath
    );
    expect(execCliMock).toHaveBeenCalledTimes(1);
    expect(resolveInteractiveShellEnvBestEffortMock).toHaveBeenCalledTimes(1);
  });

  it('does not warm verified OpenCode PATH caches from a stale in-flight probe', async () => {
    const binaryPath = path.join(tempRoot!, 'homebrew', 'bin', 'opencode');
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, 'binary', { mode: 0o755 });
    resolveInteractiveShellEnvBestEffortMock.mockResolvedValue({
      PATH: path.dirname(binaryPath),
    });
    getShellPreferredHomeMock.mockReturnValue(tempRoot!);
    const versionProbe = deferred<{ stdout: string; stderr: string }>();
    execCliMock.mockReturnValueOnce(versionProbe.promise);

    const staleResolve = resolveVerifiedOpenCodeRuntimeBinaryPath({ shellEnvTimeoutMs: 0 });
    await vi.waitFor(() => expect(execCliMock).toHaveBeenCalledTimes(1));

    clearOpenCodeRuntimeBinaryResolverCache();
    versionProbe.resolve({ stdout: 'opencode 1.18.3\n', stderr: '' });
    await expect(staleResolve).resolves.toBe(binaryPath);

    await expect(resolveVerifiedOpenCodeRuntimeBinaryPath({ shellEnvTimeoutMs: 0 })).resolves.toBe(
      binaryPath
    );
    expect(execCliMock).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent OpenCode runtime status checks and serves a short warm cache', async () => {
    const binaryPath = path.join(tempRoot!, 'homebrew', 'bin', 'opencode');
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, 'binary', { mode: 0o755 });
    resolveInteractiveShellEnvBestEffortMock.mockResolvedValue({
      PATH: path.dirname(binaryPath),
    });
    getShellPreferredHomeMock.mockReturnValue(tempRoot!);
    const versionProbe = deferred<{ stdout: string; stderr: string }>();
    execCliMock.mockReturnValue(versionProbe.promise);
    const service = new OpenCodeRuntimeInstallerService();

    const first = service.getStatus();
    const second = service.getStatus();
    await vi.waitFor(() => expect(execCliMock).toHaveBeenCalledTimes(1));

    versionProbe.resolve({ stdout: 'opencode 1.18.3\n', stderr: '' });
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { installed: true, source: 'path', binaryPath },
      { installed: true, source: 'path', binaryPath },
    ]);

    await expect(service.getStatus()).resolves.toMatchObject({
      installed: true,
      source: 'path',
      binaryPath,
    });
    expect(execCliMock).toHaveBeenCalledTimes(1);
  });

  it('does not remember OpenCode runtime status from a stale in-flight check', async () => {
    const binaryPath = path.join(tempRoot!, 'homebrew', 'bin', 'opencode');
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, 'binary', { mode: 0o755 });
    resolveInteractiveShellEnvBestEffortMock.mockResolvedValue({
      PATH: path.dirname(binaryPath),
    });
    getShellPreferredHomeMock.mockReturnValue(tempRoot!);
    const versionProbe = deferred<{ stdout: string; stderr: string }>();
    execCliMock.mockReturnValueOnce(versionProbe.promise).mockResolvedValue({
      stdout: 'opencode 2.0.0\n',
      stderr: '',
    });
    const service = new OpenCodeRuntimeInstallerService();

    const staleStatus = service.getStatus();
    await vi.waitFor(() => expect(execCliMock).toHaveBeenCalledTimes(1));

    service.invalidateStatusCache();
    versionProbe.resolve({ stdout: 'opencode 1.18.3\n', stderr: '' });
    await expect(staleStatus).resolves.toMatchObject({
      installed: true,
      source: 'path',
      binaryPath,
      version: 'opencode 1.18.3',
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      installed: true,
      source: 'path',
      binaryPath,
      version: 'opencode 2.0.0',
    });
    expect(execCliMock).toHaveBeenCalledTimes(2);
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
      timeout: 20_000,
      windowsHide: true,
    });
  });

  it('resolves from fast fallback PATH without spawning shell env when shell env is disabled', async () => {
    const binaryPath = path.join(tempRoot!, 'merged-cli-path', 'bin', 'opencode');
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, 'binary', { mode: 0o755 });
    buildMergedCliPathMock.mockReturnValue(path.dirname(binaryPath));

    await expect(
      resolveVerifiedOpenCodeRuntimeBinaryPath({ includeShellEnv: false })
    ).resolves.toBe(binaryPath);
    expect(resolveInteractiveShellEnvBestEffortMock).not.toHaveBeenCalled();
    expect(execCliMock).toHaveBeenCalledWith(binaryPath, ['--version'], {
      timeout: 20_000,
      windowsHide: true,
    });
  });

  it('does not spawn shell env for shell-only PATH installs when shell env is disabled', async () => {
    const binaryPath = path.join(tempRoot!, 'custom-npm-prefix', 'bin', 'opencode');
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, 'binary', { mode: 0o755 });
    resolveInteractiveShellEnvBestEffortMock.mockResolvedValue({
      PATH: path.dirname(binaryPath),
    });

    await expect(
      resolveVerifiedOpenCodeRuntimeBinaryPath({ includeShellEnv: false })
    ).resolves.toBeNull();
    expect(resolveInteractiveShellEnvBestEffortMock).not.toHaveBeenCalled();
  });

  it('returns a verified OpenCode binary from nvm when desktop PATH misses npm globals', async () => {
    const olderBinaryPath = getTestNvmOpenCodeBinaryPath('v20.10.0');
    const binaryPath = getTestNvmOpenCodeBinaryPath('v22.22.1');
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
      timeout: 20_000,
      windowsHide: true,
    });
  });

  it('returns the native executable behind an nvm-windows cmd shim when desktop PATH misses npm globals', async () => {
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
      const shimPath = path.join(tempRoot!, 'nvm', 'v22.22.1', 'opencode.cmd');
      const binaryPath = path.join(
        tempRoot!,
        'nvm',
        'v22.22.1',
        'node_modules',
        'opencode-ai',
        'node_modules',
        `opencode-windows-${process.arch}`,
        'bin',
        'opencode.exe'
      );
      await mkdir(path.dirname(olderBinaryPath), { recursive: true });
      await mkdir(path.dirname(binaryPath), { recursive: true });
      await writeFile(olderBinaryPath, 'older binary', { mode: 0o755 });
      await writeFile(shimPath, 'npm shim', { mode: 0o755 });
      await writeFile(binaryPath, 'binary', { mode: 0o755 });

      await expect(
        resolveVerifiedOpenCodeRuntimeBinaryPath({ shellEnvTimeoutMs: 0 })
      ).resolves.toBe(binaryPath);
      expect(resolveInteractiveShellEnvBestEffortMock).not.toHaveBeenCalled();
      expect(execCliMock).toHaveBeenCalledWith(binaryPath, ['--version'], {
        timeout: 20_000,
        windowsHide: true,
      });
      expect(execCliMock).not.toHaveBeenCalledWith(shimPath, expect.anything(), expect.anything());
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

  it('prefers the active NVM_SYMLINK runtime over newer installs in a custom NVM_HOME', async () => {
    const originalPlatform = process.platform;
    const originalAppData = process.env.APPDATA;
    const originalNvmHome = process.env.NVM_HOME;
    const originalNvmSymlink = process.env.NVM_SYMLINK;

    try {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
        writable: true,
      });
      process.env.APPDATA = path.join(tempRoot!, 'empty-appdata');
      process.env.NVM_HOME = path.join(tempRoot!, 'custom-nvm');
      process.env.NVM_SYMLINK = path.join(tempRoot!, 'active-node');

      const activeShimPath = path.join(process.env.NVM_SYMLINK, 'opencode.cmd');
      const activeNativePath = path.join(
        process.env.NVM_SYMLINK,
        'node_modules',
        'opencode-ai',
        'bin',
        'opencode.exe'
      );
      const newerShimPath = path.join(process.env.NVM_HOME, 'v99.0.0', 'opencode.cmd');
      const newerNativePath = path.join(
        process.env.NVM_HOME,
        'v99.0.0',
        'node_modules',
        'opencode-ai',
        'bin',
        'opencode.exe'
      );
      await mkdir(path.dirname(activeNativePath), { recursive: true });
      await mkdir(path.dirname(newerNativePath), { recursive: true });
      await writeFile(activeShimPath, 'active npm shim', { mode: 0o755 });
      await writeFile(activeNativePath, 'active native binary', { mode: 0o755 });
      await writeFile(newerShimPath, 'newer npm shim', { mode: 0o755 });
      await writeFile(newerNativePath, 'newer native binary', { mode: 0o755 });

      await expect(
        resolveVerifiedOpenCodeRuntimeBinaryPath({ shellEnvTimeoutMs: 0 })
      ).resolves.toBe(activeNativePath);
      expect(execCliMock).not.toHaveBeenCalledWith(
        newerNativePath,
        expect.anything(),
        expect.anything()
      );
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
        writable: true,
      });
      restoreEnvValue('APPDATA', originalAppData);
      restoreEnvValue('NVM_HOME', originalNvmHome);
      restoreEnvValue('NVM_SYMLINK', originalNvmSymlink);
    }
  });

  it('prefers the active npm OpenCode native executable over a stale nvm-windows cmd shim', async () => {
    const originalPlatform = process.platform;
    const originalAppData = process.env.APPDATA;

    try {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
        writable: true,
      });
      process.env.APPDATA = tempRoot!;

      const activeNpmDirectory = path.join(tempRoot!, 'npm');
      const activeShimPath = path.join(activeNpmDirectory, 'opencode.cmd');
      const activeNativePath = path.join(
        activeNpmDirectory,
        'node_modules',
        'opencode-ai',
        'bin',
        'opencode.exe'
      );
      const staleNvmDirectory = path.join(tempRoot!, 'nvm', 'v20.20.0');
      const staleNvmShimPath = path.join(staleNvmDirectory, 'opencode.cmd');
      const staleNvmNativePath = path.join(
        staleNvmDirectory,
        'node_modules',
        'opencode-ai',
        'bin',
        'opencode.exe'
      );
      await mkdir(path.dirname(activeNativePath), { recursive: true });
      await mkdir(path.dirname(staleNvmNativePath), { recursive: true });
      await writeFile(activeShimPath, 'active npm shim', { mode: 0o755 });
      await writeFile(activeNativePath, 'active native binary', { mode: 0o755 });
      await writeFile(staleNvmShimPath, 'stale nvm shim', { mode: 0o755 });
      await writeFile(staleNvmNativePath, 'stale native binary', { mode: 0o755 });
      process.env.PATH = activeNpmDirectory;
      getCachedShellEnvMock.mockReturnValue({ PATH: staleNvmDirectory });
      execCliMock.mockImplementation(async (binaryPath: string) => ({
        stdout: binaryPath === activeNativePath ? '1.18.3\n' : '1.15.6\n',
        stderr: '',
      }));

      await expect(
        resolveVerifiedOpenCodeRuntimeBinaryPath({ shellEnvTimeoutMs: 0 })
      ).resolves.toBe(activeNativePath);
      expect(execCliMock).toHaveBeenCalledWith(activeNativePath, ['--version'], {
        timeout: 20_000,
        windowsHide: true,
      });
      expect(execCliMock).not.toHaveBeenCalledWith(
        staleNvmNativePath,
        expect.anything(),
        expect.anything()
      );
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

  it('does not report a Windows cmd-only OpenCode installation as runtime-ready', async () => {
    const originalPlatform = process.platform;

    try {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
        writable: true,
      });

      const shimDirectory = path.join(tempRoot!, 'npm');
      const shimPath = path.join(shimDirectory, 'opencode.cmd');
      await mkdir(shimDirectory, { recursive: true });
      await writeFile(shimPath, 'incomplete npm shim', { mode: 0o755 });
      process.env.PATH = shimDirectory;
      getCachedShellEnvMock.mockReturnValue({ PATH: shimDirectory });

      await expect(
        resolveVerifiedOpenCodeRuntimeBinaryPath({
          includeShellEnv: false,
          shellEnvTimeoutMs: 0,
        })
      ).resolves.toBeNull();
      expect(execCliMock).not.toHaveBeenCalledWith(shimPath, expect.anything(), expect.anything());
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
        writable: true,
      });
    }
  });

  it('skips a broken newer nvm OpenCode binary and reports the next working install', async () => {
    const brokenBinaryPath = getTestNvmOpenCodeBinaryPath('v23.0.0');
    const workingBinaryPath = getTestNvmOpenCodeBinaryPath('v22.22.1');
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
      return { stdout: 'opencode 1.18.3\n', stderr: '' };
    });

    await expect(resolveVerifiedOpenCodeRuntimeBinaryPath({ shellEnvTimeoutMs: 0 })).resolves.toBe(
      workingBinaryPath
    );
    await expect(new OpenCodeRuntimeInstallerService().getStatus()).resolves.toMatchObject({
      installed: true,
      source: 'path',
      state: 'ready',
      binaryPath: workingBinaryPath,
      version: 'opencode 1.18.3',
    });
  });

  it('falls through to shell PATH when all fast nvm candidates are broken', async () => {
    const brokenBinaryPath = getTestNvmOpenCodeBinaryPath('v23.0.0');
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
      return { stdout: 'opencode 1.18.3\n', stderr: '' };
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
      version: 'opencode 1.18.3',
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
      return { stdout: 'opencode 1.18.3\n', stderr: '' };
    });

    await expect(new OpenCodeRuntimeInstallerService().getStatus()).resolves.toMatchObject({
      installed: true,
      source: 'path',
      state: 'ready',
      binaryPath: pathBinaryPath,
      version: 'opencode 1.18.3',
    });
  });

  it('keeps an existing working runtime available when an update fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
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
    await writeFile(binaryPath, 'working binary', { mode: 0o755 });
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
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('registry unavailable')));
    const service = new OpenCodeRuntimeInstallerService();

    await expect(service.install()).resolves.toMatchObject({
      installed: true,
      source: 'app-managed',
      state: 'failed',
      binaryPath,
      error: 'registry unavailable',
    });
    await expect(service.getStatus()).resolves.toMatchObject({
      installed: true,
      source: 'app-managed',
      binaryPath,
    });
    expect(consoleError).toHaveBeenCalledWith(
      '[OpenCodeRuntimeInstallerService]',
      'Failed to install OpenCode runtime:',
      'registry unavailable'
    );
  });

  it('does not preserve a cached installed status after the runtime binary disappears', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
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
    await writeFile(binaryPath, 'working binary', { mode: 0o755 });
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
    const service = new OpenCodeRuntimeInstallerService();
    await expect(service.getStatus()).resolves.toMatchObject({
      installed: true,
      source: 'app-managed',
      binaryPath,
    });

    await rm(binaryPath, { force: true });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('registry unavailable')));

    await expect(service.install()).resolves.toMatchObject({
      installed: false,
      source: 'missing',
      state: 'failed',
      error: 'registry unavailable',
    });
    expect(consoleError).toHaveBeenCalledWith(
      '[OpenCodeRuntimeInstallerService]',
      'Failed to install OpenCode runtime:',
      'registry unavailable'
    );
  });

  it('does not replace a verified identical runtime during reinstall', async () => {
    const platformPackage = getOpenCodeRuntimePlatformCandidates()[0]!.packageName;
    const executableName = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
    const binaryPath = path.join(
      tempRoot!,
      'data',
      'runtimes',
      'opencode',
      'versions',
      '1.0.0',
      platformPackage,
      executableName
    );
    const manifestPath = path.join(tempRoot!, 'data', 'runtimes', 'opencode', 'current.json');
    const tarball = createTarball([
      { name: `package/bin/${executableName}`, data: 'downloaded replacement' },
    ]);
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, 'existing working runtime', { mode: 0o755 });
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        version: '1.0.0',
        platformPackage,
        binaryPath,
        integrity,
        installedAt: '2026-05-12T00:00:00.000Z',
      })}\n`,
      'utf8'
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        if (url.endsWith('/opencode-ai/latest')) {
          return Response.json({
            version: '1.0.0',
            dist: { tarball: 'https://example.test/root.tgz', integrity },
            optionalDependencies: { [platformPackage]: '1.0.0' },
          });
        }
        if (url.includes(`/${platformPackage}/1.0.0`)) {
          return Response.json({
            version: '1.0.0',
            dist: { tarball: 'https://example.test/platform.tgz', integrity },
          });
        }
        if (url === 'https://example.test/platform.tgz') {
          return new Response(new Uint8Array(tarball), {
            headers: { 'content-length': String(tarball.length) },
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      })
    );

    await expect(new OpenCodeRuntimeInstallerService().install()).resolves.toMatchObject({
      installed: true,
      source: 'app-managed',
      state: 'ready',
      binaryPath,
    });
    await expect(readFile(binaryPath, 'utf8')).resolves.toBe('existing working runtime');

    const runtimeRoot = path.join(tempRoot!, 'data', 'runtimes', 'opencode');
    const entries = await readdir(runtimeRoot);
    expect(entries.filter((entry) => entry.startsWith('installing-'))).toEqual([]);
  });

  it('removes a partially extracted runtime when binary verification fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const platformPackage = getOpenCodeRuntimePlatformCandidates()[0]!.packageName;
    const executableName = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
    const tarball = createTarball([
      { name: `package/bin/${executableName}`, data: 'broken runtime' },
    ]);
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/opencode-ai/latest')) {
        return Response.json({
          version: '1.0.0',
          dist: { tarball: 'https://example.test/root.tgz', integrity },
          optionalDependencies: { [platformPackage]: '1.0.0' },
        });
      }
      if (url.includes(`/${platformPackage}/1.0.0`)) {
        return Response.json({
          version: '1.0.0',
          dist: { tarball: 'https://example.test/platform.tgz', integrity },
        });
      }
      if (url === 'https://example.test/platform.tgz') {
        return new Response(new Uint8Array(tarball), {
          headers: { 'content-length': String(tarball.length) },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    execCliMock.mockRejectedValueOnce(new Error('binary verification failed'));

    await expect(new OpenCodeRuntimeInstallerService().install()).resolves.toMatchObject({
      installed: false,
      state: 'failed',
      error: 'binary verification failed',
    });

    const runtimeRoot = path.join(tempRoot!, 'data', 'runtimes', 'opencode');
    const entries = await readdir(runtimeRoot);
    expect(entries.filter((entry) => entry.startsWith('installing-'))).toEqual([]);
    expect(consoleError).toHaveBeenCalledWith(
      '[OpenCodeRuntimeInstallerService]',
      'Failed to install OpenCode runtime:',
      'binary verification failed'
    );
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
