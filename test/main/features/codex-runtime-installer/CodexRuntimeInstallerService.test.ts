import { createHash } from 'crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { gzipSync } from 'zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execCliMock = vi.hoisted(() => vi.fn());
const buildMergedCliPathMock = vi.hoisted(() => vi.fn(() => process.env.PATH ?? ''));
const getCachedShellEnvMock = vi.hoisted(() => vi.fn<() => NodeJS.ProcessEnv | null>(() => null));
const resolveInteractiveShellEnvBestEffortMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<NodeJS.ProcessEnv>>(() => Promise.resolve({}))
);

vi.mock('@main/utils/childProcess', () => ({
  execCli: execCliMock,
}));
vi.mock('@main/utils/cliPathMerge', () => ({
  buildMergedCliPath: buildMergedCliPathMock,
}));
vi.mock('@main/utils/shellEnv', () => ({
  getCachedShellEnv: getCachedShellEnvMock,
  resolveInteractiveShellEnvBestEffort: resolveInteractiveShellEnvBestEffortMock,
}));

import {
  createCodexRuntimeInstallerFeature,
  extractCodexRuntimePackageFilesFromTarball,
  getCodexRuntimePlatformCandidates,
  resolveAppManagedCodexRuntimeBinaryPath,
  resolveVerifiedAppManagedCodexRuntimeBinaryPath,
  verifyCodexRuntimePackageIntegrity,
} from '@features/codex-runtime-installer/main';
import { setAppDataBasePath } from '@main/utils/pathDecoder';

let tempRoot: string | null = null;
const originalPath = process.env.PATH;

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

