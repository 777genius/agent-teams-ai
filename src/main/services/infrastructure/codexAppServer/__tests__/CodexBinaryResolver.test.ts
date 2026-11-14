// @vitest-environment node
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CapturedCodexManagedManifest } from '@features/codex-runtime-installer/main/infrastructure/captureCodexNativeSelection';
import type { PathLike } from 'node:fs';

const accessMock = vi.fn<(filePath: PathLike, mode?: number) => Promise<void>>();
const captureManagedMock = vi.fn<() => CapturedCodexManagedManifest>();
const resolveAppManagedCodexRuntimeBinaryPathMock = vi.fn<() => string | null>();
const resolveVerifiedAppManagedCodexRuntimeBinaryPathMock = vi.fn<() => Promise<string | null>>();
const getCachedShellEnvMock = vi.fn<() => NodeJS.ProcessEnv | null>(() => null);
const buildEnrichedEnvMock = vi.fn(
  (binaryPath?: string | null): NodeJS.ProcessEnv => ({
    PATH: `enriched:${binaryPath ?? ''}`,
    CODEX_RESOLVER_TEST_BINARY: binaryPath ?? '',
  })
);
const buildMergedCliPathMock = vi.fn(
  (_binaryPath?: string | null): string => process.env.PATH ?? ''
);
const managedGitEnvMock = vi.fn((env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...env }));
const execCliMock = vi.fn<
  (
    binaryPath: string | null,
    args: string[],
    options?: {
      env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
      timeout?: number;
      windowsHide?: boolean;
    }
  ) => Promise<{ stdout: string; stderr: string }>
>();

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  access: (filePath: PathLike, mode?: number) => accessMock(filePath, mode),
}));

vi.mock('@features/codex-runtime-installer/main', async () => ({
  ...(await vi.importActual<
    typeof import('@features/codex-runtime-installer/main/infrastructure/captureCodexNativeSelection')
  >('@features/codex-runtime-installer/main/infrastructure/captureCodexNativeSelection')),
  captureAppManagedCodexRuntime: () => captureManagedMock(),
  resolveAppManagedCodexRuntimeBinaryPath: () => resolveAppManagedCodexRuntimeBinaryPathMock(),
  resolveVerifiedAppManagedCodexRuntimeBinaryPath: () =>
    resolveVerifiedAppManagedCodexRuntimeBinaryPathMock(),
}));

vi.mock('@main/utils/childProcess', () => ({
  execCli: (
    binaryPath: string | null,
    args: string[],
    options?: {
      env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
      timeout?: number;
      windowsHide?: boolean;
    }
  ) => execCliMock(binaryPath, args, options),
}));

vi.mock('@main/utils/cliEnv', () => ({
  buildEnrichedEnv: (binaryPath?: string | null) => buildEnrichedEnvMock(binaryPath),
}));

vi.mock('@main/utils/cliPathMerge', () => ({
  buildMergedCliPath: (binaryPath?: string | null) => buildMergedCliPathMock(binaryPath),
}));

vi.mock('@main/utils/managedGit', () => ({
  createManagedGitEnv: (env: NodeJS.ProcessEnv) => managedGitEnvMock(env),
}));

vi.mock('@main/utils/shellEnv', () => ({
  getCachedShellEnv: () => getCachedShellEnvMock(),
}));

const originalPlatform = process.platform;
const originalPath = process.env.PATH;
const originalPathExt = process.env.PATHEXT;
const originalCodexCliPath = process.env.CODEX_CLI_PATH;
const capturedRoots: string[] = [];

