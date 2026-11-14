// @vitest-environment node
import {
  execCli,
  killProcessTree,
  killProcessTreeAndWait,
  killTrackedCliProcesses,
  quoteWindowsCmdArg,
  spawnCli,
} from '@main/utils/childProcess';
import * as child from 'child_process';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import {
  execFileWithLinuxChildLaunch, observeLinuxChildLaunchFailure, spawnSyncWithLinuxChildLaunch,
  spawnWithLinuxChildLaunch,
} from '@main/utils/linuxChildLaunch';
import * as launchSelection from '@main/utils/linuxChildLaunchSelection';
import { EventEmitter } from 'events';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

// Mock the entire child_process module so that we can inspect how our helpers
// invoke spawn/exec without hitting the real filesystem or spawning anything.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn(),
    spawnSync: vi.fn(),
    execFile: vi.fn(),
    exec: vi.fn(),
  };
});

const selectedProcStat = vi.hoisted(() => ({ enabled: false }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync(...args: Parameters<typeof actual.readFileSync>) {
      const [file, encoding] = args;
      const pid = selectedProcStat.enabled && encoding === 'utf8' && typeof file === 'string'
        ? /^\/proc\/(901|902|903)\/stat$/.exec(file)?.[1] : undefined;
      return pid ? `${pid} (TEST selected child) S ${Array(18).fill('0').join(' ')} ${pid}` :
        actual.readFileSync(...args);
    },
  };
});

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;
type SpawnCliChild = ReturnType<typeof spawnCli>;
type ExecChild = ReturnType<typeof child.exec>;

function createMockProcess<TProcess>(): TProcess {
  return new EventEmitter() as TProcess;
}

// Helper to temporarily override process.platform
function setPlatform(value: string) {
  Object.defineProperty(process, 'platform', {
    value,
    configurable: true,
    writable: true,
  });
}

// Synthetic stdio exercises the real selected adapter; it is not a native exec proof.
function selectedProcess(pid = 901) {
  const input = new PassThrough(), output = new PassThrough(), errors = new PassThrough(), status = new PassThrough();
  const process = Object.assign(new EventEmitter(), {
    pid, stdin: input, stdout: output, stderr: errors, stdio: [input, output, errors, status],
    exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    killed: false, kill: vi.fn(() => true),
  });
  return { process, status, child: process as unknown as child.ChildProcess };
}
function execStatus(errno = 2): Buffer {
  const frame = Buffer.alloc(12);
  frame.writeUInt32BE(0x41544c58, 0); frame[4] = 1; frame[5] = 3; frame.writeUInt32LE(errno, 8);
  return frame;
}
async function settleSelectedStatus(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

function reportProcessGoneForProbe(_pid: number, signal?: string | number): true {
  if (signal === 0) {
    throw Object.assign(new Error('process exited'), { code: 'ESRCH' });
  }
  return true;
}

function unixProcessTable(
  rows: readonly {
    pid: number;
    parentPid: number;
    processGroupId: number;
    startIdentity?: string;
  }[]
): string {
  return rows
    .map(
      ({ pid, parentPid, processGroupId, startIdentity = `birth-${pid}` }) =>
        `${pid} ${parentPid} ${processGroupId} ${startIdentity}`
    )
    .join('\n');
}

// restore platform after tests
const originalPlatform = process.platform;

function createGeneratedBunLauncher(): { dir: string; launcher: string; target: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cat-cli-launcher-'));
  const targetDir = path.join(dir, 'dist');
  mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, 'cli.js');
  writeFileSync(target, 'console.log("ok")', 'utf8');
  const launcher = path.join(dir, 'cli-dev.cmd');
  writeFileSync(
    launcher,
    [
      '@echo off',
      'setlocal',
      'set "SCRIPT_DIR=%~dp0"',
      'set "TARGET=%SCRIPT_DIR%dist\\cli.js"',
      ':run_target',
      'bun "%TARGET%" %*',
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n'),
    'utf8'
  );
  return { dir, launcher, target };
}

function createExtensionlessNpmNodeLauncher(): {
  dir: string;
  launcher: string;
  target: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'cat-cli-npm-launcher-'));
  const targetDir = path.join(dir, 'node_modules', 'opencode-ai', 'bin');
  mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, 'opencode');
  writeFileSync(target, 'console.log("ok")', 'utf8');
  const launcher = path.join(dir, 'opencode.cmd');
  writeFileSync(
    launcher,
    [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      ')',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\opencode-ai\\bin\\opencode" %*',
      '',
    ].join('\r\n'),
    'utf8'
  );
  return { dir, launcher, target };
}

function createNpmNativeExeLauncher(): {
  dir: string;
  launcher: string;
  target: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'cat-cli-native-launcher-'));
  const targetDir = path.join(dir, 'node_modules', 'opencode-ai', 'bin');
  mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, 'opencode.exe');
  writeFileSync(target, '', 'utf8');
  const launcher = path.join(dir, 'opencode.cmd');
  writeFileSync(
    launcher,
    [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe" %*',
      '',
    ].join('\r\n'),
    'utf8'
  );
  return { dir, launcher, target };
}

