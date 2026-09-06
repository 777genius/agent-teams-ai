import { createHash } from 'crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'zlib';

const execCliMock = vi.hoisted(() => vi.fn());
const managedProbeWarningMock = vi.hoisted(() => vi.fn());
const buildMergedCliPathMock = vi.hoisted(() => vi.fn(() => process.env.PATH ?? ''));
const getCachedShellEnvMock = vi.hoisted(() => vi.fn<() => NodeJS.ProcessEnv | null>(() => null));
const resolveInteractiveShellEnvBestEffortMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<NodeJS.ProcessEnv>>(() => Promise.resolve({}))
);

vi.mock('@main/utils/childProcess', () => ({
  execCli: execCliMock,
}));
vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: managedProbeWarningMock,
    error: vi.fn(),
  }),
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
    managedProbeWarningMock.mockReset();
    execCliMock.mockResolvedValue({ stdout: 'codex-cli 1.0.0\n', stderr: '' });
    buildMergedCliPathMock.mockReset();
    buildMergedCliPathMock.mockImplementation(() => process.env.PATH ?? '');
    getCachedShellEnvMock.mockReset();
    getCachedShellEnvMock.mockReturnValue(null);
    resolveInteractiveShellEnvBestEffortMock.mockReset();
    resolveInteractiveShellEnvBestEffortMock.mockResolvedValue({});
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
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

  describe.each(['status', 'resolver'] as const)('managed probe recovery via %s', (consumer) => {
    let binaryPath: string;
    let pathBinary: string;

    beforeEach(async () => {
      const runtimeRoot = path.join(tempRoot!, 'data', 'runtimes', 'codex');
      const pathBinDir = path.join(tempRoot!, 'path-bin');
      const executableName = process.platform === 'win32' ? 'codex.exe' : 'codex';
      binaryPath = path.join(runtimeRoot, executableName);
      pathBinary = path.join(pathBinDir, executableName);
      await mkdir(runtimeRoot, { recursive: true });
      await mkdir(pathBinDir, { recursive: true });
      await writeFile(binaryPath, 'managed fixture', { mode: 0o755 });
      await writeFile(pathBinary, 'PATH fixture', { mode: 0o755 });
      await writeFile(
        path.join(runtimeRoot, 'current.json'),
        JSON.stringify({
          schemaVersion: 1,
          rootVersion: '1.0.0',
          platformVersion: '1.0.0-darwin-arm64',
          platformTarget: 'aarch64-apple-darwin',
          binaryPath,
          integrity: 'sha512-test',
          installedAt: '2026-05-13T00:00:00.000Z',
        })
      );
      process.env.PATH = pathBinDir;
      buildMergedCliPathMock.mockReturnValue(pathBinDir);
    });

    const runProbe = () =>
      consumer === 'status'
        ? createCodexRuntimeInstallerFeature({
            resolveLatestVersion: async () => '1.0.0',
          }).getStatus()
        : resolveVerifiedAppManagedCodexRuntimeBinaryPath();

    const expectFinalFailureFallback = async () => {
      const result = await runProbe();
      if (consumer === 'status') {
        expect(result).toMatchObject({ installed: true, source: 'path', binaryPath: pathBinary });
      } else {
        expect(result).toBeNull();
      }
    };

    const timeoutError = () =>
      Object.assign(new Error(`Command timed out after 10000ms: ${binaryPath} --version`), {
        killed: true,
        signal: 'SIGTERM',
        stdout: 'secret stdout',
        stderr: 'secret stderr',
      });

    it.each(['execCli', 'ETIMEDOUT'])(
      'retries one %s timeout and retains managed Codex',
      async (kind) => {
        const error =
          kind === 'execCli'
            ? timeoutError()
            : Object.assign(new Error('secret error output'), { code: 'ETIMEDOUT' });
        execCliMock.mockRejectedValueOnce(error);

        const result = await runProbe();

        if (consumer === 'status') {
          expect(result).toMatchObject({
            installed: true,
            source: 'app-managed',
            binaryPath,
            state: 'ready',
          });
        } else {
          expect(result).toBe(binaryPath);
        }
        expect(execCliMock).toHaveBeenCalledTimes(2);
        expect(execCliMock).toHaveBeenNthCalledWith(2, binaryPath, ['--version'], {
          timeout: 10_000,
          windowsHide: true,
        });
        expect(managedProbeWarningMock).toHaveBeenCalledWith(
          'Managed Codex version probe failed',
          expect.objectContaining({ binaryPath, attempt: 1, timedOut: true, retrying: true })
        );
        expect(JSON.stringify(managedProbeWarningMock.mock.calls)).not.toContain('secret');
      }
    );

    it('stops after two timeouts and preserves the existing final-failure fallback', async () => {
      execCliMock.mockRejectedValueOnce(timeoutError()).mockRejectedValueOnce(timeoutError());

      await expectFinalFailureFallback();

      expect(execCliMock.mock.calls.filter(([candidate]) => candidate === binaryPath)).toHaveLength(
        2
      );
      expect(managedProbeWarningMock).toHaveBeenCalledTimes(2);
      expect(managedProbeWarningMock).toHaveBeenLastCalledWith(
        'Managed Codex version probe failed',
        expect.objectContaining({ attempt: 2, timedOut: true, retrying: false })
      );
    });

    it.each(['ENOENT', 'ENOEXEC', 1, 'ABORT_ERR'])(
      'does not retry a hard failure with code %s',
      async (code) => {
        execCliMock.mockRejectedValueOnce(
          Object.assign(new Error('secret error output'), { code, killed: true, signal: 'SIGTERM' })
        );

        await expectFinalFailureFallback();

        expect(
          execCliMock.mock.calls.filter(([candidate]) => candidate === binaryPath)
        ).toHaveLength(1);
        expect(managedProbeWarningMock).toHaveBeenCalledWith(
          'Managed Codex version probe failed',
          expect.objectContaining({ code, attempt: 1, timedOut: false, retrying: false })
        );
        expect(JSON.stringify(managedProbeWarningMock.mock.calls)).not.toContain('secret');
      }
    );
  });

  it('detects a PATH Codex binary from best-effort shell env when process PATH is cold', async () => {
    const binDir = path.join(tempRoot!, 'shell-bin');
    const coldPath = path.join(tempRoot!, 'cold-path');
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
    await mkdir(coldPath, { recursive: true });
    process.env.PATH = coldPath;
    buildMergedCliPathMock.mockReturnValue(coldPath);
    resolveInteractiveShellEnvBestEffortMock.mockResolvedValue({ PATH: binDir });

    const status = await createCodexRuntimeInstallerFeature({
      resolveLatestVersion: async () => '1.1.0',
    }).getStatus();

    expect(status).toMatchObject({
      installed: true,
      binaryPath,
      latestVersion: '1.1.0',
      updateAvailable: true,
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

  it('keeps an installed PATH runtime usable when an update attempt fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const binDir = path.join(tempRoot!, 'path-bin');
    const executableName = process.platform === 'win32' ? 'codex.exe' : 'codex';
    const binaryPath = path.join(binDir, executableName);
    await mkdir(binDir, { recursive: true });
    await writeFile(binaryPath, 'binary');
    if (process.platform !== 'win32') {
      await chmod(binaryPath, 0o755);
    }
    process.env.PATH = binDir;
    buildMergedCliPathMock.mockReturnValue(binDir);
    const feature = createCodexRuntimeInstallerFeature({
      resolveLatestVersion: async () => '1.1.0',
    });

    await expect(feature.getStatus()).resolves.toMatchObject({
      installed: true,
      binaryPath,
      version: 'codex-cli 1.0.0',
      latestVersion: '1.1.0',
      updateAvailable: true,
    });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('registry offline')));

    await expect(feature.install()).resolves.toMatchObject({
      installed: true,
      binaryPath,
      version: 'codex-cli 1.0.0',
      latestVersion: '1.1.0',
      updateAvailable: true,
      source: 'path',
      state: 'failed',
      error: 'registry offline',
    });
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

  it('extracts the current Codex platform package layout', () => {
    const tarball = createTarball([
      { name: 'package/vendor/x86_64-unknown-linux-musl/bin/codex', data: 'codex-binary' },
      { name: 'package/vendor/x86_64-unknown-linux-musl/codex-path/rg', data: 'rg-binary' },
      { name: 'package/vendor/x86_64-unknown-linux-musl/codex-resources/bwrap', data: 'bwrap' },
    ]);

    const files = extractCodexRuntimePackageFilesFromTarball(
      tarball,
      'x86_64-unknown-linux-musl',
      'codex'
    );

    expect(files.map((file) => file.relativePath).sort((a, b) => a.localeCompare(b))).toEqual([
      'bin/codex',
      'codex-path/rg',
      'codex-resources/bwrap',
    ]);
    expect(files.find((file) => file.relativePath === 'bin/codex')?.data.toString()).toBe(
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