async function capturedFiles() {
  setPlatform(originalPlatform);
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'TEST-codex-selection-')));
  capturedRoots.push(root);
  const suffix = originalPlatform === 'win32' ? '.exe' : '';
  const files = {
    process: path.join(root, 'process' + suffix),
    shell: path.join(root, 'shell' + suffix),
    managed: path.join(root, 'managed' + suffix),
    codex: path.join(root, 'codex' + suffix),
  };
  for (const file of Object.values(files))
    await fs.writeFile(file, 'TEST original Codex bytes', { mode: 0o700 });
  const manifestPath = path.join(root, 'current.json');
  const manifest = {
    schemaVersion: 1,
    binaryPath: files.managed,
    rootVersion: '0.162.0',
    platformVersion: '0.162.0',
    platformTarget: 'TEST',
    integrity: 'TEST',
    installedAt: 'TEST',
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  const { captureCodexManagedManifest } =
    await import('@features/codex-runtime-installer/main/infrastructure/captureCodexNativeSelection');
  captureManagedMock.mockImplementation(() => captureCodexManagedManifest(manifestPath));
  const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  accessMock.mockImplementation(actualFs.access);
  process.env.CODEX_CLI_PATH = files.process;
  process.env.PATH = root;
  getCachedShellEnvMock.mockReturnValue({ CODEX_CLI_PATH: files.shell, PATH: root });
  buildMergedCliPathMock.mockReturnValue(root);
  execCliMock.mockResolvedValue({ stdout: 'codex-cli 0.162.0', stderr: '' });
  return { root, files, manifestPath, manifest };
}

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value,
    configurable: true,
    writable: true,
  });
}