describe('CodexRuntimeInstallerService resolver', () => {
  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-runtime-resolver-'));
    setAppDataBasePath(tempRoot);
    execCliMock.mockReset();
    execCliMock.mockResolvedValue({ stdout: 'codex-cli 1.0.0\n', stderr: '' });
    buildMergedCliPathMock.mockReset();
    buildMergedCliPathMock.mockImplementation(() => process.env.PATH ?? '');
    getCachedShellEnvMock.mockReset();
    getCachedShellEnvMock.mockReturnValue(null);
    resolveInteractiveShellEnvBestEffortMock.mockReset();
    resolveInteractiveShellEnvBestEffortMock.mockResolvedValue({});
  });

  afterEach(async () => {
    setAppDataBasePath(null);
    process.env.PATH = originalPath;
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it('returns the current app-managed Codex binary path only when manifest and binary exist', async () => {
    const binaryPath = path.join(
      tempRoot!,
      'data',
      'runtimes',
      'codex',
      'versions',
      '1.0.0-darwin-arm64',
      'aarch64-apple-darwin',
      'codex',
      'codex'
    );
    const manifestPath = path.join(tempRoot!, 'data', 'runtimes', 'codex', 'current.json');
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(binaryPath, 'binary', { mode: 0o755 });
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        rootVersion: '1.0.0',
        platformVersion: '1.0.0-darwin-arm64',
        platformTarget: 'aarch64-apple-darwin',
        binaryPath,
        integrity: 'sha512-test',
        installedAt: '2026-05-13T00:00:00.000Z',
      })}\n`,
      'utf8'
    );

    expect(resolveAppManagedCodexRuntimeBinaryPath()).toBe(binaryPath);
  });

  it('ignores a manifest whose binary path is missing', async () => {
    const manifestPath = path.join(tempRoot!, 'data', 'runtimes', 'codex', 'current.json');
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        rootVersion: '1.0.0',
        platformVersion: '1.0.0-darwin-arm64',
        platformTarget: 'aarch64-apple-darwin',
        binaryPath: path.join(tempRoot!, 'missing-codex'),
        integrity: 'sha512-test',
        installedAt: '2026-05-13T00:00:00.000Z',
      })}\n`,
      'utf8'
    );

    expect(resolveAppManagedCodexRuntimeBinaryPath()).toBeNull();
  });

  it('returns the verified app-managed binary path only when --version succeeds', async () => {
    const binaryPath = path.join(
      tempRoot!,
      'data',
      'runtimes',
      'codex',
      'versions',
      '1.0.0-darwin-arm64',
      'aarch64-apple-darwin',
      'codex',
      'codex'
    );
    const manifestPath = path.join(tempRoot!, 'data', 'runtimes', 'codex', 'current.json');
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(binaryPath, 'binary', { mode: 0o755 });
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        rootVersion: '1.0.0',
        platformVersion: '1.0.0-darwin-arm64',
        platformTarget: 'aarch64-apple-darwin',
        binaryPath,
        integrity: 'sha512-test',
        installedAt: '2026-05-13T00:00:00.000Z',
      })}\n`,
      'utf8'
    );

    await expect(resolveVerifiedAppManagedCodexRuntimeBinaryPath()).resolves.toBe(binaryPath);
    expect(execCliMock).toHaveBeenCalledWith(binaryPath, ['--version'], {
      timeout: 10_000,
      windowsHide: true,
    });

    execCliMock.mockRejectedValueOnce(new Error('broken binary'));

    await expect(resolveVerifiedAppManagedCodexRuntimeBinaryPath()).resolves.toBeNull();
  });

  it('detects a PATH Codex binary from best-effort shell env when process PATH is cold', async () => {
    const binDir = path.join(tempRoot!, 'shell-bin');
    const executableName = process.platform === 'win32' ? 'codex.exe' : 'codex';
    const binaryPath = path.join(binDir, executableName);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test uses isolated temp dir
    await mkdir(binDir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test uses isolated temp dir
    await writeFile(binaryPath, 'binary');
    if (process.platform !== 'win32') {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test uses isolated temp dir
      await chmod(binaryPath, 0o755);
    }
    process.env.PATH = '/usr/bin:/bin';
    buildMergedCliPathMock.mockReturnValue('/usr/bin:/bin');
    resolveInteractiveShellEnvBestEffortMock.mockResolvedValue({ PATH: binDir });

    const status = await createCodexRuntimeInstallerFeature().getStatus();

    expect(status).toMatchObject({
      installed: true,
      binaryPath,
      source: 'path',
      state: 'ready',
    });
    expect(resolveInteractiveShellEnvBestEffortMock).toHaveBeenCalledWith(
      expect.objectContaining({
        fallbackEnv: process.env,
        timeoutMs: 1_500,
      })
    );
  });
});

describe('CodexRuntimeInstallerService package safety helpers', () => {
  it('selects expected platform packages', () => {
    expect(
      getCodexRuntimePlatformCandidates('darwin', 'arm64').map(
        (item) => item.optionalDependencyName
      )
    ).toEqual(['@openai/codex-darwin-arm64']);
    expect(
      getCodexRuntimePlatformCandidates('darwin', 'x64').map((item) => item.vendorTarget)
    ).toEqual(['x86_64-apple-darwin']);
    expect(
      getCodexRuntimePlatformCandidates('linux', 'x64').map((item) => item.vendorTarget)
    ).toEqual(['x86_64-unknown-linux-musl']);
    expect(
      getCodexRuntimePlatformCandidates('linux', 'arm64').map((item) => item.vendorTarget)
    ).toEqual(['aarch64-unknown-linux-musl']);
    expect(
      getCodexRuntimePlatformCandidates('win32', 'x64').map((item) => item.vendorTarget)
    ).toEqual(['x86_64-pc-windows-msvc']);
    expect(
      getCodexRuntimePlatformCandidates('win32', 'arm64').map((item) => item.vendorTarget)
    ).toEqual(['aarch64-pc-windows-msvc']);
  });

  it('fails npm integrity mismatches', () => {
    const payload = Buffer.from('actual package');
    const wrongHash = createHash('sha512').update('different package').digest('base64');

    expect(() => verifyCodexRuntimePackageIntegrity(payload, `sha512-${wrongHash}`)).toThrow(
      'integrity check failed'
    );
  });

  it('extracts the full selected Codex vendor payload from the package tarball', () => {
    const tarball = createTarball([
      { name: 'package/vendor/other-target/codex/codex', data: 'wrong' },
      { name: 'package/vendor/aarch64-apple-darwin/codex/codex', data: 'codex-binary' },
      { name: 'package/vendor/aarch64-apple-darwin/path/rg', data: 'rg-binary' },
    ]);

    const files = extractCodexRuntimePackageFilesFromTarball(
      tarball,
      'aarch64-apple-darwin',
      'codex'
    );

    expect(files.map((file) => file.relativePath).sort((a, b) => a.localeCompare(b))).toEqual([
      'codex/codex',
      'path/rg',
    ]);
    expect(files.find((file) => file.relativePath === 'codex/codex')?.data.toString()).toBe(
      'codex-binary'
    );
  });

  it('rejects tar path traversal before extraction', () => {
    const tarball = createTarball([
      { name: '../codex', data: 'unsafe' },
      { name: 'package/vendor/aarch64-apple-darwin/codex/codex', data: 'right' },
    ]);

    expect(() =>
      extractCodexRuntimePackageFilesFromTarball(tarball, 'aarch64-apple-darwin', 'codex')
    ).toThrow('Unsafe Codex package tar entry');
  });
});