describe('cli child process helpers', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  describe('quoteWindowsCmdArg', () => {
    it('keeps percent signs literal in cmd.exe command strings', () => {
      const quoted = quoteWindowsCmdArg('C:\\Users\\Alice\\a%PATH%b.txt');
      expect(quoted).toContain('"C:\\Users\\Alice\\a"^%"PATH"^%"b.txt"');
      expect(quoted).not.toContain('%PATH%');
      expect(quoted).not.toContain('%%PATH%%');
    });
  });

  describe('spawnCli', () => {
    it('calls spawn directly when path is ascii on windows', () => {
      setPlatform('win32');
      const fake = createMockProcess<SpawnCliChild>();
      (child.spawn as unknown as Mock).mockReturnValue(fake);

      const result = spawnCli('C:\\bin\\claude.exe', ['--version'], { cwd: 'x' });
      expect(child.spawn).toHaveBeenCalledWith(
        'C:\\bin\\claude.exe',
        ['--version'],
        expect.objectContaining({
          cwd: 'x',
          env: expect.objectContaining({ CLAUDE_HOOK_JUDGE_MODE: 'true' }),
        })
      );
      expect(result).toBe(fake);
    });

    it('hides spawned CLI windows by default but preserves explicit opt-out', () => {
      setPlatform('win32');
      const spawnMock = child.spawn as unknown as Mock;
      spawnMock.mockReturnValue(createMockProcess<SpawnCliChild>());

      spawnCli('C:\\bin\\claude.exe', ['--version']);
      expect(spawnMock.mock.calls[0][2]).toMatchObject({ windowsHide: true });

      spawnCli('C:\\bin\\claude.exe', ['--version'], { windowsHide: false });
      expect(spawnMock.mock.calls[1][2]).toMatchObject({ windowsHide: false });
    });

    it('falls back to shell when spawn throws EINVAL', () => {
      setPlatform('win32');
      const error = new Error('spawn EINVAL') as NodeJS.ErrnoException;
      error.code = 'EINVAL';
      const fake = createMockProcess<SpawnCliChild>();
      const spawnMock = child.spawn as unknown as Mock;
      spawnMock.mockImplementationOnce(() => {
        throw error;
      });
      spawnMock.mockImplementationOnce(() => fake);

      // Use ASCII path so needsShell returns false and we go through the try/catch EINVAL path
      const result = spawnCli('C:\\bin\\claude.exe', ['a', 'b'], {
        env: { FOO: 'bar' },
      });
      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(spawnMock.mock.calls[1][0]).toMatch(/cmd\.exe$/i);
      expect(spawnMock.mock.calls[1][1]).toEqual([
        '/d',
        '/s',
        '/v:off',
        '/c',
        expect.stringMatching(/claude\.exe/),
      ]);
      expect(spawnMock.mock.calls[1][2]).toMatchObject({ shell: false, env: { FOO: 'bar' } });
      expect(result).toBe(fake);
    });

    it('uses cmd.exe directly for Windows cmd launcher shell fallback', () => {
      setPlatform('win32');
      const fake = createMockProcess<SpawnCliChild>();
      const spawnMock = child.spawn as unknown as Mock;
      spawnMock.mockReturnValue(fake);

      const result = spawnCli('C:\\runtime\\cli-dev.cmd', ['--version']);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0][0]).toMatch(/cmd\.exe$/i);
      expect(spawnMock.mock.calls[0][1]).toEqual([
        '/d',
        '/s',
        '/v:off',
        '/c',
        expect.stringContaining('cli-dev.cmd'),
      ]);
      expect(spawnMock.mock.calls[0][2]).toMatchObject({ shell: false });
      expect(result).toBe(fake);
    });

    it('runs generated Bun cmd launchers directly to preserve percent args', () => {
      setPlatform('win32');
      const fake = createMockProcess<SpawnCliChild>();
      const spawnMock = child.spawn as unknown as Mock;
      spawnMock.mockReturnValue(fake);
      const { dir, launcher, target } = createGeneratedBunLauncher();
      try {
        const result = spawnCli(launcher, ['--model', 'test%PATH%"arg']);
        expect(spawnMock).toHaveBeenCalledTimes(1);
        expect(spawnMock.mock.calls[0][0]).toBe('bun');
        expect(spawnMock.mock.calls[0][1]).toEqual([target, '--model', 'test%PATH%"arg']);
        expect(spawnMock.mock.calls[0][2]).not.toHaveProperty('shell');
        expect(result).toBe(fake);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('runs extensionless npm node cmd launchers directly', () => {
      setPlatform('win32');
      const fake = createMockProcess<SpawnCliChild>();
      const spawnMock = child.spawn as unknown as Mock;
      spawnMock.mockReturnValue(fake);
      const { dir, launcher, target } = createExtensionlessNpmNodeLauncher();
      try {
        const result = spawnCli(launcher, ['--model', 'test%PATH%"arg']);
        expect(spawnMock).toHaveBeenCalledTimes(1);
        expect(spawnMock.mock.calls[0][0]).toBe('node');
        expect(spawnMock.mock.calls[0][1]).toEqual([target, '--model', 'test%PATH%"arg']);
        expect(spawnMock.mock.calls[0][2]).not.toHaveProperty('shell');
        expect(result).toBe(fake);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('runs npm native exe cmd launchers directly', () => {
      setPlatform('win32');
      const fake = new EventEmitter() as ReturnType<typeof spawnCli>;
      const spawnMock = child.spawn as unknown as Mock;
      spawnMock.mockReturnValue(fake);
      const { dir, launcher, target } = createNpmNativeExeLauncher();
      try {
        const result = spawnCli(launcher, ['serve', '--hostname', '127.0.0.1']);
        expect(spawnMock).toHaveBeenCalledTimes(1);
        expect(spawnMock.mock.calls[0][0]).toBe(target);
        expect(spawnMock.mock.calls[0][1]).toEqual(['serve', '--hostname', '127.0.0.1']);
        expect(spawnMock.mock.calls[0][2]).not.toHaveProperty('shell');
        expect(spawnMock.mock.calls[0][2]).toMatchObject({ windowsHide: true });
        expect(result).toBe(fake);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('preserves quoting for a spaced non-ASCII path in the spawn shell fallback', () => {
      setPlatform('win32');
      const fake = createMockProcess<SpawnCliChild>();
      const spawnMock = child.spawn as unknown as Mock;
      spawnMock.mockReturnValue(fake);

      const binaryPath = 'C:\\Users\\Jane Müller\\Agent Teams\\claude-multimodel.exe';
      const result = spawnCli(binaryPath, ['--version'], { env: { FOO: 'bar' } });
      // Non-ASCII detected upfront, so launch through cmd.exe fallback once.
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0][0]).toMatch(/cmd\.exe$/i);
      expect(spawnMock.mock.calls[0][1]).toEqual([
        '/d',
        '/s',
        '/v:off',
        '/c',
        `""${binaryPath}" ^"--version^""`,
      ]);
      expect(spawnMock.mock.calls[0][2]).toMatchObject({
        shell: false,
        windowsVerbatimArguments: true,
        env: { FOO: 'bar' },
      });
      expect(result).toBe(fake);
    });

    it('rejects control characters only when Windows shell fallback is needed', () => {
      setPlatform('win32');
      const spawnMock = child.spawn as unknown as Mock;
      spawnMock.mockReturnValue(createMockProcess<SpawnCliChild>());

      for (const unsafeArg of [
        'safe\0bad',
        'safe\rbad',
        'safe\nbad',
        'safe\u001fbad',
        'safe\u0085bad',
      ]) {
        expect(() => spawnCli('C:\\Users\\Алексей\\bin\\claude.cmd', [unsafeArg])).toThrow(
          'control characters are not allowed'
        );
      }
      expect(spawnMock).not.toHaveBeenCalled();

      spawnCli('C:\\bin\\claude.exe', ['safe\nargv']);
      expect(spawnMock.mock.calls[0][0]).toBe('C:\\bin\\claude.exe');
      expect(spawnMock.mock.calls[0][1]).toEqual(['safe\nargv']);
      expect(spawnMock.mock.calls[0][2]).not.toHaveProperty('shell');
    });

    it('quotes shell metacharacters when Windows shell fallback is needed', () => {
      setPlatform('win32');
      const spawnMock = child.spawn as unknown as Mock;
      spawnMock.mockReturnValue(createMockProcess<SpawnCliChild>());

      expect(() =>
        spawnCli('C:\\Users\\Алексей\\R&D\\bin\\claude.exe', [
          'safe&bad',
          'safe|bad',
          'safe<bad',
          'safe>bad',
          'safe^bad',
        ])
      ).not.toThrow();
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const shellCmd = spawnMock.mock.calls[0][1].at(-1) as string;
      expect(shellCmd).toContain('"C:\\Users\\Алексей\\R&D\\bin\\claude.exe"');
      for (const escapedShellArg of ['safe^&bad', 'safe^|bad', 'safe^<bad', 'safe^>bad']) {
        expect(shellCmd).toContain(escapedShellArg);
      }

      spawnCli('C:\\bin\\claude.exe', ['safe&argv']);
      expect(spawnMock.mock.calls[1][0]).toBe('C:\\bin\\claude.exe');
      expect(spawnMock.mock.calls[1][1]).toEqual(['safe&argv']);
      expect(spawnMock.mock.calls[1][2]).not.toHaveProperty('shell');
    });

    it('does not use shell when not on windows', async () => {
      setPlatform('linux');
      const fake = createMockProcess<SpawnCliChild>();
      (child.spawn as unknown as Mock).mockReturnValue(fake);
      const result = spawnCli('/usr/bin/claude', ['--help']);
      expect(child.spawn).toHaveBeenCalledWith(
        '/usr/bin/claude',
        ['--help'],
        expect.objectContaining({
          env: expect.objectContaining({ CLAUDE_HOOK_JUDGE_MODE: 'true' }),
        })
      );
      expect(result).toBe(fake);

      const selection = vi.spyOn(launchSelection, 'selectedLinuxChildExecutable').mockReturnValue('/TEST/helper');
      try {
        const original = selectedProcess();
        (child.spawn as unknown as Mock).mockReturnValue(original.child);
        const allocated = spawnWithLinuxChildLaunch('original-node', ['--version', 'one argument'], {
          argv0: 'original-argv0', cwd: '/TEST/cwd', env: { PATH: '/original/bin' },
          detached: true, stdio: ['ignore', 'pipe', 'inherit'],
        });
        expect(allocated).toBe(original.child);
        expect(child.spawn).toHaveBeenLastCalledWith('/TEST/helper',
          ['--linux-child-exec-v1', 'original-node', 'original-argv0', '--version', 'one argument'],
          expect.objectContaining({ cwd: '/TEST/cwd', env: { PATH: '/original/bin' },
            detached: true, stdio: ['ignore', 'pipe', 'inherit', 'pipe'], shell: false }));
        const refusal = vi.fn();
        observeLinuxChildLaunchFailure(allocated, refusal);
        original.status.end(); await settleSelectedStatus();
        expect(refusal).not.toHaveBeenCalled(); // Empty pipe is neither an error nor target readiness.
        original.process.emit('close', 0, null);
        const calls = vi.mocked(child.spawn).mock.calls.length;
        expect(() => spawnWithLinuxChildLaunch('node', [], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] }))
          .toThrow('Selected Linux child launch refused');
        expect(() => spawnWithLinuxChildLaunch('node', [], { shell: true })).toThrow();
        expect(child.spawn).toHaveBeenCalledTimes(calls);
        const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
        selection.mockImplementation(() => { clock.mockReturnValue(111); return '/TEST/helper'; });
        try {
          expect(() => spawnWithLinuxChildLaunch('node', [], { timeout: 10 })).toThrow('deadline');
          clock.mockReturnValue(100);
          expect(() => execFileWithLinuxChildLaunch('node', [], {}, vi.fn(), 110)).toThrow('deadline');
          clock.mockReturnValue(100);
          expect(() => spawnSyncWithLinuxChildLaunch('node', [], { timeout: 10 })).toThrow('deadline');
          expect(child.spawn).toHaveBeenCalledTimes(calls);
        } finally { clock.mockRestore(); }
      } finally { selection.mockRestore(); }

      // Private-file validation uses synthetic ELF headers, never an executable.
      if (typeof process.getuid === 'function') {
        const originalArch = process.arch;
        const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'TEST-linux-child-selection-')));
        const binary = path.join(root, 'linux-child-exec'), manifestPath = path.join(root, 'manifest.json');
        const elf = Buffer.alloc(120);
        elf.writeUInt32BE(0x7f454c46, 0); elf[4] = 2; elf[5] = 1; elf[6] = 1;
        elf.writeUInt16LE(2, 16); elf.writeUInt16LE(62, 18); elf.writeBigUInt64LE(64n, 32);
        elf.writeUInt16LE(64, 52); elf.writeUInt16LE(56, 54); elf.writeUInt16LE(1, 56); elf.writeUInt32LE(1, 64);
        const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
        const manifest = JSON.stringify({ schemaVersion: 1, platform: 'linux', architecture: 'x64',
          protocol: 'linux-child-exec-v1', kernelCapability: 'close-range-v1', binary: 'linux-child-exec',
          binarySha256: hash(elf), sourceSha256: '1'.repeat(64), compilerSha256: '2'.repeat(64),
          inspectorSha256: '3'.repeat(64), buildKernelRelease: 'TEST',
          linkInputs: [{ file: '/TEST/compiler-input', sha256: '4'.repeat(64) }] });
        try {
          Object.defineProperty(process, 'arch', { configurable: true, value: 'x64' });
          chmodSync(root, 0o700); writeFileSync(binary, elf, { mode: 0o500 });
          writeFileSync(manifestPath, manifest, { mode: 0o600 });
          vi.stubEnv('AGENT_TEAMS_LINUX_CHILD_EXEC_MANIFEST', manifestPath);
          vi.stubEnv('AGENT_TEAMS_LINUX_CHILD_EXEC_SHA256', hash(manifest));
          for (const hasDescriptor of [false, true]) {
            vi.stubEnv('AGENT_TEAMS_BACKEND_DESCRIPTOR_PATH', hasDescriptor ? '/TEST/original-descriptor' : undefined);
            vi.stubEnv('AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256', hasDescriptor ? '5'.repeat(64) : undefined);
            vi.resetModules();
            const selected = await import('@main/utils/linuxChildLaunchSelection');
            expect(() => selected.hasSelectedLinuxChildLaunch()).toThrow('selection');
            expect(() => selected.selectedLinuxChildExecutable()).toThrow('selection');
            const captured = { ...process.env };
            selected.initializeLinuxChildLaunch(captured);
            expect(selected.hasSelectedLinuxChildLaunch()).toBe(true);
            expect(selected.selectedLinuxChildExecutable()).toBe(binary);
            selected.initializeLinuxChildLaunch(captured);
            expect(() => selected.initializeLinuxChildLaunch({ ...captured,
              AGENT_TEAMS_BACKEND_DESCRIPTOR_PATH: '/TEST/changed-descriptor',
              AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256: '5'.repeat(64) })).toThrow('selection');
            expect(() => selected.hasSelectedLinuxChildLaunch()).toThrow('selection');
          }
          vi.stubEnv('AGENT_TEAMS_BACKEND_DESCRIPTOR_PATH', '/TEST/partial');
          vi.stubEnv('AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256', undefined);
          vi.resetModules();
          const partial = await import('@main/utils/linuxChildLaunchSelection');
          expect(() => partial.initializeLinuxChildLaunch({ ...process.env })).toThrow('selection');
          expect(() => partial.hasSelectedLinuxChildLaunch()).toThrow('selection');
          vi.stubEnv('AGENT_TEAMS_BACKEND_DESCRIPTOR_PATH', undefined);
          vi.resetModules();
          const changed = await import('@main/utils/linuxChildLaunchSelection');
          changed.initializeLinuxChildLaunch({ ...process.env });
          chmodSync(binary, 0o700); writeFileSync(binary, Buffer.alloc(120)); chmodSync(binary, 0o500);
          // Routing reads only the retained mode. The original allocation still
          // revalidates the changed image, before calling native spawn.
          expect(changed.hasSelectedLinuxChildLaunch()).toBe(true);
          expect(() => changed.selectedLinuxChildExecutable()).toThrow('selection');
          const originalCalls = vi.mocked(child.spawn).mock.calls.length;
          const allocation = await import('@main/utils/linuxChildLaunch');
          expect(() => allocation.spawnWithLinuxChildLaunch('/TEST/node', [])).toThrow('selection');
          expect(child.spawn).toHaveBeenCalledTimes(originalCalls);
          vi.stubEnv('AGENT_TEAMS_LINUX_CHILD_EXEC_MANIFEST', undefined);
          vi.stubEnv('AGENT_TEAMS_LINUX_CHILD_EXEC_SHA256', undefined);
          vi.resetModules();
          const unselected = await import('@main/utils/linuxChildLaunchSelection');
          expect(unselected.hasSelectedLinuxChildLaunch()).toBe(false);
          expect(unselected.selectedLinuxChildExecutable()).toBeNull();
          unselected.initializeLinuxChildLaunch({ ...process.env });
          expect(unselected.selectedLinuxChildExecutable()).toBeNull();
          vi.stubEnv('AGENT_TEAMS_LINUX_CHILD_EXEC_MANIFEST', manifestPath);
          vi.stubEnv('AGENT_TEAMS_LINUX_CHILD_EXEC_SHA256', hash(manifest));
          expect(unselected.hasSelectedLinuxChildLaunch()).toBe(false);
          expect(unselected.selectedLinuxChildExecutable()).toBeNull();
        } finally {
          vi.unstubAllEnvs(); vi.resetModules();
          Object.defineProperty(process, 'arch', { configurable: true, value: originalArch });
          rmSync(root, { recursive: true, force: true });
        }
      }
    });

    it('kills tracked CLI processes on shutdown', () => {
      setPlatform('darwin');
      const spawnSyncMock = child.spawnSync as unknown as Mock;
      spawnSyncMock.mockReturnValue({
        status: 0,
        stdout: unixProcessTable([{ pid: 123, parentPid: 1, processGroupId: 123 }]),
      });
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(reportProcessGoneForProbe);
      const fakeChild = {
        pid: 123,
        exitCode: null,
        signalCode: null,
        kill: vi.fn(),
        once: vi.fn(function once() {
          return fakeChild;
        }),
      };
      (child.spawn as unknown as Mock).mockReturnValue(fakeChild);

      try {
        spawnCli('/usr/bin/claude', ['--version']);
        killTrackedCliProcesses('SIGTERM');

        expect(killSpy).toHaveBeenCalledWith(123, 'SIGTERM');
      } finally {
        killSpy.mockRestore();
      }
    });

    it('untracks CLI processes after close', () => {
      setPlatform('linux');
      const registeredHandlers = new Map<string, () => void>();
      const fakeChild = {
        pid: 456,
        kill: vi.fn(),
        once: vi.fn(function once(event: string, handler: () => void) {
          registeredHandlers.set(event, handler);
          return fakeChild;
        }),
      };
      (child.spawn as unknown as Mock).mockReturnValue(fakeChild);

      spawnCli('/usr/bin/claude', ['--version']);
      registeredHandlers.get('close')?.();
      killTrackedCliProcesses('SIGTERM');

      expect(fakeChild.kill).not.toHaveBeenCalled();
    });
  });

  describe('execCli', () => {
    it('invokes execFile when path is ASCII on windows', async () => {
      setPlatform('win32');
      const execFileMock = child.execFile as unknown as Mock;
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
          cb(null, 'ok', '');
          return createMockProcess<ExecChild>();
        }
      );
      const result = await execCli('C:\\bin\\claude.exe', ['--version']);
      expect(execFileMock).toHaveBeenCalledWith(
        'C:\\bin\\claude.exe',
        ['--version'],
        expect.objectContaining({
          env: expect.objectContaining({ CLAUDE_HOOK_JUDGE_MODE: 'true' }),
        }),
        expect.any(Function)
      );
      expect(result.stdout).toBe('ok');
    });

    it('hides exec CLI windows by default but preserves explicit opt-out', async () => {
      setPlatform('win32');
      const execFileMock = child.execFile as unknown as Mock;
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
          cb(null, 'ok', '');
          return createMockProcess<ExecChild>();
        }
      );

      await execCli('C:\\bin\\claude.exe', ['--version']);
      expect(execFileMock.mock.calls[0][2]).toMatchObject({ windowsHide: true });

      await execCli('C:\\bin\\claude.exe', ['--version'], { windowsHide: false });
      expect(execFileMock.mock.calls[1][2]).toMatchObject({ windowsHide: false });
    });

    it('skips straight to cmd.exe fallback for Windows cmd launchers', async () => {
      setPlatform('win32');
      const execFileMock = child.execFile as unknown as Mock;
      const execMock = child.exec as unknown as Mock;
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
          cb(null, '0.0.8', '');
          return createMockProcess<ExecChild>();
        }
      );

      const result = await execCli('C:\\runtime\\cli-dev.cmd', ['--version']);
      expect(execFileMock).toHaveBeenCalledWith(
        expect.stringMatching(/cmd\.exe$/i),
        ['/d', '/s', '/v:off', '/c', expect.stringContaining('cli-dev.cmd')],
        expect.any(Object),
        expect.any(Function)
      );
      expect(execMock).not.toHaveBeenCalled();
      expect(result.stdout).toBe('0.0.8');
    });

    it('executes generated Bun cmd launchers directly to preserve percent args', async () => {
      setPlatform('win32');
      const execFileMock = child.execFile as unknown as Mock;
      const execMock = child.exec as unknown as Mock;
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
          cb(null, 'ok', '');
          return createMockProcess<ExecChild>();
        }
      );
      const { dir, launcher, target } = createGeneratedBunLauncher();
      try {
        const result = await execCli(launcher, ['--model', 'test%PATH%"arg']);
        expect(execFileMock).toHaveBeenCalledTimes(1);
        expect(execFileMock.mock.calls[0][0]).toBe('bun');
        expect(execFileMock.mock.calls[0][1]).toEqual([target, '--model', 'test%PATH%"arg']);
        expect(execMock).not.toHaveBeenCalled();
        expect(result.stdout).toBe('ok');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('can force generated Bun cmd launchers through shell', async () => {
      setPlatform('win32');
      const execFileMock = child.execFile as unknown as Mock;
      const execMock = child.exec as unknown as Mock;
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
          cb(null, 'ok', '');
          return createMockProcess<ExecChild>();
        }
      );
      const { dir, launcher } = createGeneratedBunLauncher();
      try {
        const result = await execCli(
          launcher,
          ['runtime', 'opencode-command', 'value&echo injected'],
          {
            preferShellForWindowsBatch: true,
          }
        );
        expect(execFileMock).toHaveBeenCalledTimes(1);
        expect(execFileMock.mock.calls[0][0]).toMatch(/cmd\.exe$/i);
        const shellCmd = execFileMock.mock.calls[0][1].at(-1) as string;
        expect(shellCmd).toContain('runtime');
        expect(shellCmd).toContain('opencode-command');
        expect(shellCmd).toContain('value^^^&echo');
        expect(execMock).not.toHaveBeenCalled();
        expect(result.stdout).toBe('ok');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('executes extensionless npm node cmd launchers directly', async () => {
      setPlatform('win32');
      const execFileMock = child.execFile as unknown as Mock;
      const execMock = child.exec as unknown as Mock;
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
          cb(null, 'ok', '');
          return createMockProcess<ExecChild>();
        }
      );
      const { dir, launcher, target } = createExtensionlessNpmNodeLauncher();
      try {
        const result = await execCli(launcher, ['--model', 'test%PATH%"arg']);
        expect(execFileMock).toHaveBeenCalledTimes(1);
        expect(execFileMock.mock.calls[0][0]).toBe('node');
        expect(execFileMock.mock.calls[0][1]).toEqual([target, '--model', 'test%PATH%"arg']);
        expect(execMock).not.toHaveBeenCalled();
        expect(result.stdout).toBe('ok');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('executes npm native exe cmd launchers directly', async () => {
      setPlatform('win32');
      const execFileMock = child.execFile as unknown as Mock;
      const execMock = child.exec as unknown as Mock;
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
          cb(null, '{"ok":true}', '');
          return createMockProcess<ExecChild>();
        }
      );
      const { dir, launcher, target } = createNpmNativeExeLauncher();
      try {
        const result = await execCli(launcher, ['runtime', 'providers', 'view']);
        expect(execFileMock).toHaveBeenCalledTimes(1);
        expect(execFileMock.mock.calls[0][0]).toBe(target);
        expect(execFileMock.mock.calls[0][1]).toEqual(['runtime', 'providers', 'view']);
        expect(execFileMock.mock.calls[0][2]).toMatchObject({ windowsHide: true });
        expect(execMock).not.toHaveBeenCalled();
        expect(result.stdout).toBe('{"ok":true}');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('preserves quoting for a spaced non-ASCII path in the exec shell fallback', async () => {
      setPlatform('win32');
      const execFileMock = child.execFile as unknown as Mock;
      const execMock = child.exec as unknown as Mock;
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
          cb(null, '1.2.3', '');
          return createMockProcess<ExecChild>();
        }
      );

      const binaryPath = 'C:\\Users\\Jane Müller\\Agent Teams\\claude-multimodel.exe';
      const result = await execCli(binaryPath, ['--version']);
      expect(execFileMock).toHaveBeenCalledWith(
        expect.stringMatching(/cmd\.exe$/i),
        ['/d', '/s', '/v:off', '/c', `""${binaryPath}" ^"--version^""`],
        expect.objectContaining({ windowsVerbatimArguments: true }),
        expect.any(Function)
      );
      expect(execMock).not.toHaveBeenCalled();
      expect(result.stdout).toBe('1.2.3');
    });

    it('escapes percent signs and quotes for cmd.exe in shell fallback', async () => {
      setPlatform('win32');
      const execFileMock = child.execFile as unknown as Mock;
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
          cb(null, 'ok', '');
          return createMockProcess<ExecChild>();
        }
      );

      await execCli('C:\\Users\\Алексей\\bin\\claude.exe', ['--model', 'test%PATH%"arg']);
      const shellCmd = execFileMock.mock.calls[0][1].at(-1) as string;
      expect(shellCmd).toContain('test^%PATH^%');
      expect(shellCmd).not.toContain('%PATH%');
      expect(shellCmd).not.toContain('%%PATH%%');
      expect(shellCmd).toContain('\\^"arg');
    });

    it('neutralizes command separators next to embedded quotes in shell fallback args', async () => {
      setPlatform('win32');
      const execFileMock = child.execFile as unknown as Mock;
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
          cb(null, 'ok', '');
          return createMockProcess<ExecChild>();
        }
      );

      const binaryPath = 'C:\\Users\\Алексей\\bin\\claude.exe';
      const payload = 'TOKEN={"k":"x&echo injected&rem "}';
      await execCli(binaryPath, [payload]);

      expect(execFileMock.mock.calls[0][1]).toEqual([
        '/d',
        '/s',
        '/v:off',
        '/c',
        `""${binaryPath}" ^"TOKEN={\\^"k\\^":\\^"x^&echo^ injected^&rem^ \\^"}^""`,
      ]);
      expect(execFileMock.mock.calls[0][2]).toMatchObject({
        windowsVerbatimArguments: true,
      });
    });

    it('escapes long backslash arguments without pathological regex backtracking', async () => {
      setPlatform('win32');
      const execFileMock = child.execFile as unknown as Mock;
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
          cb(null, 'ok', '');
          return createMockProcess<ExecChild>();
        }
      );

      await expect(
        execCli('C:\\Users\\Алексей\\bin\\claude.exe', ['\\'.repeat(50_000)])
      ).resolves.toMatchObject({ stdout: 'ok' });
    }, 2_000);

    it('keeps inline settings JSON as one argv-safe argument for Windows cmd launchers', async () => {
      setPlatform('win32');
      const execFileMock = child.execFile as unknown as Mock;
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
          cb(null, 'ok', '');
          return createMockProcess<ExecChild>();
        }
      );

      await execCli('C:\\Users\\Алексей\\bin\\claude.exe', [
        '--settings',
        '{"codex":{"forced_login_method":"chatgpt"}}',
        'runtime',
        'status',
        '--json',
        '--provider',
        'codex',
      ]);
      const shellCmd = execFileMock.mock.calls[0][1].at(-1) as string;
      expect(shellCmd).toContain('{\\^"codex\\^":{\\^"forced_login_method\\^":\\^"chatgpt\\^"}}');
    });

    it('does not pass caller shell options into cmd.exe fallback', () => {
      setPlatform('win32');
      const spawnMock = child.spawn as unknown as Mock;
      spawnMock.mockReturnValue(createMockProcess<SpawnCliChild>());

      spawnCli('C:\\Users\\Алексей\\bin\\claude.cmd', ['--version'], { shell: true });
      expect(spawnMock.mock.calls[0][0]).toMatch(/cmd\.exe$/i);
      expect(spawnMock.mock.calls[0][2]).toMatchObject({ shell: false });
    });

    it('falls back to shell when execFile throws EINVAL on windows', async () => {
      setPlatform('win32');
      const execFileMock = child.execFile as unknown as Mock;
      execFileMock.mockImplementationOnce(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
          const err = new Error('spawn EINVAL') as Error & { code?: string };
          err.code = 'EINVAL';
          cb(err, '', '');
          return createMockProcess<ExecChild>();
        }
      );
      execFileMock.mockImplementationOnce(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
          cb(null, '2.3.4', '');
          return createMockProcess<ExecChild>();
        }
      );

      // ASCII path — goes through execFile first, gets EINVAL, falls back to shell
      const result = await execCli('C:\\bin\\claude.exe', ['--version']);
      expect(execFileMock).toHaveBeenCalledTimes(2);
      expect(execFileMock.mock.calls[1][0]).toMatch(/cmd\.exe$/i);
      expect(result.stdout).toBe('2.3.4');
    });

    it('rejects control characters when execCli needs Windows shell fallback', async () => {
      setPlatform('win32');
      const execFileMock = child.execFile as unknown as Mock;
      execFileMock.mockImplementationOnce(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
          const err = new Error('spawn EINVAL') as Error & { code?: string };
          err.code = 'EINVAL';
          cb(err, '', '');
          return createMockProcess<ExecChild>();
        }
      );

      await expect(execCli('C:\\bin\\claude.exe', ['safe\rbad'])).rejects.toThrow(
        'control characters are not allowed'
      );
      expect(execFileMock).toHaveBeenCalledTimes(1);
    });

    it('quotes shell metacharacters when execCli needs Windows shell fallback', async () => {
      setPlatform('win32');
      const execFileMock = child.execFile as unknown as Mock;
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
          cb(null, 'ok', '');
          return createMockProcess<ExecChild>();
        }
      );

      await expect(
        execCli('C:\\Users\\Алексей\\R&D\\bin\\claude.exe', ['safe&bad', 'safe^bad'])
      ).resolves.toMatchObject({ stdout: 'ok' });
      expect(execFileMock).toHaveBeenCalledWith(
        expect.stringMatching(/cmd\.exe$/i),
        [
          '/d',
          '/s',
          '/v:off',
          '/c',
          expect.stringContaining('"C:\\Users\\Алексей\\R&D\\bin\\claude.exe"'),
        ],
        expect.any(Object),
        expect.any(Function)
      );
      const shellCmd = execFileMock.mock.calls[0][1].at(-1) as string;
      expect(shellCmd).toContain('safe^&bad');
    });

    it('preserves stdout and stderr on execFile failures', async () => {
      setPlatform('linux');
      const execFileMock = child.execFile as unknown as Mock;
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
          cb(new Error('Command failed'), '{"error":"bad"}', 'bun: not found');
          return createMockProcess<ExecChild>();
        }
      );

      await expect(execCli('/usr/bin/claude', ['--version'])).rejects.toMatchObject({
        message: 'Command failed',
        stdout: '{"error":"bad"}',
        stderr: 'bun: not found',
      });

      const selection = vi.spyOn(launchSelection, 'selectedLinuxChildExecutable').mockReturnValue('/TEST/helper');
      try {
        const original = selectedProcess();
        vi.mocked(child.spawn).mockReturnValue(original.child);
        const callback = vi.fn();
        const allocationErrors = vi.fn(); original.process.on('error', allocationErrors);
        const retained = execFileWithLinuxChildLaunch('/missing/original', ['captured-arg'],
          { encoding: 'utf8', maxBuffer: 8, detached: true } as child.ExecFileOptions, callback);
        expect(retained).toBe(original.child);
        expect(vi.mocked(child.spawn).mock.calls.at(-1)?.[2]).not.toHaveProperty('detached');
        original.status.end(execStatus()); await settleSelectedStatus();
        expect(callback).not.toHaveBeenCalled();
        expect(allocationErrors).not.toHaveBeenCalled(); // No invented Node error event.
        expect(original.process.kill).toHaveBeenCalledOnce();
        original.process.emit('close', 111, null);
        expect(callback).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
          code: 'ENOENT', errno: -2, allocated: true, path: '/missing/original',
          spawnargs: ['captured-arg'], syscall: 'execvp /missing/original',
        }), '', '');

        for (const frame of [Buffer.alloc(0), execStatus().subarray(0, 5), Buffer.concat([execStatus(), Buffer.from([1])])]) {
          const unknown = selectedProcess(); vi.mocked(child.spawn).mockReturnValue(unknown.child);
          const completed = vi.fn();
          execFileWithLinuxChildLaunch('original-node', [], { encoding: 'buffer' }, completed);
          unknown.status.end(frame); await settleSelectedStatus();
          expect(completed).not.toHaveBeenCalled();
          unknown.process.emit('close', null, 'SIGKILL');
          expect(completed).toHaveBeenCalledOnce();
          expect(completed.mock.calls[0][0]).toBeInstanceOf(Error);
          expect(completed.mock.calls[0][0]).not.toHaveProperty('path');
          expect(completed.mock.calls[0][1]).toEqual(Buffer.alloc(0));
        }

        for (const encoding of ['utf8', 'buffer'] as const) {
          const success = selectedProcess(); vi.mocked(child.spawn).mockReturnValue(success.child);
          const completed = vi.fn();
          execFileWithLinuxChildLaunch('original-node', [], { encoding, maxBuffer: 4 }, completed);
          success.process.stdout.write('four'); success.process.stderr.write('err');
          success.status.end(); await settleSelectedStatus();
          expect(completed).not.toHaveBeenCalled();
          success.process.emit('close', 0, null);
          expect(completed).toHaveBeenCalledExactlyOnceWith(null,
            encoding === 'buffer' ? Buffer.from('four') : 'four',
            encoding === 'buffer' ? Buffer.from('err') : 'err');
        }
        const overflow = selectedProcess(); vi.mocked(child.spawn).mockReturnValue(overflow.child);
        const completed = vi.fn();
        execFileWithLinuxChildLaunch('original-node', [], { encoding: 'buffer', maxBuffer: 4 }, completed);
        overflow.process.stdout.write('five!'); expect(completed).not.toHaveBeenCalled();
        overflow.status.end(); await settleSelectedStatus(); overflow.process.emit('close', null, 'SIGTERM');
        expect(completed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        }), Buffer.from('five'), Buffer.alloc(0));

        // Sync private status never enlarges the original public allowance.
        const sync = vi.mocked(child.spawnSync);
        sync.mockReturnValue({ pid: 901, status: 0, signal: null, output:
          [null, Buffer.from('four'), Buffer.from('err'), Buffer.alloc(0)],
          stdout: Buffer.from('four'), stderr: Buffer.from('err') });
        expect(spawnSyncWithLinuxChildLaunch('original-node', [], { encoding: 'utf8', maxBuffer: 7 }))
          .toMatchObject({ pid: 901, status: 0, output: [null, 'four', 'err'], stdout: 'four', stderr: 'err' });
        expect(sync.mock.calls.at(-1)?.[2]?.maxBuffer).toBe(19);
        sync.mockReturnValue({ pid: 901, status: 111, signal: null, output:
          [null, Buffer.from('four'), Buffer.alloc(0), execStatus()],
          stdout: Buffer.from('four'), stderr: Buffer.alloc(0) });
        expect(spawnSyncWithLinuxChildLaunch('/missing/original', ['captured-arg'], { maxBuffer: 4 }))
          .toMatchObject({ pid: 901, status: 111, stdout: Buffer.from('four'),
            error: { code: 'ENOENT', path: '/missing/original', spawnargs: ['captured-arg'] } });
        sync.mockReturnValue({ pid: 901, status: 0, signal: null, output:
          [null, Buffer.from('four'), Buffer.from('more'), Buffer.alloc(0)],
          stdout: Buffer.from('four'), stderr: Buffer.from('more') });
        const exceeded = spawnSyncWithLinuxChildLaunch('original-node', [], { maxBuffer: 5 });
        expect(exceeded).toMatchObject({ pid: 901, status: 0, error: { code: 'ENOBUFS' },
          stdout: Buffer.from('four'), stderr: Buffer.from('m') });
        expect(exceeded.output).toHaveLength(3);
        for (const maxBuffer of [0, Infinity]) {
          const unlimited = spawnSyncWithLinuxChildLaunch('original-node', [], { maxBuffer });
          expect(sync.mock.calls.at(-1)?.[2]?.maxBuffer).toBe(maxBuffer);
          expect(unlimited.error).toBeUndefined(); expect(unlimited.stderr).toEqual(Buffer.from('more'));
        }
      } finally { selection.mockRestore(); }
    });

    it('kills the process tree before rejecting when maxBuffer is exceeded', async () => {
      setPlatform('darwin');
      const execFileMock = child.execFile as unknown as Mock;
      const spawnSyncMock = child.spawnSync as unknown as Mock;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(reportProcessGoneForProbe);
      const childProcess = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      childProcess.pid = 799;
      childProcess.stdout = new EventEmitter();
      childProcess.stderr = new EventEmitter();
      spawnSyncMock.mockReturnValue({
        status: 0,
        stdout: unixProcessTable([
          { pid: 799, parentPid: 1, processGroupId: 799 },
          { pid: 800, parentPid: 799, processGroupId: 799 },
        ]),
      });
      execFileMock.mockImplementation(() => childProcess);

      try {
        const result = execCli(
          path.join(tmpdir(), 'agent-teams-controller'),
          ['runtime', 'opencode-command'],
          {
            maxBuffer: 16,
          }
        );
        childProcess.stdout.emit('data', Buffer.from('output larger than sixteen bytes'));

        await expect(result).rejects.toMatchObject({
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          killed: true,
          signal: 'SIGTERM',
          processOutcomeUnknown: true,
        });
        expect(execFileMock.mock.calls[0][2]).toMatchObject({
          maxBuffer: 1024 * 1024 + 16,
        });
        expect(killSpy.mock.calls.map(([pid]) => pid)).toEqual(expect.arrayContaining([799, 800]));
      } finally {
        killSpy.mockRestore();
      }

      setPlatform('linux');
      const selection = vi.spyOn(launchSelection, 'selectedLinuxChildExecutable').mockReturnValue('/TEST/helper');
      const retained = selectedProcess(901);
      const nativeKill = vi.spyOn(process, 'kill').mockImplementation(reportProcessGoneForProbe);
      const table = Buffer.from(unixProcessTable([
        { pid: 901, parentPid: 1, processGroupId: 100 },
        { pid: 902, parentPid: 901, processGroupId: 100 },
      ]));
      vi.mocked(child.spawn).mockReturnValue(retained.child);
      spawnSyncMock.mockReturnValue({ status: 0, signal: null, pid: 990,
        output: [null, table, Buffer.alloc(0), Buffer.alloc(0)], stdout: table, stderr: Buffer.alloc(0) });
      try {
        selectedProcStat.enabled = true;
        let finished = false;
        const result = execCli('/missing/original', ['--version']);
        const rejected = expect(result).rejects.toMatchObject({ code: 'ENOENT', allocated: true,
          processOutcomeUnknown: true, path: '/missing/original' });
        void result.then(() => { finished = true; }, () => { finished = true; });
        retained.status.end(execStatus()); await settleSelectedStatus();
        expect(nativeKill.mock.calls.map(([pid]) => pid)).toEqual(expect.arrayContaining([901, 902]));
        expect(retained.process.kill).not.toHaveBeenCalled();
        expect(finished).toBe(false); // Original tree cleanup must start, but callback still awaits real close.
        retained.process.exitCode = 111;
        retained.process.emit('close', 111, null);
        await rejected;
        expect(finished).toBe(true);
        expect(nativeKill.mock.calls.filter(([, signal]) => signal === 'SIGTERM')).toHaveLength(2);

        vi.useFakeTimers();
        try {
          const stillAlive = selectedProcess(903);
          vi.mocked(child.spawn).mockReturnValue(stillAlive.child);
          const aliveTable = Buffer.from(unixProcessTable([{ pid: 903, parentPid: 1, processGroupId: 100 }]));
          spawnSyncMock.mockReturnValue({ status: 0, signal: null, pid: 991,
            output: [null, aliveTable, Buffer.alloc(0), Buffer.alloc(0)], stdout: aliveTable, stderr: Buffer.alloc(0) });
          let finished = false;
          const bounded = execCli('/missing/original', ['--version'], { timeout: 25 });
          const failed = expect(bounded).rejects.toMatchObject({ killed: true,
            message: 'Command timed out after 25ms: /missing/original --version',
            processTerminationError: expect.any(String) });
          void bounded.then(() => { finished = true; }, () => { finished = true; });
          spawnSyncMock.mockImplementation(() => { throw new Error('Original census refused'); });
          stillAlive.status.end(execStatus());
          await vi.advanceTimersByTimeAsync(0);
          expect(finished).toBe(false);
          expect(stillAlive.process.kill).toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(26);
          await failed; expect(finished).toBe(true);
          // No fabricated close is needed to settle the original unknown timeout.
          stillAlive.process.emit('close', null, 'SIGTERM');
        } finally { vi.useRealTimers(); }
      } finally { selectedProcStat.enabled = false; nativeKill.mockRestore(); selection.mockRestore(); }
    });

    it('enforces independent stdout and stderr output limits', async () => {
      setPlatform('darwin');
      const execFileMock = child.execFile as unknown as Mock;
      const spawnSyncMock = child.spawnSync as unknown as Mock;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(reportProcessGoneForProbe);
      const childProcess = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      childProcess.pid = 801;
      childProcess.stdout = new EventEmitter();
      childProcess.stderr = new EventEmitter();
      spawnSyncMock.mockReturnValue({
        status: 0,
        stdout: unixProcessTable([{ pid: 801, parentPid: 1, processGroupId: 801 }]),
      });
      execFileMock.mockImplementation(() => childProcess);

      try {
        const result = execCli(
          path.join(tmpdir(), 'agent-teams-controller'),
          ['runtime', 'opencode-command'],
          {
            stdoutMaxBuffer: 32,
            stderrMaxBuffer: 8,
          }
        );
        childProcess.stderr.emit('data', Buffer.from('ninebytes'));

        await expect(result).rejects.toMatchObject({
          message: 'stderr maxBuffer length exceeded',
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          processOutcomeUnknown: true,
        });
        expect(execFileMock.mock.calls[0][2]).toMatchObject({
          maxBuffer: 1024 * 1024 + 32,
        });
      } finally {
        killSpy.mockRestore();
      }
    });

    it('kills the launcher process tree on manual execFile timeout', async () => {
      setPlatform('darwin');
      vi.useFakeTimers();
      const execFileMock = child.execFile as unknown as Mock;
      const spawnSyncMock = child.spawnSync as unknown as Mock;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(reportProcessGoneForProbe);
      const childProcess = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      childProcess.pid = 100;
      childProcess.stdout = new EventEmitter();
      childProcess.stderr = new EventEmitter();
      spawnSyncMock.mockReturnValue({
        status: 0,
        stdout: unixProcessTable([
          { pid: 100, parentPid: 1, processGroupId: 100 },
          { pid: 101, parentPid: 100, processGroupId: 100 },
          { pid: 102, parentPid: 101, processGroupId: 100 },
          { pid: 103, parentPid: 100, processGroupId: 100 },
        ]),
      });
      execFileMock.mockImplementation(() => childProcess);

      try {
        const result = execCli(path.join(tmpdir(), 'cli-dev'), ['runtime', 'status'], {
          timeout: 100,
        });
        const expectation = expect(result).rejects.toMatchObject({
          killed: true,
          signal: 'SIGTERM',
          stdout: 'partial stdout',
          stderr: 'partial stderr',
        });
        childProcess.stdout.emit('data', Buffer.from('partial stdout'));
        childProcess.stderr.emit('data', Buffer.from('partial stderr'));
        await vi.advanceTimersByTimeAsync(100);

        await expectation;
        expect(execFileMock.mock.calls[0][2]).not.toHaveProperty('timeout');
        expect(killSpy.mock.calls.map(([pid]) => pid)).toEqual(
          expect.arrayContaining([100, 101, 102, 103])
        );
      } finally {
        killSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('waits for Windows taskkill before rejecting a timed out execCli request', async () => {
      setPlatform('win32');
      vi.useFakeTimers();
      const execFileMock = child.execFile as unknown as Mock;
      const childProcess = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      childProcess.pid = 700;
      childProcess.stdout = new EventEmitter();
      childProcess.stderr = new EventEmitter();
      let taskkillCallback: ExecCallback | null = null;
      execFileMock.mockImplementation(
        (cmd: string, _args: string[], _opts: unknown, callback: ExecCallback) => {
          if (/taskkill\.exe$/iu.test(cmd)) {
            taskkillCallback = callback;
            return createMockProcess<ExecChild>();
          }
          return childProcess;
        }
      );

      try {
        const result = execCli('C:\\bin\\opencode.exe', ['--version'], { timeout: 100 });
        let settled = false;
        void result
          .finally(() => {
            settled = true;
          })
          .catch(() => undefined);
        await vi.advanceTimersByTimeAsync(100);

        expect(taskkillCallback).not.toBeNull();
        expect(settled).toBe(false);
        taskkillCallback!(null, '', '');

        await expect(result).rejects.toMatchObject({
          killed: true,
          signal: 'SIGTERM',
        });
        expect(settled).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports a Windows process-tree termination failure on timeout', async () => {
      setPlatform('win32');
      vi.useFakeTimers();
      const execFileMock = child.execFile as unknown as Mock;
      const childProcess = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      childProcess.pid = 701;
      childProcess.stdout = new EventEmitter();
      childProcess.stderr = new EventEmitter();
      let taskkillCallback: ExecCallback | null = null;
      execFileMock.mockImplementation(
        (cmd: string, _args: string[], _opts: unknown, callback: ExecCallback) => {
          if (/taskkill\.exe$/iu.test(cmd)) {
            taskkillCallback = callback;
            return createMockProcess<ExecChild>();
          }
          return childProcess;
        }
      );
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      });

      try {
        const result = execCli('C:\\bin\\opencode.exe', ['--version'], { timeout: 100 });
        await vi.advanceTimersByTimeAsync(100);
        expect(taskkillCallback).not.toBeNull();
        taskkillCallback!(new Error('Access is denied'), '', 'ERROR: Access is denied');

        await expect(result).rejects.toMatchObject({
          killed: true,
          signal: 'SIGTERM',
          processTerminationError: expect.stringContaining(
            'Failed to verify termination of Windows process tree 701'
          ),
        });
      } finally {
        killSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('kills the launcher process tree when an execCli request is aborted', async () => {
      setPlatform('darwin');
      const execFileMock = child.execFile as unknown as Mock;
      const spawnSyncMock = child.spawnSync as unknown as Mock;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(reportProcessGoneForProbe);
      const childProcess = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      childProcess.pid = 200;
      childProcess.stdout = new EventEmitter();
      childProcess.stderr = new EventEmitter();
      spawnSyncMock.mockReturnValue({
        status: 0,
        stdout: unixProcessTable([
          { pid: 200, parentPid: 1, processGroupId: 200 },
          { pid: 201, parentPid: 200, processGroupId: 200 },
          { pid: 202, parentPid: 201, processGroupId: 200 },
        ]),
      });
      execFileMock.mockImplementation(() => childProcess);
      const controller = new AbortController();

      try {
        const result = execCli(path.join(tmpdir(), 'cli-dev'), ['runtime', 'providers', 'models'], {
          signal: controller.signal,
        });
        childProcess.stdout.emit('data', Buffer.from('partial stdout'));
        controller.abort();

        await expect(result).rejects.toMatchObject({
          name: 'AbortError',
          killed: true,
          signal: 'SIGTERM',
          stdout: 'partial stdout',
        });
        expect(execFileMock.mock.calls[0][2]).not.toHaveProperty('signal');
        expect(killSpy.mock.calls.map(([pid]) => pid)).toEqual(
          expect.arrayContaining([200, 201, 202])
        );
      } finally {
        killSpy.mockRestore();
      }
    });

    it('kills an aborted POSIX execFile tree when the launcher stays in the parent process group', async () => {
      setPlatform('darwin');
      const execFileMock = child.execFile as unknown as Mock;
      const spawnSyncMock = child.spawnSync as unknown as Mock;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(reportProcessGoneForProbe);
      const childProcess = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      childProcess.pid = 200;
      childProcess.stdout = new EventEmitter();
      childProcess.stderr = new EventEmitter();
      spawnSyncMock.mockReturnValue({
        status: 0,
        stdout: unixProcessTable([
          { pid: 200, parentPid: 1, processGroupId: 100 },
          { pid: 201, parentPid: 200, processGroupId: 100 },
          { pid: 202, parentPid: 201, processGroupId: 100 },
        ]),
      });
      execFileMock.mockImplementation(() => childProcess);
      const controller = new AbortController();

      try {
        const result = execCli(path.join(tmpdir(), 'cli-dev'), ['runtime', 'providers', 'models'], {
          signal: controller.signal,
        });
        controller.abort();

        await expect(result).rejects.toMatchObject({
          name: 'AbortError',
          killed: true,
          signal: 'SIGTERM',
        });
        expect(killSpy.mock.calls.map(([pid]) => pid)).toEqual(
          expect.arrayContaining([200, 201, 202])
        );
      } finally {
        killSpy.mockRestore();
      }
    });

    it('bounds stdout and stderr snapshots on manual execFile timeout', async () => {
      setPlatform('darwin');
      vi.useFakeTimers();
      const execFileMock = child.execFile as unknown as Mock;
      const spawnSyncMock = child.spawnSync as unknown as Mock;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(reportProcessGoneForProbe);
      const childProcess = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      childProcess.pid = 150;
      childProcess.stdout = new EventEmitter();
      childProcess.stderr = new EventEmitter();
      spawnSyncMock.mockReturnValue({
        status: 0,
        stdout: unixProcessTable([{ pid: 150, parentPid: 1, processGroupId: 150 }]),
      });
      execFileMock.mockImplementation(() => childProcess);

      try {
        const result = execCli(path.join(tmpdir(), 'cli-dev'), ['runtime', 'status'], {
          timeout: 100,
        });
        const caughtPromise = result.then(
          () => null,
          (error) =>
            error as Error & {
              killed?: boolean;
              signal?: string;
              stdout?: string;
              stderr?: string;
            }
        );
        childProcess.stdout.emit(
          'data',
          Buffer.from(`stdout-start:${'x'.repeat(200_000)}:stdout-end`)
        );
        childProcess.stderr.emit(
          'data',
          Buffer.from(`stderr-start:${'y'.repeat(200_000)}:stderr-end`)
        );
        await vi.advanceTimersByTimeAsync(100);

        const caught = await caughtPromise;

        expect(caught).toMatchObject({
          killed: true,
          signal: 'SIGTERM',
        });
        expect(caught?.stdout).toMatch(/^stdout-start:/);
        expect(caught?.stdout).toContain('...[truncated execCli timeout output]');
        expect(caught?.stdout).toMatch(/:stdout-end$/);
        expect(caught?.stdout?.length).toBeLessThan(150_000);
        expect(caught?.stderr).toMatch(/^stderr-start:/);
        expect(caught?.stderr).toContain('...[truncated execCli timeout output]');
        expect(caught?.stderr).toMatch(/:stderr-end$/);
        expect(caught?.stderr?.length).toBeLessThan(150_000);
      } finally {
        killSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('kills a POSIX launcher, Bun child, and nested shell on execFile timeout', async () => {
      setPlatform('darwin');
      vi.useFakeTimers();
      const execFileMock = child.execFile as unknown as Mock;
      const spawnSyncMock = child.spawnSync as unknown as Mock;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(reportProcessGoneForProbe);
      const childProcess = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      childProcess.pid = 500;
      childProcess.stdout = new EventEmitter();
      childProcess.stderr = new EventEmitter();
      spawnSyncMock.mockReturnValue({
        status: 0,
        stdout: unixProcessTable([
          { pid: 500, parentPid: 1, processGroupId: 500 },
          { pid: 501, parentPid: 500, processGroupId: 500 },
          { pid: 502, parentPid: 501, processGroupId: 500 },
        ]),
      });
      execFileMock.mockImplementation(() => childProcess);

      try {
        const result = execCli(path.join(tmpdir(), 'cli-dev'), ['runtime', 'status', '--json'], {
          timeout: 100,
        });
        const expectation = expect(result).rejects.toMatchObject({
          killed: true,
          signal: 'SIGTERM',
        });
        await vi.advanceTimersByTimeAsync(100);

        await expectation;
        expect(killSpy.mock.calls.map(([pid]) => pid)).toEqual(
          expect.arrayContaining([500, 501, 502])
        );
      } finally {
        killSpy.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  describe('killProcessTree', () => {
    it('uses best-effort taskkill process-tree termination on Windows', () => {
      setPlatform('win32');
      const execFileMock = child.execFile as unknown as Mock;
      execFileMock.mockReturnValue(createMockProcess());

      killProcessTree({ pid: 200 } as Parameters<typeof killProcessTree>[0], 'SIGKILL');

      expect(execFileMock).toHaveBeenCalledWith(
        path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/T', '/F', '/PID', '200'],
        { windowsHide: true, timeout: 10_000 },
        expect.any(Function)
      );
    });

    it('does not pass an already-exited Windows root PID to taskkill or direct kill', async () => {
      setPlatform('win32');
      const execFileMock = child.execFile as unknown as Mock;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      try {
        await killProcessTreeAndWait(
          {
            pid: 200,
            exitCode: 0,
            signalCode: null,
          } as Parameters<typeof killProcessTreeAndWait>[0],
          'SIGKILL'
        );

        expect(execFileMock).not.toHaveBeenCalled();
        expect(killSpy).not.toHaveBeenCalled();
      } finally {
        killSpy.mockRestore();
      }
    });

    it('uses the retained Windows process handle when taskkill fails', async () => {
      setPlatform('win32');
      const execFileMock = child.execFile as unknown as Mock;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const childKill = vi.fn(() => true);
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, callback: ExecCallback) => {
          callback(new Error('Access is denied'), '', 'ERROR: Access is denied');
          return createMockProcess<ExecChild>();
        }
      );

      try {
        await expect(
          killProcessTreeAndWait(
            { pid: 200, kill: childKill } as unknown as Parameters<
              typeof killProcessTreeAndWait
            >[0],
            'SIGKILL'
          )
        ).rejects.toThrow('descendant outcome is unknown');

        expect(childKill).toHaveBeenCalledWith('SIGKILL');
        expect(killSpy).not.toHaveBeenCalled();
      } finally {
        killSpy.mockRestore();
      }
    });

    it('never falls back to a recycled Windows PID after taskkill fails', async () => {
      setPlatform('win32');
      const execFileMock = child.execFile as unknown as Mock;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const childProcess = {
        pid: 201,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: vi.fn(() => {
          childProcess.exitCode = 0;
          return false;
        }),
      };
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, callback: ExecCallback) => {
          childProcess.exitCode = 0;
          callback(new Error('Access is denied'), '', 'ERROR: Access is denied');
          return createMockProcess<ExecChild>();
        }
      );

      try {
        await expect(
          killProcessTreeAndWait(
            childProcess as unknown as Parameters<typeof killProcessTreeAndWait>[0],
            'SIGKILL'
          )
        ).rejects.toThrow('descendant outcome is unknown');

        expect(childProcess.kill).toHaveBeenCalledWith('SIGKILL');
        expect(killSpy).not.toHaveBeenCalled();
      } finally {
        killSpy.mockRestore();
      }
    });

    it('rejects awaited Windows termination when taskkill and handle-bound kill both fail', async () => {
      setPlatform('win32');
      const execFileMock = child.execFile as unknown as Mock;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const childKill = vi.fn(() => {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      });
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, callback: ExecCallback) => {
          callback(new Error('Access is denied'), '', 'ERROR: Access is denied');
          return createMockProcess<ExecChild>();
        }
      );

      try {
        await expect(
          killProcessTreeAndWait(
            { pid: 202, kill: childKill } as unknown as Parameters<
              typeof killProcessTreeAndWait
            >[0],
            'SIGKILL'
          )
        ).rejects.toThrow('Failed to verify termination of Windows process tree 202');
        expect(childKill).toHaveBeenCalledWith('SIGKILL');
        expect(killSpy).not.toHaveBeenCalled();
      } finally {
        killSpy.mockRestore();
      }
    });

    it('kills POSIX descendants discovered from ps output', () => {
      setPlatform('darwin');
      const spawnSyncMock = child.spawnSync as unknown as Mock;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(reportProcessGoneForProbe);
      spawnSyncMock.mockReturnValue({
        status: 0,
        stdout: unixProcessTable([
          { pid: 200, parentPid: 1, processGroupId: 200 },
          { pid: 201, parentPid: 200, processGroupId: 200 },
          { pid: 202, parentPid: 201, processGroupId: 200 },
        ]),
      });

      try {
        killProcessTree({ pid: 200 } as Parameters<typeof killProcessTree>[0], 'SIGKILL');

        expect(killSpy.mock.calls.map(([pid]) => pid)).toEqual(
          expect.arrayContaining([200, 201, 202])
        );
      } finally {
        killSpy.mockRestore();
      }
    });

    it('does not resolve awaited POSIX termination while a discovered descendant is alive', async () => {
      setPlatform('darwin');
      vi.useFakeTimers();
      const spawnSyncMock = child.spawnSync as unknown as Mock;
      let descendantAlive = true;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (signal !== 0) {
          return true;
        }
        if (pid === 201 && descendantAlive) {
          return true;
        }
        throw Object.assign(new Error('process exited'), { code: 'ESRCH' });
      });
      spawnSyncMock.mockReturnValue({
        status: 0,
        stdout: unixProcessTable([
          { pid: 200, parentPid: 1, processGroupId: 200 },
          { pid: 201, parentPid: 200, processGroupId: 200 },
        ]),
      });

      try {
        let settled = false;
        const stopping = killProcessTreeAndWait(
          { pid: 200 } as Parameters<typeof killProcessTreeAndWait>[0],
          'SIGKILL'
        ).then(() => {
          settled = true;
        });
        await Promise.resolve();

        expect(killSpy).toHaveBeenCalledWith(201, 0);
        expect(settled).toBe(false);

        descendantAlive = false;
        await vi.advanceTimersByTimeAsync(25);
        await stopping;
        expect(settled).toBe(true);
      } finally {
        killSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('rejects awaited POSIX termination when descendants cannot be enumerated', async () => {
      setPlatform('darwin');
      const spawnSyncMock = child.spawnSync as unknown as Mock;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(reportProcessGoneForProbe);
      spawnSyncMock.mockReturnValue({ status: 1, stdout: '' });

      try {
        await expect(
          killProcessTreeAndWait(
            { pid: 200 } as Parameters<typeof killProcessTreeAndWait>[0],
            'SIGKILL'
          )
        ).rejects.toThrow('Failed to inspect Unix process tree 200');
        expect(killSpy).not.toHaveBeenCalled();
      } finally {
        killSpy.mockRestore();
      }
    });

    it('does not signal a Unix pid whose birth identity changed after capture', async () => {
      setPlatform('darwin');
      const spawnSyncMock = child.spawnSync as unknown as Mock;
      spawnSyncMock
        .mockReturnValueOnce({
          status: 0,
          stdout: unixProcessTable([
            { pid: 200, parentPid: 1, processGroupId: 200, startIdentity: 'old-birth' },
          ]),
        })
        .mockReturnValue({
          status: 0,
          stdout: unixProcessTable([
            { pid: 200, parentPid: 1, processGroupId: 200, startIdentity: 'new-birth' },
          ]),
        });
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(reportProcessGoneForProbe);

      try {
        await expect(
          killProcessTreeAndWait(
            { pid: 200 } as Parameters<typeof killProcessTreeAndWait>[0],
            'SIGKILL'
          )
        ).resolves.toBeUndefined();
        expect(killSpy).not.toHaveBeenCalled();
      } finally {
        killSpy.mockRestore();
      }
    });

    it('fails closed when a captured Unix birth identity changes process groups', async () => {
      setPlatform('darwin');
      const spawnSyncMock = child.spawnSync as unknown as Mock;
      spawnSyncMock
        .mockReturnValueOnce({
          status: 0,
          stdout: unixProcessTable([
            { pid: 250, parentPid: 1, processGroupId: 250, startIdentity: 'same-birth' },
          ]),
        })
        .mockReturnValue({
          status: 0,
          stdout: unixProcessTable([
            { pid: 250, parentPid: 1, processGroupId: 999, startIdentity: 'same-birth' },
          ]),
        });
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(reportProcessGoneForProbe);

      try {
        await expect(
          killProcessTreeAndWait(
            { pid: 250 } as Parameters<typeof killProcessTreeAndWait>[0],
            'SIGKILL'
          )
        ).rejects.toThrow('captured birth identity changed process groups');
        expect(killSpy).not.toHaveBeenCalled();
      } finally {
        killSpy.mockRestore();
      }
    });

    it('fails closed for an untracked exited root even when its pid is observable again', async () => {
      setPlatform('darwin');
      const spawnSyncMock = child.spawnSync as unknown as Mock;
      spawnSyncMock.mockReturnValue({
        status: 0,
        stdout: unixProcessTable([
          { pid: 275, parentPid: 1, processGroupId: 275, startIdentity: 'reused-birth' },
        ]),
      });
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(reportProcessGoneForProbe);

      try {
        await expect(
          killProcessTreeAndWait(
            { pid: 275, exitCode: 0, signalCode: null } as Parameters<
              typeof killProcessTreeAndWait
            >[0],
            'SIGKILL'
          )
        ).rejects.toThrow('root birth identity was not captured');
        expect(killSpy).not.toHaveBeenCalled();
      } finally {
        killSpy.mockRestore();
      }
    });

    it('terminates owned process-group descendants after the tracked root exits', async () => {
      setPlatform('darwin');
      const spawnSyncMock = child.spawnSync as unknown as Mock;
      spawnSyncMock
        .mockReturnValueOnce({
          status: 0,
          stdout: unixProcessTable([
            { pid: 300, parentPid: 1, processGroupId: 300, startIdentity: 'root-birth' },
          ]),
        })
        .mockReturnValue({
          status: 0,
          stdout: unixProcessTable([
            { pid: 301, parentPid: 1, processGroupId: 300, startIdentity: 'child-birth' },
            { pid: 302, parentPid: 301, processGroupId: 302, startIdentity: 'detached-birth' },
          ]),
        });
      const trackedChild = Object.assign(createMockProcess<SpawnCliChild>(), {
        pid: 300,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
      });
      (child.spawn as unknown as Mock).mockReturnValue(trackedChild);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(reportProcessGoneForProbe);

      try {
        spawnCli('/usr/bin/claude', ['--version']);
        trackedChild.exitCode = 0;

        await killProcessTreeAndWait(trackedChild, 'SIGKILL');

        expect(killSpy).toHaveBeenCalledWith(301, 'SIGKILL');
        expect(killSpy).toHaveBeenCalledWith(302, 'SIGKILL');
        expect(killSpy).not.toHaveBeenCalledWith(300, 'SIGKILL');
      } finally {
        trackedChild.emit('close', 0);
        killSpy.mockRestore();
      }
    });

    it('includes detached native teammate descendants outside the tracked launcher group', async () => {
      setPlatform('darwin');
      const spawnSyncMock = child.spawnSync as unknown as Mock;
      const root = { pid: 300, parentPid: 1, processGroupId: 300 };
      spawnSyncMock
        .mockReturnValueOnce({ status: 0, stdout: unixProcessTable([root]) })
        .mockReturnValue({
          status: 0,
          stdout: unixProcessTable([
            root,
            { pid: 301, parentPid: 300, processGroupId: 301 },
            { pid: 302, parentPid: 301, processGroupId: 301 },
            { pid: 999, parentPid: 1, processGroupId: 999 },
          ]),
        });
      const trackedChild = Object.assign(createMockProcess<SpawnCliChild>(), {
        pid: 300,
        exitCode: null,
        signalCode: null,
      });
      (child.spawn as unknown as Mock).mockReturnValue(trackedChild);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(reportProcessGoneForProbe);
      try {
        spawnCli('/usr/bin/claude', ['--version']);
        await killProcessTreeAndWait(trackedChild, 'SIGKILL');
        expect(killSpy.mock.calls.filter(([, signal]) => signal === 'SIGKILL')).toEqual([
          [302, 'SIGKILL'],
          [301, 'SIGKILL'],
          [300, 'SIGKILL'],
        ]);
        expect(killSpy).not.toHaveBeenCalledWith(999, 'SIGKILL');
      } finally {
        trackedChild.emit('close', 0);
        killSpy.mockRestore();
      }
    });

    it('fails closed when a tracked root pid is reused before descendant proof', async () => {
      setPlatform('darwin');
      const spawnSyncMock = child.spawnSync as unknown as Mock;
      spawnSyncMock
        .mockReturnValueOnce({
          status: 0,
          stdout: unixProcessTable([
            { pid: 400, parentPid: 1, processGroupId: 400, startIdentity: 'root-birth' },
          ]),
        })
        .mockReturnValue({
          status: 0,
          stdout: unixProcessTable([
            { pid: 400, parentPid: 1, processGroupId: 400, startIdentity: 'reused-birth' },
            { pid: 401, parentPid: 400, processGroupId: 400, startIdentity: 'unknown-child' },
          ]),
        });
      const trackedChild = Object.assign(createMockProcess<SpawnCliChild>(), {
        pid: 400,
        exitCode: 0,
        signalCode: null,
      });
      (child.spawn as unknown as Mock).mockReturnValue(trackedChild);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(reportProcessGoneForProbe);

      try {
        spawnCli('/usr/bin/claude', ['--version']);
        await expect(killProcessTreeAndWait(trackedChild, 'SIGKILL')).rejects.toThrow(
          'root pid was reused after ownership capture'
        );
        expect(killSpy).not.toHaveBeenCalled();
      } finally {
        trackedChild.emit('close', 0);
        killSpy.mockRestore();
      }
    });
  });
});