describe('CodexBinaryResolver', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    setPlatform('win32');
    process.env.PATHEXT = '.EXE;.CMD;.BAT;.COM';
    delete process.env.CODEX_CLI_PATH;
    getCachedShellEnvMock.mockReturnValue(null);
    buildMergedCliPathMock.mockImplementation(() => process.env.PATH ?? '');
    managedGitEnvMock.mockImplementation((env) => ({ ...env }));
    resolveAppManagedCodexRuntimeBinaryPathMock.mockReturnValue(null);
    resolveVerifiedAppManagedCodexRuntimeBinaryPathMock.mockResolvedValue(null);
    execCliMock.mockResolvedValue({ stdout: 'codex-cli 0.130.0', stderr: '' });
  });

  afterEach(async () => {
    vi.useRealTimers();
    setPlatform(originalPlatform);
    process.env.PATH = originalPath;
    process.env.PATHEXT = originalPathExt;
    process.env.CODEX_CLI_PATH = originalCodexCliPath;
    for (const root of capturedRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  });

  it('prefers the Windows command shim over the extensionless POSIX shim on PATH', async () => {
    const binDir = 'C:\\Program Files\\nodejs';
    const extensionless = path.win32.join(binDir, 'codex');
    const cmdShim = path.win32.join(binDir, 'codex.cmd');
    process.env.PATH = binDir;

    accessMock.mockImplementation((filePath, mode) => {
      expect(mode).toBe(fsConstants.X_OK);
      if (filePath === extensionless || filePath === cmdShim) {
        return Promise.resolve();
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    const { CodexBinaryResolver } = await import('../CodexBinaryResolver');
    CodexBinaryResolver.clearCache();

    await expect(CodexBinaryResolver.resolve()).resolves.toBe(cmdShim);

    const f = await capturedFiles();
    const originalEnvironment = buildEnrichedEnvMock.getMockImplementation();
    if (!originalEnvironment) throw new Error('TEST original environment builder missing');
    try {
      setPlatform('win32');
      const root = path.join(f.root, 'node_modules', '@openai', 'codex');
      const platformPackage = 'codex-win32-' + process.arch;
      const optional = path.join(f.root, 'node_modules', '@openai', platformPackage);
      const native = path.join(
        optional,
        'vendor',
        (process.arch === 'x64' ? 'x86_64' : 'aarch64') + '-pc-windows-msvc',
        'bin',
        'codex.exe'
      );
      const script = path.join(root, 'bin', 'codex.js');
      const shim = path.join(f.root, 'codex.cmd');
      await fs.mkdir(path.dirname(script), { recursive: true });
      await fs.mkdir(path.dirname(native), { recursive: true });
      // Apache-2.0 official source fixture: openai/codex rust-v0.162.0,
      // codex-cli/bin/codex.js blob934600714b97f340cb5468e20e5fe560d751cbed.
      // Compressed only to keep this existing case's fixture finite; identity is not mocked.
      const wrapper = inflateRawSync(
        Buffer.from(
          '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',
          'base64'
        )
      );
      expect(createHash('sha256').update(wrapper).digest('hex')).toBe(
        '61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70'
      );
      await fs.writeFile(script, wrapper);
      await fs.writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({
          name: '@openai/codex',
          version: '0.162.0',
          type: 'module',
          bin: { codex: 'bin/codex.js' },
        })
      );
      await fs.writeFile(
        path.join(optional, 'package.json'),
        JSON.stringify({ name: '@openai/codex', version: '0.162.0-win32-' + process.arch })
      );
      await fs.writeFile(native, 'TEST native Codex image', { mode: 0o700 });
      await fs.writeFile(path.join(f.root, 'node.exe'), 'TEST original interpreter image', {
        mode: 0o700,
      });
      await fs.writeFile(
        shim,
        '@ECHO off\n"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\n'
      );
      process.env.CODEX_CLI_PATH = shim;
      buildEnrichedEnvMock.mockImplementation(() => ({ PATH: f.root }));
      execCliMock.mockClear();
      const captured = await CodexBinaryResolver.captureSelection(() => true).resolve();
      expect(captured?.selection.nativeCli.executable).toEqual({
        path: await fs.realpath(native),
        sha256: createHash('sha256').update('TEST native Codex image').digest('hex'),
      });
      expect(execCliMock).toHaveBeenCalledExactlyOnceWith(
        shim,
        ['--version'],
        expect.objectContaining({
          env: expect.objectContaining({ PATH: f.root }),
          timeout: expect.any(Number),
        })
      );
      expect(captured).not.toBeNull();
      if (!captured) throw new Error('TEST captured npm selection missing');
      await captured.assertCurrent();
      const earlierPackage = path.join(root, 'bin', 'node_modules', '@openai', platformPackage);
      await fs.mkdir(earlierPackage, { recursive: true });
      await expect(captured.assertCurrent()).rejects.toThrow('changed');
      await fs.rm(path.join(root, 'bin', 'node_modules'), { recursive: true, force: true });
      await fs.appendFile(script, '\n');
      execCliMock.mockClear();
      await expect(CodexBinaryResolver.captureSelection(() => true).resolve()).rejects.toThrow(
        'changed'
      );
      expect(execCliMock).not.toHaveBeenCalled();
      await fs.writeFile(script, wrapper);
      execCliMock.mockRejectedValueOnce(
        Object.assign(new Error('TEST interpreter exit, native close unknown'), { code: 1 })
      );
      await expect(CodexBinaryResolver.captureSelection(() => true).resolve()).rejects.toThrow(
        'native close unknown'
      );
      expect(execCliMock).toHaveBeenCalledTimes(1);
    } finally {
      buildEnrichedEnvMock.mockImplementation(originalEnvironment);
      setPlatform(originalPlatform);
    }
  });

  it('expands an explicit extensionless override to the Windows command shim first', async () => {
    const extensionless = 'C:\\Program Files\\nodejs\\codex';
    const cmdShim = 'C:\\Program Files\\nodejs\\codex.cmd';
    process.env.CODEX_CLI_PATH = extensionless;

    accessMock.mockImplementation((filePath) => {
      if (filePath === extensionless || filePath === cmdShim) {
        return Promise.resolve();
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    const { CodexBinaryResolver } = await import('../CodexBinaryResolver');
    CodexBinaryResolver.clearCache();

    await expect(CodexBinaryResolver.resolve()).resolves.toBe(cmdShim);
  });

  it('uses CODEX_CLI_PATH from cached shell env before app-managed and PATH lookup', async () => {
    setPlatform('darwin');
    delete process.env.CODEX_CLI_PATH;
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    const shellBinary = '/Users/tester/.local/bin/codex';
    const appManagedBinary = '/Users/tester/.agent-teams-ai/data/runtimes/codex/current/codex';
    getCachedShellEnvMock.mockReturnValue({
      CODEX_CLI_PATH: shellBinary,
      PATH: '/opt/homebrew/bin:/usr/bin:/bin',
    });
    resolveVerifiedAppManagedCodexRuntimeBinaryPathMock.mockResolvedValue(appManagedBinary);

    accessMock.mockImplementation((filePath) => {
      if (filePath === shellBinary || filePath === appManagedBinary) {
        return Promise.resolve();
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    const { CodexBinaryResolver } = await import('../CodexBinaryResolver');
    CodexBinaryResolver.clearCache();

    await expect(CodexBinaryResolver.resolve()).resolves.toBe(shellBinary);
    const f = await capturedFiles();
    const selected = await CodexBinaryResolver.captureSelection(() => true).resolve();
    expect(selected?.selection).toMatchObject({
      sourceKind: 'override',
      nativeCli: {
        executable: { path: f.files.process },
        version: '0.162.0',
      },
    });
    await fs.rm(f.files.process);
    expect(
      (await CodexBinaryResolver.captureSelection(() => true).resolve())?.selection.nativeCli
        .executable.path
    ).toBe(f.files.shell);
    await fs.rm(f.files.shell);
    expect(
      (await CodexBinaryResolver.captureSelection(() => true).resolve())?.selection.sourceKind
    ).toBe('app-managed');
    await fs.rm(f.files.managed);
    expect(
      (await CodexBinaryResolver.captureSelection(() => true).resolve())?.selection
    ).toMatchObject({
      sourceKind: 'path',
      nativeCli: { executable: { path: f.files.codex } },
    });
  });

  it('prefers a verified app-managed Codex binary before PATH lookup', async () => {
    const appManagedBinary = 'C:\\Users\\tester\\AppData\\Roaming\\AgentTeams\\codex.exe';
    const pathBinary = 'C:\\Program Files\\nodejs\\codex.cmd';
    process.env.PATH = 'C:\\Program Files\\nodejs';
    resolveVerifiedAppManagedCodexRuntimeBinaryPathMock.mockResolvedValue(appManagedBinary);

    accessMock.mockImplementation((filePath) => {
      if (filePath === appManagedBinary || filePath === pathBinary) {
        return Promise.resolve();
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    const { CodexBinaryResolver } = await import('../CodexBinaryResolver');
    CodexBinaryResolver.clearCache();

    await expect(CodexBinaryResolver.resolve()).resolves.toBe(appManagedBinary);
  });

  it('promotes a newly installed app-managed binary while the old PATH binary still works', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    setPlatform('darwin');
    process.env.PATH = '/usr/local/bin';
    const pathBinary = '/usr/local/bin/codex';
    const appManagedBinary = '/Users/tester/AgentTeams/runtimes/codex/bin/codex';
    accessMock.mockImplementation((filePath) =>
      filePath === pathBinary || filePath === appManagedBinary
        ? Promise.resolve()
        : Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    );

    const { CodexBinaryResolver } = await import('../CodexBinaryResolver');
    CodexBinaryResolver.clearCache();
    await expect(CodexBinaryResolver.resolve()).resolves.toBe(pathBinary);

    resolveVerifiedAppManagedCodexRuntimeBinaryPathMock.mockResolvedValue(appManagedBinary);
    resolveAppManagedCodexRuntimeBinaryPathMock.mockReturnValue(appManagedBinary);
    vi.advanceTimersByTime(30_001);
    await expect(CodexBinaryResolver.resolve()).resolves.toBe(appManagedBinary);
  });

  it('promotes an app-managed binary when stale CLI overrides cannot launch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    setPlatform('darwin');
    process.env.PATH = '/usr/local/bin';
    const pathBinary = '/usr/local/bin/codex';
    const appManagedBinary = '/Users/tester/AgentTeams/runtimes/codex/bin/codex';
    const staleOverride = '/stale/codex';
    accessMock.mockImplementation((filePath) =>
      filePath === pathBinary || filePath === appManagedBinary || filePath === staleOverride
        ? Promise.resolve()
        : Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    );
    execCliMock.mockImplementation(async (binaryPath) => {
      if (binaryPath === staleOverride) {
        throw new Error('stale runtime cannot launch');
      }
      return { stdout: 'codex-cli 0.130.0', stderr: '' };
    });

    const { CodexBinaryResolver } = await import('../CodexBinaryResolver');
    CodexBinaryResolver.clearCache();
    await expect(CodexBinaryResolver.resolve()).resolves.toBe(pathBinary);

    process.env.CODEX_CLI_PATH = staleOverride;
    getCachedShellEnvMock.mockReturnValue({ CODEX_CLI_PATH: staleOverride });
    resolveAppManagedCodexRuntimeBinaryPathMock.mockReturnValue(appManagedBinary);
    vi.advanceTimersByTime(30_001);
    await expect(CodexBinaryResolver.resolve()).resolves.toBe(appManagedBinary);
    expect(
      execCliMock.mock.calls.filter(([binaryPath]) => binaryPath === staleOverride)
    ).toHaveLength(1);
    const f = await capturedFiles();
    execCliMock.mockClear();
    execCliMock.mockImplementation(async (binary) => {
      if (binary === f.files.process)
        throw Object.assign(new Error('TEST original no-child refusal'), {
          code: 'ENOENT',
          path: binary,
          syscall: `spawn ${binary}`,
        });
      return { stdout: 'codex-cli 0.162.0', stderr: '' };
    });
    expect(
      (await CodexBinaryResolver.captureSelection(() => true).resolve())?.selection.nativeCli
        .executable.path
    ).toBe(f.files.shell);
    for (const fields of [
      { killed: true, signal: 'SIGTERM' },
      { processOutcomeUnknown: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' },
      { processTerminationError: 'TEST original cleanup unconfirmed', code: 1 },
      { code: 'ENOENT' },
    ]) {
      execCliMock.mockClear();
      execCliMock.mockRejectedValue(Object.assign(new Error('TEST held'), fields));
      await expect(CodexBinaryResolver.captureSelection(() => true).resolve()).rejects.toThrow();
      expect(execCliMock.mock.calls.map(([binary]) => binary)).toEqual([f.files.process]);
    }
    execCliMock.mockClear();
    let now = 1;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      execCliMock.mockImplementation(async () => {
        now += 15001;
        return { stdout: 'codex-cli 0.162.0', stderr: '' };
      });
      await expect(CodexBinaryResolver.captureSelection(() => true).resolve()).rejects.toThrow(
        'deadline'
      );
      expect(execCliMock.mock.calls.map(([binary]) => binary)).toEqual([f.files.process]);
    } finally {
      clock.mockRestore();
    }
    execCliMock.mockClear();
    execCliMock.mockImplementation(async () => {
      await fs.writeFile(
        f.manifestPath,
        JSON.stringify({ ...f.manifest, installedAt: 'TEST changed' })
      );
      return { stdout: 'codex-cli 0.162.0', stderr: '' };
    });
    await expect(CodexBinaryResolver.captureSelection(() => true).resolve()).rejects.toThrow(
      'changed'
    );
    expect(execCliMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a working CLI override ahead of a newly installed app-managed binary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    setPlatform('darwin');
    const overrideBinary = '/Users/tester/bin/codex';
    const appManagedBinary = '/Users/tester/AgentTeams/runtimes/codex/bin/codex';
    process.env.CODEX_CLI_PATH = overrideBinary;
    accessMock.mockImplementation((filePath) =>
      filePath === overrideBinary || filePath === appManagedBinary
        ? Promise.resolve()
        : Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    );

    const { CodexBinaryResolver } = await import('../CodexBinaryResolver');
    CodexBinaryResolver.clearCache();
    await expect(CodexBinaryResolver.resolve()).resolves.toBe(overrideBinary);

    resolveAppManagedCodexRuntimeBinaryPathMock.mockReturnValue(appManagedBinary);
    vi.advanceTimersByTime(30_001);
    await expect(CodexBinaryResolver.resolve()).resolves.toBe(overrideBinary);
    const f = await capturedFiles();
    const before = await CodexBinaryResolver.captureSelection(() => true).resolve();
    const changed = 'TEST replacement at the same Codex path';
    await fs.writeFile(f.files.process, changed);
    const after = await CodexBinaryResolver.captureSelection(() => true).resolve();
    expect(after?.selection.nativeCli.executable.path).toBe(
      before?.selection.nativeCli.executable.path
    );
    expect(after?.selection.nativeCli.executable.sha256).toBe(
      createHash('sha256').update(changed).digest('hex')
    );
    expect(after?.selection.nativeCli.executable.sha256).not.toBe(
      before?.selection.nativeCli.executable.sha256
    );
    const captured = CodexBinaryResolver.captureSelection(() => true);
    process.env.CODEX_CLI_PATH = f.files.shell;
    execCliMock.mockClear();
    await expect(captured.resolve()).rejects.toThrow('context changed');
    expect(execCliMock).not.toHaveBeenCalled();
    process.env.CODEX_CLI_PATH = f.files.process;
    execCliMock.mockImplementation(async () => {
      await fs.writeFile(f.files.process, 'TEST changed during original version observation');
      return { stdout: 'codex-cli 0.162.0', stderr: '' };
    });
    await expect(CodexBinaryResolver.captureSelection(() => true).resolve()).rejects.toThrow(
      'changed'
    );
  });

  it('recovers a negative cache entry when a verified app-managed Codex binary appears', async () => {
    const appManagedBinary = 'C:\\Users\\tester\\AppData\\Roaming\\AgentTeams\\codex.exe';
    process.env.PATH = '';

    accessMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const { CodexBinaryResolver } = await import('../CodexBinaryResolver');
    CodexBinaryResolver.clearCache();

    await expect(CodexBinaryResolver.resolve()).resolves.toBeNull();

    resolveVerifiedAppManagedCodexRuntimeBinaryPathMock.mockResolvedValue(appManagedBinary);
    accessMock.mockImplementation((filePath) => {
      if (filePath === appManagedBinary) {
        return Promise.resolve();
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    await expect(CodexBinaryResolver.resolve()).resolves.toBe(appManagedBinary);
  });

  it('recovers a negative cache entry from PATH after the miss cache expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    setPlatform('darwin');
    process.env.PATH = '/usr/local/bin';
    const codexShim = path.posix.join('/usr/local/bin', 'codex');
    buildMergedCliPathMock.mockReturnValue('/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');

    accessMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const { CodexBinaryResolver } = await import('../CodexBinaryResolver');
    CodexBinaryResolver.clearCache();

    await expect(CodexBinaryResolver.resolve()).resolves.toBeNull();

    accessMock.mockImplementation((filePath) => {
      if (filePath === codexShim) {
        return Promise.resolve();
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    await expect(CodexBinaryResolver.resolve()).resolves.toBeNull();

    vi.advanceTimersByTime(30_001);

    await expect(CodexBinaryResolver.resolve()).resolves.toBe(codexShim);
  });

  it('recovers a cold negative cache entry as soon as shell env becomes available', async () => {
    setPlatform('darwin');
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    const shellPath = '/usr/local/bin:/usr/bin:/bin';
    const codexShim = path.posix.join('/usr/local/bin', 'codex');
    buildMergedCliPathMock.mockReturnValue('/usr/bin:/bin:/usr/sbin:/sbin');

    accessMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const { CodexBinaryResolver } = await import('../CodexBinaryResolver');
    CodexBinaryResolver.clearCache();

    await expect(CodexBinaryResolver.resolve()).resolves.toBeNull();

    getCachedShellEnvMock.mockReturnValue({
      HOME: '/Users/tester',
      PATH: shellPath,
    });
    accessMock.mockImplementation((filePath) => {
      if (filePath === codexShim) {
        return Promise.resolve();
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    await expect(CodexBinaryResolver.resolve()).resolves.toBe(codexShim);
  });

  it('skips Windows PATH candidates that exist but cannot be launched', async () => {
    const blockedDir =
      'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.422.3464.0_x64__2p2nqsd0c76g0\\app\\resources';
    const usableDir = 'C:\\Users\\User\\AppData\\Roaming\\npm';
    const blockedExe = path.win32.join(blockedDir, 'codex.exe');
    const cmdShim = path.win32.join(usableDir, 'codex.cmd');
    process.env.PATH = `${blockedDir};${usableDir}`;

    accessMock.mockImplementation((filePath) => {
      if (filePath === blockedExe || filePath === cmdShim) {
        return Promise.resolve();
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });
    execCliMock.mockImplementation((binaryPath) => {
      if (binaryPath === blockedExe) {
        return Promise.reject(Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }));
      }
      return Promise.resolve({ stdout: 'codex-cli 0.130.0', stderr: '' });
    });

    const { CodexBinaryResolver } = await import('../CodexBinaryResolver');
    CodexBinaryResolver.clearCache();

    await expect(CodexBinaryResolver.resolve()).resolves.toBe(cmdShim);
  });

  it('verifies POSIX Codex npm shims with enriched env in packaged-like shells', async () => {
    setPlatform('darwin');
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    const shellPath = '/usr/local/bin:/usr/bin:/bin';
    const codexShim = path.posix.join('/usr/local/bin', 'codex');
    getCachedShellEnvMock.mockReturnValue({
      HOME: '/Users/tester',
      PATH: shellPath,
    });

    accessMock.mockImplementation((filePath) => {
      if (filePath === codexShim) {
        return Promise.resolve();
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });
    execCliMock.mockImplementation((_binaryPath, _args, options) => {
      if (options?.env?.PATH !== `enriched:${codexShim}`) {
        return Promise.reject(
          Object.assign(new Error('env: node: No such file or directory'), {
            code: 'ENOENT',
          })
        );
      }
      return Promise.resolve({ stdout: 'codex-cli 0.130.0', stderr: '' });
    });

    const { CodexBinaryResolver } = await import('../CodexBinaryResolver');
    CodexBinaryResolver.clearCache();

    await expect(CodexBinaryResolver.resolve()).resolves.toBe(codexShim);
    expect(buildEnrichedEnvMock).toHaveBeenCalledWith(codexShim);
    expect(execCliMock).toHaveBeenCalledWith(
      codexShim,
      ['--version'],
      expect.objectContaining({
        env: expect.objectContaining({
          CODEX_RESOLVER_TEST_BINARY: codexShim,
          PATH: `enriched:${codexShim}`,
        }),
        timeout: 15_000,
        windowsHide: true,
      })
    );
  });

  it('finds POSIX Codex in merged fallback PATH when shell env is cold', async () => {
    setPlatform('darwin');
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    const codexShim = path.posix.join('/usr/local/bin', 'codex');
    buildMergedCliPathMock.mockReturnValue('/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');

    accessMock.mockImplementation((filePath) => {
      if (filePath === codexShim) {
        return Promise.resolve();
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    const { CodexBinaryResolver } = await import('../CodexBinaryResolver');
    CodexBinaryResolver.clearCache();

    await expect(CodexBinaryResolver.resolve()).resolves.toBe(codexShim);
    expect(buildMergedCliPathMock).toHaveBeenCalledWith(null);
    expect(buildEnrichedEnvMock).toHaveBeenCalledWith(codexShim);
  });

  it('reuses a recent known-good binary when revalidation transiently fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    setPlatform('darwin');
    process.env.PATH = '/usr/local/bin:/usr/bin:/bin';
    const codexShim = path.posix.join('/usr/local/bin', 'codex');
    let canLaunch = true;

    accessMock.mockImplementation((filePath) => {
      if (filePath === codexShim) {
        return Promise.resolve();
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });
    execCliMock.mockImplementation(() => {
      if (canLaunch) {
        return Promise.resolve({ stdout: 'codex-cli 0.130.0', stderr: '' });
      }
      return Promise.reject(new Error('codex --version timed out'));
    });

    const { CodexBinaryResolver } = await import('../CodexBinaryResolver');
    CodexBinaryResolver.clearCache();

    await expect(CodexBinaryResolver.resolve()).resolves.toBe(codexShim);

    canLaunch = false;
    vi.advanceTimersByTime(30_001);

    await expect(CodexBinaryResolver.resolve()).resolves.toBe(codexShim);
  });

  it('expires stale known-good reuse from the last real launch verification', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    setPlatform('darwin');
    process.env.PATH = '/usr/local/bin:/usr/bin:/bin';
    const codexShim = path.posix.join('/usr/local/bin', 'codex');
    let canLaunch = true;

    accessMock.mockImplementation((filePath) => {
      if (filePath === codexShim) {
        return Promise.resolve();
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });
    execCliMock.mockImplementation(() => {
      if (canLaunch) {
        return Promise.resolve({ stdout: 'codex-cli 0.130.0', stderr: '' });
      }
      return Promise.reject(new Error('codex --version timed out'));
    });

    const { CodexBinaryResolver } = await import('../CodexBinaryResolver');
    CodexBinaryResolver.clearCache();

    await expect(CodexBinaryResolver.resolve()).resolves.toBe(codexShim);

    canLaunch = false;
    vi.advanceTimersByTime(290_000);

    await expect(CodexBinaryResolver.resolve()).resolves.toBe(codexShim);

    vi.advanceTimersByTime(10_001);

    await expect(CodexBinaryResolver.resolve()).resolves.toBeNull();
  });

  it('prefers a newly resolved binary over stale known-good reuse', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    setPlatform('darwin');
    const oldCodexShim = path.posix.join('/old/bin', 'codex');
    const newCodexShim = path.posix.join('/new/bin', 'codex');
    process.env.PATH = '/old/bin:/usr/bin:/bin';
    let oldCanLaunch = true;

    accessMock.mockImplementation((filePath) => {
      if (filePath === oldCodexShim || filePath === newCodexShim) {
        return Promise.resolve();
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });
    execCliMock.mockImplementation((binaryPath) => {
      if (binaryPath === oldCodexShim) {
        if (oldCanLaunch) {
          return Promise.resolve({ stdout: 'codex-cli 0.130.0', stderr: '' });
        }
        return Promise.reject(new Error('old codex --version timed out'));
      }
      return Promise.resolve({ stdout: 'codex-cli 0.131.0', stderr: '' });
    });

    const { CodexBinaryResolver } = await import('../CodexBinaryResolver');
    CodexBinaryResolver.clearCache();

    await expect(CodexBinaryResolver.resolve()).resolves.toBe(oldCodexShim);

    oldCanLaunch = false;
    process.env.PATH = '/new/bin:/usr/bin:/bin';
    vi.advanceTimersByTime(30_001);

    await expect(CodexBinaryResolver.resolve()).resolves.toBe(newCodexShim);
  });

  it('does not reuse a recent known-good binary after the file disappears', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    setPlatform('darwin');
    process.env.PATH = '/usr/local/bin:/usr/bin:/bin';
    const codexShim = path.posix.join('/usr/local/bin', 'codex');
    let filePresent = true;

    accessMock.mockImplementation((filePath) => {
      if (filePath === codexShim && filePresent) {
        return Promise.resolve();
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    const { CodexBinaryResolver } = await import('../CodexBinaryResolver');
    CodexBinaryResolver.clearCache();

    await expect(CodexBinaryResolver.resolve()).resolves.toBe(codexShim);

    filePresent = false;
    vi.advanceTimersByTime(30_001);

    await expect(CodexBinaryResolver.resolve()).resolves.toBeNull();
  });

  it('uses enriched env for Codex version probes', async () => {
    setPlatform('darwin');
    const codexShim = path.posix.join('/usr/local/bin', 'codex');

    const { CodexBinaryResolver } = await import('../CodexBinaryResolver');
    CodexBinaryResolver.clearCache();

    await expect(CodexBinaryResolver.resolveVersion(codexShim)).resolves.toBe('0.130.0');
    expect(buildEnrichedEnvMock).toHaveBeenCalledWith(codexShim);
    expect(execCliMock).toHaveBeenCalledWith(
      codexShim,
      ['--version'],
      expect.objectContaining({
        env: expect.objectContaining({
          CODEX_RESOLVER_TEST_BINARY: codexShim,
          PATH: `enriched:${codexShim}`,
        }),
        timeout: 15_000,
      })
    );
  });
});
