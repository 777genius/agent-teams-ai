import { getLatestQualifiedOpenCodeV2Version } from '@features/opencode-compatibility';
vi.mock('@shared/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/utils/logger')>();
  return {
    ...actual,
    createLogger: (name: string) => {
      const logger = actual.createLogger(name);
      return name === 'OpenCodeVersionDiagnostics' ? { ...logger, warn: vi.fn() } : logger;
    },
  };
});

import { createHash } from 'crypto';
import { link, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'fs/promises';
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
  isSupportedOpenCodeRuntimeBinaryPath,
  OpenCodeRuntimeInstallerService,
  resolveAppManagedOpenCodeRuntimeBinaryPath,
  resolveCachedVerifiedOpenCodeRuntimeBinaryPath,
  resolveVerifiedAppManagedOpenCodeRuntimeBinaryPath,
  resolveVerifiedOpenCodeRuntimeBinaryPath,
  verifyOpenCodeRuntimePackageIntegrity,
} from '@main/services/infrastructure/OpenCodeRuntimeInstallerService';
import { collectWindowsNativeOpenCodeBinaryCandidates } from '@main/services/infrastructure/openCodeWindowsNpmBinaryDiscovery';
import { ensureOpenCodeBridgeRuntimeBinaryEnv } from '@main/services/runtime/openCodeBridgeRuntimeEnv';
import { setAppDataBasePath } from '@main/utils/pathDecoder';

/** Native selection/package fixtures start with V2 support already installed; ZIP transport has its own suite. */
function createNativeOnlyInstaller(): OpenCodeRuntimeInstallerService {
  return new OpenCodeRuntimeInstallerService({
    withStatus: vi.fn(async (status: import('@shared/types').OpenCodeRuntimeStatus) =>
      status.installed && status.version?.startsWith('2.')
        ? { ...status, v2Support: 'ready' as const }
        : status
    ),
    install: vi.fn(async () => undefined),
  });
}

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

/** Native executable name for PATH-style fixtures: Windows only launches .exe files. */
function getTestNativeOpenCodeBinaryName(): string {
  return process.platform === 'win32' ? 'opencode.exe' : 'opencode';
}

async function withWindowsPlatform<T>(run: () => Promise<T>): Promise<T> {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', {
    value: 'win32',
    configurable: true,
    writable: true,
  });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
      writable: true,
    });
  }
}

async function writeOpenCodeNpmPackage(
  packageRoot: string,
  manifest: { name: string; version: string }
): Promise<void> {
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify(manifest));
}

/** Rewrite the npm shims so they invoke `packageName`, as npm would after installing it. */
async function writeOpenCodeNpmShims(
  prefix: string,
  packageName: 'opencode-ai' | '@opencode/cli'
): Promise<void> {
  const posixPackagePath = packageName.split('/').join('/');
  const windowsPackagePath = packageName.split('/').join('\\');
  await writeFile(
    path.join(prefix, 'opencode'),
    `#!/bin/sh\nexec "$basedir/node_modules/${posixPackagePath}/bin/opencode.exe" "$@"\n`,
    { mode: 0o755 }
  );
  await writeFile(
    path.join(prefix, 'opencode.cmd'),
    `@ECHO off\r\n"%dp0%\\node_modules\\${windowsPackagePath}\\bin\\opencode.exe" %*\r\n`
  );
}

interface OpenCodeNpmInstall {
  wrapperBinary: string;
  platformBinary: string;
  cmdShim: string;
  shellShim: string;
}

/**
 * Current Windows npm install layout: prefix shims plus `@opencode/cli` 2.2.0
 * whose postinstall hard-links `bin/opencode.exe` from a platform package.
 */
async function createOpenCodeV2NpmInstall(
  prefix: string,
  options: { hoisted?: boolean } = {}
): Promise<OpenCodeNpmInstall> {
  const wrapperRoot = path.join(prefix, 'node_modules', '@opencode', 'cli');
  const platformScope = options.hoisted
    ? path.join(prefix, 'node_modules', '@opencode')
    : path.join(wrapperRoot, 'node_modules', '@opencode');
  const platformRoot = path.join(platformScope, 'cli-windows-x64');
  const wrapperBinary = path.join(wrapperRoot, 'bin', 'opencode.exe');
  const platformBinary = path.join(platformRoot, 'bin', 'opencode.exe');
  await writeOpenCodeNpmPackage(wrapperRoot, { name: '@opencode/cli', version: '2.2.0' });
  await writeOpenCodeNpmPackage(platformRoot, {
    name: '@opencode/cli-windows-x64',
    version: '2.2.0',
  });
  await mkdir(path.dirname(wrapperBinary), { recursive: true });
  await mkdir(path.dirname(platformBinary), { recursive: true });
  await writeFile(platformBinary, 'TEST V2 native binary');
  await link(platformBinary, wrapperBinary);
  await writeOpenCodeNpmShims(prefix, '@opencode/cli');
  return {
    wrapperBinary,
    platformBinary,
    cmdShim: path.join(prefix, 'opencode.cmd'),
    shellShim: path.join(prefix, 'opencode'),
  };
}

/**
 * Side-by-side npm install: a leftover legacy `opencode-ai` package plus the
 * current `@opencode/cli` package. `shimTarget` is the package the npm shims were
 * generated for, i.e. the one the user's `opencode` command actually runs.
 */
async function createOpenCodeCoexistingNpmInstall(
  prefix: string,
  shimTarget: 'legacy' | 'v2'
): Promise<OpenCodeNpmInstall & { legacyBinary: string }> {
  const legacyRoot = path.join(prefix, 'node_modules', 'opencode-ai');
  const legacyBinary = path.join(legacyRoot, 'bin', 'opencode.exe');
  await mkdir(path.dirname(legacyBinary), { recursive: true });
  await writeFile(legacyBinary, 'TEST legacy native binary');
  const v2Install = await createOpenCodeV2NpmInstall(prefix);
  if (shimTarget === 'legacy') {
    await writeOpenCodeNpmShims(prefix, 'opencode-ai');
  }
  return { legacyBinary, ...v2Install };
}

type CoexistingOpenCodeNpmInstall = Awaited<ReturnType<typeof createOpenCodeCoexistingNpmInstall>>;

/** Mock one recognized `--version` output per binary path; other paths stay unrecognized. */
function mockOpenCodeVersions(versionsByBinaryPath: Record<string, string>): void {
  execCliMock.mockImplementation(async (binaryPath: string) => ({
    stdout: versionsByBinaryPath[binaryPath] ?? '',
    stderr: '',
  }));
}

/** A Windows npm shim must never be handed to execCli as a native program. */
function expectNotProbed(...candidates: string[]): void {
  for (const candidate of candidates) {
    expect(execCliMock).not.toHaveBeenCalledWith(candidate, expect.anything(), expect.anything());
  }
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
    execCliMock.mockResolvedValue({ stdout: '1.18.3\n', stderr: '' });
    buildMergedCliPathMock.mockReset();
    buildMergedCliPathMock.mockReturnValue('');
    getCachedShellEnvMock.mockReset();
    getCachedShellEnvMock.mockReturnValue(null);
    getShellPreferredHomeMock.mockReset();
    getShellPreferredHomeMock.mockReturnValue(os.homedir());
    resolveInteractiveShellEnvBestEffortMock.mockReset();
    resolveInteractiveShellEnvBestEffortMock.mockResolvedValue(process.env);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          version: '1.18.3',
          dist: { tarball: 'https://example.test/opencode.tgz', integrity: 'sha512-test' },
        })
      )
    );
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

  it.each([false, true])(
    'cold PATH V2 support-only intent preserves native selection (repair=%s)',
    async (repair) => {
      const binaryPath = path.join(tempRoot!, 'TEST-path-v2', getTestNativeOpenCodeBinaryName());
      await mkdir(path.dirname(binaryPath), { recursive: true });
      await writeFile(binaryPath, 'selected native bytes', { mode: 0o755 });
      process.env.PATH = path.dirname(binaryPath);
      execCliMock.mockResolvedValue({ stdout: '2.9.0\n', stderr: '' });
      let ready = repair;
      const support = {
        withStatus: vi.fn(async (status: import('@shared/types').OpenCodeRuntimeStatus) => ({
          ...status,
          v2Support: ready ? ('ready' as const) : ('required' as const),
          ...(ready ? {} : { state: 'idle' as const }),
        })),
        install: vi.fn(async () => {
          ready = true;
        }),
      };
      const service = new OpenCodeRuntimeInstallerService(support);
      await expect(service.getReadinessStatus()).resolves.toMatchObject({
        installed: true,
        binaryPath,
        version: '2.9.0',
        source: 'path',
        state: repair ? 'ready' : 'idle',
        v2Support: repair ? 'ready' : 'required',
      });
      const status = await service.install(repair ? { supportOnly: true } : undefined);
      expect(status).toMatchObject({
        installed: true,
        binaryPath,
        version: '2.9.0',
        source: 'path',
        state: 'ready',
        v2Support: 'ready',
      });
      expect(support.install).toHaveBeenCalledWith('2.9.0', expect.any(Function));
      expect(fetch).not.toHaveBeenCalled();
      expect(resolveAppManagedOpenCodeRuntimeBinaryPath()).toBeNull();
      expect(await readFile(binaryPath, 'utf8')).toBe('selected native bytes');
    }
  );

  it('reports selected native V2 as requiring its missing default support without downloading', async () => {
    const binaryPath = path.join(
      tempRoot!,
      'TEST-missing-support',
      getTestNativeOpenCodeBinaryName()
    );
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, 'selected native bytes', { mode: 0o755 });
    process.env.PATH = path.dirname(binaryPath);
    execCliMock.mockResolvedValue({ stdout: '2.9.0\n', stderr: '' });

    await expect(new OpenCodeRuntimeInstallerService().getReadinessStatus()).resolves.toMatchObject(
      {
        installed: true,
        binaryPath,
        version: '2.9.0',
        source: 'path',
        state: 'idle',
        v2Support: 'required',
        error: expect.stringContaining('OpenCode V2 support'),
      }
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(resolveAppManagedOpenCodeRuntimeBinaryPath()).toBeNull();
    expect(await readFile(binaryPath, 'utf8')).toBe('selected native bytes');
  });

  it.each([
    ['2.0.0', true],
    ['opencode v2.0.32', true],
    ['2.0.21', true],
    ['opencode v2.0.21', true],
    ['opencode v2.0.26', true],
    ['2.1.4', true],
    ['3.0.0', false],
    ['2.0.32-beta.1', false],
    ['2.0.32+build.7', false],
  ])(
    'discovers native runtime versions recognized by the pinned range on PATH (%s)',
    async (version, supported) => {
      const binDir = path.join(tempRoot!, 'TEST-bin');
      await mkdir(binDir, { recursive: true });
      const binaryPath = path.join(binDir, getTestNativeOpenCodeBinaryName());
      await writeFile(binaryPath, 'TEST native version probe', { mode: 0o755 });
      process.env.PATH = binDir;
      execCliMock.mockResolvedValue({ stdout: version + '\n', stderr: '' });
      expect(await resolveVerifiedOpenCodeRuntimeBinaryPath({ includeShellEnv: false })).toBe(
        supported ? binaryPath : null
      );
    }
  );

  it.skipIf(!getLatestQualifiedOpenCodeV2Version(process.platform, process.arch))(
    'preserves PATH order for a stable V2 release served by a qualified engine',
    async () => {
      // Not an exact qualified native release, but served by the pinned flexible engine policy.
      const nativeV2 = path.join(tempRoot!, 'TEST-bin-v2');
      const legacyV1 = path.join(tempRoot!, 'TEST-bin-v1');
      for (const binDir of [nativeV2, legacyV1]) {
        await mkdir(binDir, { recursive: true });
        await writeFile(
          path.join(binDir, getTestNativeOpenCodeBinaryName()),
          'TEST native version probe',
          {
            mode: 0o755,
          }
        );
      }
      execCliMock.mockImplementation(async (command: string) => ({
        stdout: command.startsWith(nativeV2) ? '2.999.0\n' : '1.18.3\n',
        stderr: '',
      }));
      process.env.PATH = [nativeV2, legacyV1].join(path.delimiter);
      expect(await resolveVerifiedOpenCodeRuntimeBinaryPath({ includeShellEnv: false })).toBe(
        path.join(nativeV2, getTestNativeOpenCodeBinaryName())
      );
      // The same stable native release remains discoverable when it is alone on PATH.
      clearOpenCodeRuntimeBinaryResolverCache();
      process.env.PATH = nativeV2;
      expect(await resolveVerifiedOpenCodeRuntimeBinaryPath({ includeShellEnv: false })).toBe(
        path.join(nativeV2, getTestNativeOpenCodeBinaryName())
      );
    }
  );

  it.each([
    ['2.0.0', true],
    ['opencode v2.0.32', true],
    ['2.0.21', true],
    ['opencode v2.0.21', true],
    ['opencode v2.0.26', true],
    ['2.1.4', true],
    ['3.0.0', false],
    ['2.0.32-beta.1', false],
    ['2.0.32+build.7', false],
  ])(
    'discovers managed native runtime versions recognized by the pinned range (%s)',
    async (version, supported) => {
      const binaryPath = path.join(tempRoot!, 'TEST-managed-opencode');
      await writeFile(binaryPath, 'TEST native version probe', { mode: 0o755 });
      const runtimeRoot = path.join(tempRoot!, 'data', 'runtimes', 'opencode');
      await mkdir(runtimeRoot, { recursive: true });
      await writeFile(
        path.join(runtimeRoot, 'current.json'),
        JSON.stringify({
          schemaVersion: 1,
          version,
          platformPackage: '@opencode/cli-linux-x64',
          binaryPath,
          integrity: 'TEST',
          installedAt: new Date().toISOString(),
        })
      );
      execCliMock.mockResolvedValue({ stdout: version + '\n', stderr: '' });
      expect(await resolveVerifiedAppManagedOpenCodeRuntimeBinaryPath()).toBe(
        supported ? binaryPath : null
      );
      expect(await createNativeOnlyInstaller().getReadinessStatus()).toMatchObject({
        installed: supported,
        source: 'app-managed',
        state: supported ? 'ready' : 'failed',
      });
    }
  );

  it.each([
    ['1.18.3', true],
    ['2.0.0', true],
    ['opencode v2.0.32', true],
    ['2.0.21', true],
    ['opencode v2.0.21', true],
    ['1.15.9', false],
    ['2.1.4', true],
    ['2.0.32-beta.1', false],
    ['2.0.32+unqualified', false],
    ['3.0.0', false],
    ['unknown', false],
  ])('preserves only recognized native binary overrides (%s)', async (version, supported) => {
    const binaryPath = path.join(tempRoot!, 'selected-opencode');
    await writeFile(binaryPath, 'TEST selected native binary', { mode: 0o755 });
    execCliMock.mockResolvedValue({ stdout: version + '\n', stderr: '' });
    const targetEnv: NodeJS.ProcessEnv = {
      CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: binaryPath,
      OPENCODE_BIN_PATH: binaryPath,
    };
    const bridgeEnv = { ...targetEnv };
    const resolveVerifiedBinary = vi.fn(async () => null);
    const onOverrideRejected = vi.fn();

    await ensureOpenCodeBridgeRuntimeBinaryEnv({
      targetEnv,
      bridgeEnv,
      resolveVerifiedOpenCodeRuntimeBinaryPath: resolveVerifiedBinary,
      isSupportedOpenCodeRuntimeBinaryPath,
      onOverrideRejected,
    });

    for (const env of [targetEnv, bridgeEnv]) {
      expect(env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(supported ? binaryPath : undefined);
      expect(env.OPENCODE_BIN_PATH).toBe(supported ? binaryPath : undefined);
    }
    expect(onOverrideRejected).toHaveBeenCalledTimes(supported ? 0 : 1);
    expect(resolveVerifiedBinary).toHaveBeenCalledTimes(supported ? 0 : 1);
    expect(execCliMock).toHaveBeenCalledTimes(1);
    expect(execCliMock).toHaveBeenCalledWith(binaryPath, ['--version'], expect.anything());
  });

  it('refuses a timed-out explicit version probe without replacing either bridge environment', async () => {
    const binaryPath = path.join(tempRoot!, 'selected-opencode');
    await writeFile(binaryPath, 'TEST selected native binary', { mode: 0o755 });
    execCliMock.mockRejectedValueOnce(new Error('Command timed out after 30000ms: TEST --version'));
    const targetEnv = { OPENCODE_BIN_PATH: binaryPath };
    const bridgeEnv = { ...targetEnv };
    const resolver = vi.fn(() => Promise.resolve('/TEST/managed-old-opencode'));
    const onOverrideRejected = vi.fn();

    await expect(
      ensureOpenCodeBridgeRuntimeBinaryEnv({
        targetEnv,
        bridgeEnv,
        resolveVerifiedOpenCodeRuntimeBinaryPath: resolver,
        isSupportedOpenCodeRuntimeBinaryPath,
        onOverrideRejected,
      })
    ).rejects.toThrow('Could not verify the explicitly selected OpenCode binary');

    expect(targetEnv).toEqual({
      OPENCODE_BIN_PATH: binaryPath,
      CLAUDE_MULTIMODEL_OPENCODE_V2_SUPPORT_ROOT: path.join(
        tempRoot!,
        'data',
        'runtimes',
        'opencode-v2'
      ),
    });
    expect(bridgeEnv).toEqual(targetEnv);
    expect(resolver).not.toHaveBeenCalled();
    expect(onOverrideRejected).not.toHaveBeenCalled();
  });

  describe('status with a binary override', () => {
    let originalOverride: string | undefined;
    let originalLegacyOverride: string | undefined;
    let managedBinaryPath: string;
    let overridePath: string;

    beforeEach(async () => {
      originalOverride = process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH;
      originalLegacyOverride = process.env.OPENCODE_BIN_PATH;
      delete process.env.OPENCODE_BIN_PATH;
      managedBinaryPath = path.join(tempRoot!, 'TEST-managed-opencode');
      overridePath = path.join(tempRoot!, 'TEST-override-opencode');
      await writeFile(managedBinaryPath, 'TEST managed binary', { mode: 0o755 });
      await writeFile(overridePath, 'TEST override binary', { mode: 0o755 });
      const runtimeRoot = path.join(tempRoot!, 'data', 'runtimes', 'opencode');
      await mkdir(runtimeRoot, { recursive: true });
      await writeFile(
        path.join(runtimeRoot, 'current.json'),
        JSON.stringify({
          schemaVersion: 1,
          version: '1.18.3',
          platformPackage: 'opencode-test',
          binaryPath: managedBinaryPath,
          integrity: 'sha512-test',
          installedAt: new Date().toISOString(),
        })
      );
      process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = overridePath;
    });

    afterEach(() => {
      restoreEnvValue('CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH', originalOverride);
      restoreEnvValue('OPENCODE_BIN_PATH', originalLegacyOverride);
    });

    function mockOverrideVersion(overrideVersion: string): void {
      execCliMock.mockImplementation(async (binaryPath: string) => ({
        stdout: `${binaryPath === overridePath ? overrideVersion : '1.18.3'}\n`,
        stderr: '',
      }));
    }

    it('reports a recognized override as the selected binary with its real version', async () => {
      mockOverrideVersion('opencode v2.0.32');

      const status = await createNativeOnlyInstaller().getStatus();

      expect(status).toMatchObject({
        installed: true,
        binaryPath: overridePath,
        version: '2.0.32',
        source: 'override',
        state: 'ready',
      });
      expect(status.ignoredOverride).toBeUndefined();
      // Managed update metadata cannot change what an override launches.
      expect(status.updateAvailable).toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
    });

    it('names the platform binary behind an npm wrapper override', async () => {
      const platformName = process.platform === 'win32' ? 'windows' : process.platform;
      const scope = path.join(tempRoot!, 'npm', 'node_modules', '@opencode');
      const platformRoot = path.join(scope, `cli-${platformName}-${process.arch}`);
      const platformBinary = path.join(
        platformRoot,
        'bin',
        process.platform === 'win32' ? 'opencode.exe' : 'opencode'
      );
      const wrapperBinary = path.join(scope, 'cli', 'bin', 'opencode.exe');
      await mkdir(path.dirname(platformBinary), { recursive: true });
      await mkdir(path.dirname(wrapperBinary), { recursive: true });
      await writeFile(
        path.join(scope, 'cli', 'package.json'),
        JSON.stringify({ name: '@opencode/cli', version: '2.0.32' })
      );
      await writeFile(
        path.join(platformRoot, 'package.json'),
        JSON.stringify({ name: `@opencode/cli-${platformName}-${process.arch}`, version: '2.0.32' })
      );
      await writeFile(platformBinary, 'TEST platform binary', { mode: 0o755 });
      await link(platformBinary, wrapperBinary);
      process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = wrapperBinary;
      execCliMock.mockResolvedValue({ stdout: 'opencode v2.0.32\n', stderr: '' });

      await expect(createNativeOnlyInstaller().getReadinessStatus()).resolves.toMatchObject({
        installed: true,
        binaryPath: await realpath(platformBinary),
        version: '2.0.32',
        source: 'override',
      });
    });

    it('names an unsupported override and its version next to the fallback binary', async () => {
      mockOverrideVersion('opencode v3.0.0');

      const status = await createNativeOnlyInstaller().getReadinessStatus();

      expect(status).toMatchObject({
        installed: true,
        binaryPath: managedBinaryPath,
        version: '1.18.3',
        source: 'app-managed',
        state: 'ready',
        ignoredOverride: {
          binaryPath: overridePath,
          envName: 'CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH',
          version: '3.0.0',
        },
      });
      expect(status.ignoredOverride?.reason).toContain('unsupported native generation');
      expect(status.ignoredOverride?.reason).toContain('Using the default OpenCode instead.');
    });

    it('names a legacy override that does not point to a file', async () => {
      const missingPath = path.join(tempRoot!, 'TEST-missing-opencode');
      delete process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH;
      process.env.OPENCODE_BIN_PATH = missingPath;
      mockOverrideVersion('opencode v2.0.32');

      await expect(createNativeOnlyInstaller().getReadinessStatus()).resolves.toMatchObject({
        source: 'app-managed',
        version: '1.18.3',
        ignoredOverride: {
          binaryPath: missingPath,
          envName: 'OPENCODE_BIN_PATH',
          version: null,
          reason: expect.stringContaining('does not name an existing file'),
        },
      });
    });

    it('selects the legacy override like the bridge when the preferred one names no file', async () => {
      const legacyPath = path.join(tempRoot!, 'TEST-legacy-opencode');
      await writeFile(legacyPath, 'TEST legacy binary', { mode: 0o755 });
      process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = path.join(tempRoot!, 'TEST-removed');
      process.env.OPENCODE_BIN_PATH = legacyPath;
      execCliMock.mockImplementation(async (binaryPath: string) => ({
        stdout: `${binaryPath === legacyPath ? 'opencode v2.0.32' : '1.18.3'}\n`,
        stderr: '',
      }));

      await expect(createNativeOnlyInstaller().getReadinessStatus()).resolves.toMatchObject({
        installed: true,
        binaryPath: legacyPath,
        version: '2.0.32',
        source: 'override',
      });
    });

    it('keeps the override status when a managed install fails', async () => {
      mockOverrideVersion('opencode v2.0.32');
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('unavailable', { status: 503 }))
      );

      const status = await createNativeOnlyInstaller().install({ generation: 'v1' });

      expect(status).toMatchObject({
        binaryPath: overridePath,
        version: '2.0.32',
        source: 'override',
        state: 'failed',
      });
      expect(consoleError).toHaveBeenCalledWith(
        '[OpenCodeRuntimeInstallerService]',
        'Failed to install OpenCode runtime:',
        expect.stringContaining('HTTP 503')
      );
    });

    it('fails closed like launch when the override version cannot be read', async () => {
      execCliMock.mockImplementation(async (binaryPath: string) => {
        if (binaryPath === overridePath) throw new Error('Command timed out after 30000ms');
        return { stdout: '1.18.3\n', stderr: '' };
      });

      const status = await createNativeOnlyInstaller().getReadinessStatus();

      expect(status).toMatchObject({
        installed: false,
        binaryPath: overridePath,
        source: 'override',
        state: 'failed',
        error: expect.stringContaining('Could not verify the explicitly selected OpenCode binary'),
      });
      expect(status.ignoredOverride).toBeUndefined();
    });
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
    expect(execCliMock).toHaveBeenCalledWith(
      binaryPath,
      ['--version'],
      expect.objectContaining({
        timeout: process.platform === 'darwin' ? 60_000 : 30_000,
        windowsHide: true,
      })
    );

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
    execCliMock.mockResolvedValue({ stdout: '1.15.6\n', stderr: '' });

    await expect(resolveVerifiedAppManagedOpenCodeRuntimeBinaryPath()).resolves.toBeNull();
    await expect(createNativeOnlyInstaller().getStatus()).resolves.toMatchObject({
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

    versionProbe.resolve({ stdout: '1.18.3\n', stderr: '' });
    await expect(Promise.all([first, second])).resolves.toEqual([binaryPath, binaryPath]);

    await expect(resolveVerifiedAppManagedOpenCodeRuntimeBinaryPath()).resolves.toBe(binaryPath);
    expect(execCliMock).toHaveBeenCalledTimes(1);
  });

  it('returns a verified OpenCode binary from best-effort shell PATH when app-managed runtime is absent', async () => {
    const binaryPath = path.join(tempRoot!, 'homebrew', 'bin', getTestNativeOpenCodeBinaryName());
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, 'binary', { mode: 0o755 });
    resolveInteractiveShellEnvBestEffortMock.mockResolvedValue({
      PATH: path.dirname(binaryPath),
    });

    await expect(resolveVerifiedOpenCodeRuntimeBinaryPath({ shellEnvTimeoutMs: 0 })).resolves.toBe(
      binaryPath
    );
    expect(resolveCachedVerifiedOpenCodeRuntimeBinaryPath()).toBe(binaryPath);
    expect(resolveInteractiveShellEnvBestEffortMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 0,
        fallbackEnv: process.env,
      })
    );
    expect(execCliMock).toHaveBeenCalledWith(
      binaryPath,
      ['--version'],
      expect.objectContaining({
        timeout: process.platform === 'darwin' ? 60_000 : 30_000,
        windowsHide: true,
      })
    );
  });

  it('coalesces concurrent verified OpenCode PATH probes and reuses the warm result', async () => {
    const binaryPath = path.join(tempRoot!, 'homebrew', 'bin', getTestNativeOpenCodeBinaryName());
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

    versionProbe.resolve({ stdout: '1.18.3\n', stderr: '' });
    await expect(Promise.all([first, second])).resolves.toEqual([binaryPath, binaryPath]);

    await expect(resolveVerifiedOpenCodeRuntimeBinaryPath({ shellEnvTimeoutMs: 0 })).resolves.toBe(
      binaryPath
    );
    expect(execCliMock).toHaveBeenCalledTimes(1);
    expect(resolveInteractiveShellEnvBestEffortMock).toHaveBeenCalledTimes(1);
  });

  it('does not warm verified OpenCode PATH caches from a stale in-flight probe', async () => {
    const binaryPath = path.join(tempRoot!, 'homebrew', 'bin', getTestNativeOpenCodeBinaryName());
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
    versionProbe.resolve({ stdout: '1.18.3\n', stderr: '' });
    await expect(staleResolve).resolves.toBe(binaryPath);

    await expect(resolveVerifiedOpenCodeRuntimeBinaryPath({ shellEnvTimeoutMs: 0 })).resolves.toBe(
      binaryPath
    );
    expect(execCliMock).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent OpenCode runtime status checks and serves a short warm cache', async () => {
    const binaryPath = path.join(tempRoot!, 'homebrew', 'bin', getTestNativeOpenCodeBinaryName());
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, 'binary', { mode: 0o755 });
    resolveInteractiveShellEnvBestEffortMock.mockResolvedValue({
      PATH: path.dirname(binaryPath),
    });
    getShellPreferredHomeMock.mockReturnValue(tempRoot!);
    const versionProbe = deferred<{ stdout: string; stderr: string }>();
    execCliMock.mockReturnValue(versionProbe.promise);
    const service = createNativeOnlyInstaller();

    const first = service.getStatus();
    const second = service.getStatus();
    await vi.waitFor(() => expect(execCliMock).toHaveBeenCalledTimes(1));

    versionProbe.resolve({ stdout: '1.18.3\n', stderr: '' });
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
    expect(globalThis.fetch as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
  });

  it('compares the installed OpenCode version with the registry latest version', async () => {
    const binaryPath = path.join(tempRoot!, 'homebrew', 'bin', getTestNativeOpenCodeBinaryName());
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, 'binary', { mode: 0o755 });
    resolveInteractiveShellEnvBestEffortMock.mockResolvedValue({ PATH: path.dirname(binaryPath) });
    getShellPreferredHomeMock.mockReturnValue(tempRoot!);
    execCliMock.mockResolvedValue({ stdout: '1.17.18\n', stderr: '' });
    const service = createNativeOnlyInstaller();

    await expect(service.getStatus()).resolves.toMatchObject({
      version: '1.17.18',
      latestVersion: '1.18.3',
      updateAvailable: true,
    });
  });

  it('keeps a known update available when a later registry refresh fails', async () => {
    const binaryPath = path.join(tempRoot!, 'homebrew', 'bin', getTestNativeOpenCodeBinaryName());
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, 'binary', { mode: 0o755 });
    resolveInteractiveShellEnvBestEffortMock.mockResolvedValue({ PATH: path.dirname(binaryPath) });
    getShellPreferredHomeMock.mockReturnValue(tempRoot!);
    execCliMock.mockResolvedValue({ stdout: '1.17.18\n', stderr: '' });
    const service = createNativeOnlyInstaller();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(service.getStatus()).resolves.toMatchObject({
        latestVersion: '1.18.3',
        updateAvailable: true,
      });
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('registry unavailable')));
      now.mockReturnValue(1_031_000);

      await expect(service.getStatus()).resolves.toMatchObject({
        latestVersion: '1.18.3',
        updateAvailable: true,
      });
      expect(consoleWarn).toHaveBeenCalledWith(
        '[OpenCodeRuntimeInstallerService]',
        'Failed to resolve latest OpenCode version:',
        'registry unavailable'
      );
    } finally {
      now.mockRestore();
      consoleWarn.mockRestore();
    }
  });

  it('reads the installed version for readiness without fetching update metadata', async () => {
    const binaryPath = path.join(tempRoot!, 'homebrew', 'bin', getTestNativeOpenCodeBinaryName());
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, 'binary', { mode: 0o755 });
    resolveInteractiveShellEnvBestEffortMock.mockResolvedValue({ PATH: path.dirname(binaryPath) });
    getShellPreferredHomeMock.mockReturnValue(tempRoot!);

    await expect(createNativeOnlyInstaller().getReadinessStatus()).resolves.toMatchObject({
      installed: true,
      binaryPath,
      version: '1.18.3',
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('does not remember OpenCode runtime status from a stale in-flight check', async () => {
    const binaryPath = path.join(tempRoot!, 'homebrew', 'bin', getTestNativeOpenCodeBinaryName());
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, 'binary', { mode: 0o755 });
    resolveInteractiveShellEnvBestEffortMock.mockResolvedValue({
      PATH: path.dirname(binaryPath),
    });
    getShellPreferredHomeMock.mockReturnValue(tempRoot!);
    const versionProbe = deferred<{ stdout: string; stderr: string }>();
    execCliMock.mockReturnValueOnce(versionProbe.promise).mockResolvedValue({
      stdout: '1.18.34\n',
      stderr: '',
    });
    const service = createNativeOnlyInstaller();

    const staleStatus = service.getStatus();
    await vi.waitFor(() => expect(execCliMock).toHaveBeenCalledTimes(1));

    service.invalidateStatusCache();
    versionProbe.resolve({ stdout: '1.18.3\n', stderr: '' });
    await expect(staleStatus).resolves.toMatchObject({
      installed: true,
      source: 'path',
      binaryPath,
      version: '1.18.3',
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      installed: true,
      source: 'path',
      binaryPath,
      version: '1.18.34',
    });
    expect(execCliMock).toHaveBeenCalledTimes(2);
  });

  it('returns a verified OpenCode binary from the merged CLI PATH after zero-wait shell fallback', async () => {
    const binaryPath = path.join(
      tempRoot!,
      'merged-cli-path',
      'bin',
      getTestNativeOpenCodeBinaryName()
    );
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
    expect(execCliMock).toHaveBeenCalledWith(
      binaryPath,
      ['--version'],
      expect.objectContaining({
        timeout: process.platform === 'darwin' ? 60_000 : 30_000,
        windowsHide: true,
      })
    );
  });

  it('resolves from fast fallback PATH without spawning shell env when shell env is disabled', async () => {
    const binaryPath = path.join(
      tempRoot!,
      'merged-cli-path',
      'bin',
      getTestNativeOpenCodeBinaryName()
    );
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, 'binary', { mode: 0o755 });
    buildMergedCliPathMock.mockReturnValue(path.dirname(binaryPath));

    await expect(
      resolveVerifiedOpenCodeRuntimeBinaryPath({ includeShellEnv: false })
    ).resolves.toBe(binaryPath);
    expect(resolveInteractiveShellEnvBestEffortMock).not.toHaveBeenCalled();
    expect(execCliMock).toHaveBeenCalledWith(
      binaryPath,
      ['--version'],
      expect.objectContaining({
        timeout: process.platform === 'darwin' ? 60_000 : 30_000,
        windowsHide: true,
      })
    );
  });

  it('does not spawn shell env for shell-only PATH installs when shell env is disabled', async () => {
    const binaryPath = path.join(
      tempRoot!,
      'custom-npm-prefix',
      'bin',
      getTestNativeOpenCodeBinaryName()
    );
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
    expect(execCliMock).toHaveBeenCalledWith(
      binaryPath,
      ['--version'],
      expect.objectContaining({
        timeout: process.platform === 'darwin' ? 60_000 : 30_000,
        windowsHide: true,
      })
    );
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
      expect(execCliMock).toHaveBeenCalledWith(
        binaryPath,
        ['--version'],
        expect.objectContaining({
          timeout: 30_000,
          windowsHide: true,
        })
      );
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
      expect(execCliMock).toHaveBeenCalledWith(
        activeNativePath,
        ['--version'],
        expect.objectContaining({
          timeout: 30_000,
          windowsHide: true,
        })
      );
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

  it.each([
    { scenario: 'nested platform package', hoisted: false },
    { scenario: 'hoisted platform package', hoisted: true },
  ])(
    'discovers the @opencode/cli platform binary behind Windows npm shims ($scenario)',
    async ({ hoisted }) => {
      await withWindowsPlatform(async () => {
        const install = await createOpenCodeV2NpmInstall(
          path.join(tempRoot!, `npm-v2-${hoisted ? 'hoisted' : 'nested'}`),
          { hoisted }
        );
        process.env.PATH = path.dirname(install.cmdShim);
        mockOpenCodeVersions({ [install.platformBinary]: 'opencode v2.2.0\n' });

        await expect(
          resolveVerifiedOpenCodeRuntimeBinaryPath({ includeShellEnv: false })
        ).resolves.toBe(install.platformBinary);
        expect(execCliMock).toHaveBeenCalledWith(
          install.platformBinary,
          ['--version'],
          expect.objectContaining({
            timeout: 30_000,
            windowsHide: true,
          })
        );
        expectNotProbed(install.wrapperBinary, install.cmdShim, install.shellShim);
      });
    }
  );

  it.each([
    { shimTarget: 'v2' as const, expected: 'platform' as const, label: '@opencode/cli' },
    { shimTarget: 'legacy' as const, expected: 'legacy' as const, label: 'opencode-ai' },
  ])(
    'prefers the install the npm shim targets when both packages coexist (shim -> $label)',
    async ({ shimTarget, expected }) => {
      await withWindowsPlatform(async () => {
        const install = await createOpenCodeCoexistingNpmInstall(
          path.join(tempRoot!, `npm-coexist-${shimTarget}`),
          shimTarget
        );
        const expectedBinary =
          expected === 'platform' ? install.platformBinary : install.legacyBinary;
        const otherBinary = expected === 'platform' ? install.legacyBinary : install.platformBinary;
        const expectedVersion = expected === 'platform' ? '2.2.0' : '1.18.3';
        process.env.PATH = path.dirname(install.cmdShim);
        mockOpenCodeVersions({
          [install.platformBinary]: 'opencode v2.2.0\n',
          [install.legacyBinary]: '1.18.3\n',
        });

        expect(collectWindowsNativeOpenCodeBinaryCandidates(install.cmdShim)).toEqual([
          expectedBinary,
          otherBinary,
        ]);
        expect(collectWindowsNativeOpenCodeBinaryCandidates(install.shellShim)).toEqual([
          expectedBinary,
          otherBinary,
        ]);

        await expect(
          resolveVerifiedOpenCodeRuntimeBinaryPath({ includeShellEnv: false })
        ).resolves.toBe(expectedBinary);
        await expect(createNativeOnlyInstaller().getReadinessStatus()).resolves.toMatchObject({
          installed: true,
          source: 'path',
          state: 'ready',
          version: expectedVersion,
          binaryPath: expectedBinary,
        });
        expect(execCliMock.mock.calls[0]?.[0]).toBe(expectedBinary);
        expectNotProbed(otherBinary, install.cmdShim, install.shellShim);
      });
    }
  );

  it.each([
    {
      scenario: 'the shim target install is missing',
      removeShimTarget: true,
      expectedProbes: (install: CoexistingOpenCodeNpmInstall) => [install.legacyBinary],
    },
    {
      scenario: 'the shim target fails version validation',
      removeShimTarget: false,
      expectedProbes: (install: CoexistingOpenCodeNpmInstall) => [
        install.platformBinary,
        install.legacyBinary,
      ],
    },
  ])('falls back to the other installed npm package when $scenario', async (testCase) => {
    await withWindowsPlatform(async () => {
      const install = await createOpenCodeCoexistingNpmInstall(
        path.join(
          tempRoot!,
          `npm-coexist-${testCase.removeShimTarget ? 'missing' : 'broken'}-target`
        ),
        'v2'
      );
      if (testCase.removeShimTarget) {
        // The shims still name @opencode/cli, but that install is incomplete/removed.
        await rm(path.join(path.dirname(install.cmdShim), 'node_modules', '@opencode'), {
          recursive: true,
          force: true,
        });
      }
      process.env.PATH = path.dirname(install.cmdShim);
      execCliMock.mockImplementation(async (binaryPath: string) => {
        if (binaryPath === install.platformBinary) {
          throw new Error('unusable shim target');
        }
        return { stdout: '1.18.3\n', stderr: '' };
      });

      await expect(
        resolveVerifiedOpenCodeRuntimeBinaryPath({ includeShellEnv: false })
      ).resolves.toBe(install.legacyBinary);
      // A present shim target is verified first; only a failed probe falls through.
      expect(execCliMock.mock.calls.map(([binaryPath]) => binaryPath)).toEqual(
        testCase.expectedProbes(install)
      );
      expectNotProbed(install.cmdShim, install.shellShim);
    });
  });

  it.each([
    {
      scenario: 'the @opencode/cli install has no native delivery',
      prepare: async (prefix: string) => {
        const wrapperRoot = path.join(prefix, 'node_modules', '@opencode', 'cli');
        await writeOpenCodeNpmPackage(wrapperRoot, { name: '@opencode/cli', version: '2.2.0' });
        await mkdir(path.join(wrapperRoot, 'bin'), { recursive: true });
        await writeFile(path.join(wrapperRoot, 'bin', 'opencode.exe'), 'TEST wrapper copy only');
        await writeOpenCodeNpmShims(prefix, '@opencode/cli');
      },
    },
    {
      scenario: 'no npm package is installed',
      prepare: async (prefix: string) => {
        await mkdir(prefix, { recursive: true });
        await writeOpenCodeNpmShims(prefix, '@opencode/cli');
      },
    },
  ])(
    'never probes POSIX npm shell shims and reports a missing runtime when $scenario',
    async ({ prepare }) => {
      await withWindowsPlatform(async () => {
        const prefix = path.join(tempRoot!, 'npm-no-native');
        await prepare(prefix);
        process.env.PATH = prefix;

        await expect(
          resolveVerifiedOpenCodeRuntimeBinaryPath({ includeShellEnv: false })
        ).resolves.toBeNull();
        await expect(createNativeOnlyInstaller().getReadinessStatus()).resolves.toMatchObject({
          installed: false,
          source: 'missing',
          state: 'idle',
        });
        expect(execCliMock).not.toHaveBeenCalled();
      });
    }
  );

  it('still resolves the legacy opencode-ai npm layout on Windows PATH', async () => {
    await withWindowsPlatform(async () => {
      const prefix = path.join(tempRoot!, 'npm-legacy');
      const platformBinary = path.join(
        prefix,
        'node_modules',
        'opencode-ai',
        'node_modules',
        `opencode-windows-${process.arch}`,
        'bin',
        'opencode.exe'
      );
      await mkdir(path.dirname(platformBinary), { recursive: true });
      await writeFile(platformBinary, 'TEST legacy native binary');
      await writeOpenCodeNpmShims(prefix, 'opencode-ai');
      process.env.PATH = prefix;
      mockOpenCodeVersions({ [platformBinary]: '1.18.3\n' });

      await expect(
        resolveVerifiedOpenCodeRuntimeBinaryPath({ includeShellEnv: false })
      ).resolves.toBe(platformBinary);
    });
  });

  it('keeps version validation for the discovered @opencode/cli platform binary', async () => {
    await withWindowsPlatform(async () => {
      const install = await createOpenCodeV2NpmInstall(path.join(tempRoot!, 'npm-v2-broken'));
      process.env.PATH = path.dirname(install.cmdShim);
      execCliMock.mockRejectedValue(new Error('spawn EINVAL'));

      await expect(createNativeOnlyInstaller().getReadinessStatus()).resolves.toMatchObject({
        installed: false,
        source: 'path',
        state: 'failed',
        binaryPath: install.platformBinary,
      });
      expect(execCliMock).toHaveBeenCalledWith(
        install.platformBinary,
        ['--version'],
        expect.objectContaining({
          timeout: 30_000,
          windowsHide: true,
        })
      );
    });
  });

  it('keeps a deterministic legacy-first order for an unrecognized npm shim', async () => {
    await withWindowsPlatform(async () => {
      const install = await createOpenCodeCoexistingNpmInstall(
        path.join(tempRoot!, 'npm-coexist-unknown-shim'),
        'v2'
      );
      const prefix = path.dirname(install.cmdShim);
      await writeFile(
        path.join(prefix, 'opencode'),
        '#!/bin/sh\nexec /opt/custom/opencode "$@"\n',
        { mode: 0o755 }
      );
      await writeFile(
        path.join(prefix, 'opencode.cmd'),
        '@ECHO off\r\n"C:\\custom\\opencode.exe" %*\r\n'
      );
      process.env.PATH = prefix;
      mockOpenCodeVersions({
        [install.platformBinary]: 'opencode v2.2.0\n',
        [install.legacyBinary]: '1.18.3\n',
      });

      expect(collectWindowsNativeOpenCodeBinaryCandidates(install.cmdShim)).toEqual([
        install.legacyBinary,
        install.platformBinary,
      ]);
      await expect(
        resolveVerifiedOpenCodeRuntimeBinaryPath({ includeShellEnv: false })
      ).resolves.toBe(install.legacyBinary);
      expectNotProbed(install.shellShim);
    });
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
      return { stdout: '1.18.3\n', stderr: '' };
    });

    await expect(resolveVerifiedOpenCodeRuntimeBinaryPath({ shellEnvTimeoutMs: 0 })).resolves.toBe(
      workingBinaryPath
    );
    await expect(createNativeOnlyInstaller().getStatus()).resolves.toMatchObject({
      installed: true,
      source: 'path',
      state: 'ready',
      binaryPath: workingBinaryPath,
      version: '1.18.3',
    });
  });

  it('falls through to shell PATH when all fast nvm candidates are broken', async () => {
    const brokenBinaryPath = getTestNvmOpenCodeBinaryPath('v23.0.0');
    const shellBinaryPath = path.join(
      tempRoot!,
      'custom-npm-prefix',
      'bin',
      getTestNativeOpenCodeBinaryName()
    );
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
      return { stdout: '1.18.3\n', stderr: '' };
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
    const binaryPath = path.join(tempRoot!, 'homebrew', 'bin', getTestNativeOpenCodeBinaryName());
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, 'binary', { mode: 0o755 });
    resolveInteractiveShellEnvBestEffortMock.mockResolvedValue({
      PATH: path.dirname(binaryPath),
    });

    await expect(createNativeOnlyInstaller().getStatus()).resolves.toMatchObject({
      installed: true,
      source: 'path',
      state: 'ready',
      binaryPath,
      version: '1.18.3',
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
    const pathBinaryPath = path.join(
      tempRoot!,
      'homebrew',
      'bin',
      getTestNativeOpenCodeBinaryName()
    );
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
      return { stdout: '1.18.3\n', stderr: '' };
    });

    await expect(createNativeOnlyInstaller().getStatus()).resolves.toMatchObject({
      installed: true,
      source: 'path',
      state: 'ready',
      binaryPath: pathBinaryPath,
      version: '1.18.3',
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
    const service = createNativeOnlyInstaller();

    await expect(service.install({ generation: 'v1' })).resolves.toMatchObject({
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
    const service = createNativeOnlyInstaller();
    await expect(service.getStatus()).resolves.toMatchObject({
      installed: true,
      source: 'app-managed',
      binaryPath,
    });

    await rm(binaryPath, { force: true });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('registry unavailable')));

    await expect(service.install({ generation: 'v1' })).resolves.toMatchObject({
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
      '1.18.3',
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
        version: '1.18.3',
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
            version: '1.18.3',
            dist: { tarball: 'https://example.test/root.tgz', integrity },
            optionalDependencies: { [platformPackage]: '1.18.3' },
          });
        }
        if (url.includes(`/${platformPackage}/1.18.3`)) {
          return Response.json({
            version: '1.18.3',
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

    await expect(createNativeOnlyInstaller().install({ generation: 'v1' })).resolves.toMatchObject({
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

  it('installs a Darwin binary whose version verification completes after 45 seconds', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const verificationStarted = deferred<void>();
    let verificationSettled = false;
    let fakeTimersActive = false;
    let installation: ReturnType<OpenCodeRuntimeInstallerService['install']> | undefined;
    try {
      const platformPackage = getOpenCodeRuntimePlatformCandidates()[0]!.packageName;
      const tarball = createTarball([{ name: 'package/bin/opencode', data: 'TEST runtime' }]);
      const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request) => {
          const url = String(input);
          if (url.endsWith('/opencode-ai/latest'))
            return Response.json({
              version: '1.18.3',
              dist: { tarball: 'https://example.test/root.tgz', integrity },
              optionalDependencies: { [platformPackage]: '1.18.3' },
            });
          if (url.includes(`/${platformPackage}/1.18.3`))
            return Response.json({
              version: '1.18.3',
              dist: { tarball: 'https://example.test/platform.tgz', integrity },
            });
          if (url === 'https://example.test/platform.tgz')
            return new Response(new Uint8Array(tarball));
          throw new Error(`Unexpected fetch: ${url}`);
        })
      );
      execCliMock.mockImplementation(
        (binaryPath: string, _args: string[], options: { timeout: number }) => {
          if (!binaryPath.includes('installing-'))
            return Promise.resolve({ stdout: '1.18.3\n', stderr: '' });
          vi.useFakeTimers();
          fakeTimersActive = true;
          verificationStarted.resolve(undefined);
          return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
            const completion = setTimeout(() => {
              verificationSettled = true;
              clearTimeout(timeout);
              resolve({ stdout: '1.18.3\n', stderr: '' });
            }, 45_000);
            const timeout = setTimeout(() => {
              verificationSettled = true;
              clearTimeout(completion);
              reject(new Error(`Command timed out after ${options.timeout}ms: TEST --version`));
            }, options.timeout);
          });
        }
      );
      installation = createNativeOnlyInstaller().install({ generation: 'v1' });
      await Promise.race([
        verificationStarted.promise,
        installation.then(() => {
          throw new Error('Install ended before version verification');
        }),
      ]);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(verificationSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(verificationSettled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
      fakeTimersActive = false;
      await expect(installation).resolves.toMatchObject({
        installed: true,
        state: 'ready',
        version: '1.18.3',
      });
      expect(execCliMock).toHaveBeenCalledWith(
        expect.stringContaining('installing-'),
        ['--version'],
        expect.objectContaining({ timeout: 60_000 })
      );
    } finally {
      if (fakeTimersActive) {
        await vi.advanceTimersByTimeAsync(60_000);
        vi.useRealTimers();
      }
      await installation;
      Object.defineProperty(process, 'platform', originalPlatform);
    }
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
      if (url.endsWith('/opencode-ai/1.19.5')) {
        return Response.json({
          name: 'opencode-ai',
          version: '1.19.5',
          dist: { tarball: 'https://example.test/root.tgz', integrity },
          optionalDependencies: { [platformPackage]: '1.19.5' },
        });
      }
      if (url.includes(`/${platformPackage}/1.19.5`)) {
        return Response.json({
          version: '1.19.5',
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

    // A first-time dashboard install supplies no generation and must still fetch V1.
    await expect(createNativeOnlyInstaller().install()).resolves.toMatchObject({
      installed: false,
      state: 'failed',
      error: 'binary verification failed',
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/opencode-ai/1.19.5'))).toBe(
      true
    );
    const runtimeRoot = path.join(tempRoot!, 'data', 'runtimes', 'opencode');
    const entries = await readdir(runtimeRoot);
    expect(entries.filter((entry) => entry.startsWith('installing-'))).toEqual([]);
    expect(consoleError).toHaveBeenCalledWith(
      '[OpenCodeRuntimeInstallerService]',
      'Failed to install OpenCode runtime:',
      'binary verification failed'
    );
  });

  it('filters cached verified generation and never marks the app console wrapper as native V2', async () => {
    const native = path.join(tempRoot!, 'user-selected.exe');
    const wrapper = path.join(tempRoot!, 'runtime', 'opencode-console', 'opencode.exe');
    await mkdir(path.dirname(wrapper), { recursive: true });
    await writeFile(native, 'TEST native');
    await writeFile(wrapper, 'TEST wrapper');
    execCliMock.mockResolvedValue({ stdout: 'opencode v2.37.105', stderr: '' });
    await expect(isSupportedOpenCodeRuntimeBinaryPath(native, 'v2')).resolves.toBe(true);
    await expect(isSupportedOpenCodeRuntimeBinaryPath(native, 'v1')).resolves.toBe(false);
    expect(execCliMock).toHaveBeenCalledTimes(1);
    await expect(isSupportedOpenCodeRuntimeBinaryPath(wrapper, 'v2')).resolves.toBe(false);
    await expect(isSupportedOpenCodeRuntimeBinaryPath(wrapper)).resolves.toBe(true);
  });

  it('coalesces identical install requests but rejects a racing generation choice before effects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const download = deferred<Response>();
    const fetchMock = vi.fn(() => download.promise);
    vi.stubGlobal('fetch', fetchMock);
    const service = createNativeOnlyInstaller();
    const first = service.install({ generation: 'v1' });
    const same = service.install({ generation: 'v1' });
    await expect(service.install({ generation: 'v2' })).rejects.toThrow(
      'different OpenCode generation'
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    download.resolve(new Response('TEST unavailable', { status: 503 }));
    const result = await first;
    expect(await same).toBe(result);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(service.install({ generation: 'v2' })).resolves.toMatchObject({ state: 'failed' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  async function mockV2Download(
    overrides: { metadataVersion?: string; binaryVersion?: string; integrity?: string } = {}
  ): Promise<{ packageName: string; version: string }> {
    const version = getLatestQualifiedOpenCodeV2Version(process.platform, process.arch)!;
    const packageName = getOpenCodeRuntimePlatformCandidates()[0]!.packageName.replace(
      /^opencode-/,
      '@opencode/cli-'
    );
    const executableName = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
    const magic =
      process.platform === 'linux'
        ? '\x7fELF'
        : process.platform === 'win32'
          ? 'MZ00'
          : Buffer.from('cffaedfe', 'hex').toString('latin1');
    const tarball = createTarball([
      {
        name: 'package/package.json',
        data: JSON.stringify({ name: packageName, version: overrides.metadataVersion ?? version }),
      },
      { name: `package/bin/${executableName}`, data: magic + 'TEST native binary' },
    ]);
    // Mach-O headers are bytes, not UTF-8 text.
    const nativeTarball =
      process.platform === 'darwin'
        ? gzipSync(
            Buffer.concat([
              createTarEntry(
                'package/package.json',
                Buffer.from(
                  JSON.stringify({
                    name: packageName,
                    version: overrides.metadataVersion ?? version,
                  })
                )
              ),
              createTarEntry(
                `package/bin/${executableName}`,
                Buffer.concat([Buffer.from('cffaedfe', 'hex'), Buffer.from('TEST native binary')])
              ),
              Buffer.alloc(1024),
            ])
          )
        : tarball;
    const integrity =
      overrides.integrity ??
      `sha512-${createHash('sha512').update(nativeTarball).digest('base64')}`;
    execCliMock.mockResolvedValue({
      stdout: `opencode v${overrides.binaryVersion ?? version}\n`,
      stderr: '',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        if (url.includes(encodeURIComponent('@opencode/cli') + '/'))
          return Response.json({
            name: '@opencode/cli',
            version,
            optionalDependencies: { [packageName]: version },
            dist: { tarball: 'https://example.test/root.tgz', integrity },
          });
        if (url.includes(encodeURIComponent(packageName) + '/'))
          return Response.json({
            name: packageName,
            version,
            dist: { tarball: 'https://example.test/native.tgz', integrity },
          });
        if (url === 'https://example.test/native.tgz')
          return new Response(new Uint8Array(nativeTarball));
        throw new Error(`Unexpected fetch: ${url}`);
      })
    );
    return { packageName, version };
  }

  it('keeps the prior native selection when fresh V2 support acquisition fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await mockV2Download();
    const support = {
      withStatus: vi.fn(async (status: import('@shared/types').OpenCodeRuntimeStatus) => status),
      install: vi.fn(async () => {
        throw new Error('TEST support acquisition failed');
      }),
    };
    const status = await new OpenCodeRuntimeInstallerService(support).install({ generation: 'v2' });
    expect(status).toMatchObject({ state: 'failed', error: 'TEST support acquisition failed' });
    expect(resolveAppManagedOpenCodeRuntimeBinaryPath()).toBeNull();
    expect(consoleError.mock.calls).toEqual([
      [
        '[OpenCodeRuntimeInstallerService]',
        'Failed to install OpenCode runtime:',
        'TEST support acquisition failed',
      ],
    ]);
  });

  it('refuses native activation when a new explicit selection appears during support acquisition', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await mockV2Download();
    const selected = path.join(tempRoot!, 'TEST-new-selection');
    await writeFile(selected, 'new explicit native selection');
    const support = {
      withStatus: vi.fn(async (status: import('@shared/types').OpenCodeRuntimeStatus) => status),
      install: vi.fn(async () => {
        vi.stubEnv('CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH', selected);
      }),
    };
    try {
      const status = await new OpenCodeRuntimeInstallerService(support).install({
        generation: 'v2',
      });
      expect(status).toMatchObject({
        installed: true,
        binaryPath: selected,
        source: 'override',
        state: 'failed',
      });
      expect(status.error).toContain('selection changed during installation');
      expect(resolveAppManagedOpenCodeRuntimeBinaryPath()).toBeNull();
      expect(consoleError.mock.calls).toEqual([
        [
          '[OpenCodeRuntimeInstallerService]',
          'Failed to install OpenCode runtime:',
          'OpenCode selection changed during installation; keeping the selected native runtime',
        ],
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('installs qualified V2 with native package identity and activates it ahead of PATH', async () => {
    const { packageName, version } = await mockV2Download();
    const pathBinary = path.join(tempRoot!, 'TEST-path', getTestNativeOpenCodeBinaryName());
    await mkdir(path.dirname(pathBinary), { recursive: true });
    await writeFile(pathBinary, 'existing user binary');
    buildMergedCliPathMock.mockReturnValue(path.dirname(pathBinary));
    const status = await createNativeOnlyInstaller().install({ generation: 'v2' });
    expect(status).toMatchObject({
      installed: true,
      state: 'ready',
      source: 'app-managed',
      version,
    });
    const binaryPath = status.binaryPath!;
    expect(path.basename(path.dirname(binaryPath))).toBe('bin');
    expect(
      JSON.parse(
        await readFile(path.join(path.dirname(path.dirname(binaryPath)), 'package.json'), 'utf8')
      )
    ).toMatchObject({ name: packageName, version });
    await expect(
      resolveVerifiedOpenCodeRuntimeBinaryPath({ includeShellEnv: false })
    ).resolves.toBe(binaryPath);
    await expect(readFile(pathBinary, 'utf8')).resolves.toBe('existing user binary');
    const refreshed = await createNativeOnlyInstaller().getStatus();
    expect(refreshed).toMatchObject({ version, latestVersion: version, updateAvailable: false });
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/opencode-ai/'))).toBe(
      false
    );
  });

  it.each([
    { metadataVersion: '2.0.999', error: 'metadata identity mismatch' },
    { binaryVersion: '2.0.999', error: 'binary version does not match' },
    { integrity: 'sha512-tampered', error: 'integrity check failed' },
  ])('does not activate a mismatched or tampered V2 download: $error', async (options) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await mockV2Download(options);
    const status = await createNativeOnlyInstaller().install({ generation: 'v2' });
    expect(status.state).toBe('failed');
    expect(status.error).toContain(options.error);
    expect(resolveAppManagedOpenCodeRuntimeBinaryPath()).toBeNull();
  });

  it('preserves explicit override selection after installing V2 and explains activation', async () => {
    const override = path.join(tempRoot!, 'TEST-override');
    await writeFile(override, 'user override');
    vi.stubEnv('CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH', override);
    const { version } = await mockV2Download();
    const status = await createNativeOnlyInstaller().install({ generation: 'v2' });
    expect(status).toMatchObject({ source: 'override', binaryPath: override, version });
    expect(status.progress?.detail).toContain('explicit OpenCode binary override');
    expect(resolveAppManagedOpenCodeRuntimeBinaryPath()).not.toBe(override);
    vi.unstubAllEnvs();
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

  it('rejects unsafe entries after the executable instead of accepting an archive prefix', () => {
    const executableName = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
    const tarball = createTarball([
      { name: `package/bin/${executableName}`, data: 'binary' },
      { name: 'package/../../escape', data: 'unsafe' },
    ]);
    expect(() => extractOpenCodeRuntimeBinaryFromTarball(tarball)).toThrow(
      'Unsafe OpenCode package tar entry'
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
