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
import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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

    it('does not use shell when not on windows', () => {
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
    });

    it('kills tracked CLI processes on shutdown', () => {
      setPlatform('linux');
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const fakeChild = {
        pid: 123,
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
    });

    it('kills the process tree before rejecting when maxBuffer is exceeded', async () => {
      setPlatform('darwin');
      const execFileMock = child.execFile as unknown as Mock;
      const spawnSyncMock = child.spawnSync as unknown as Mock;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const childProcess = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      childProcess.pid = 799;
      childProcess.stdout = new EventEmitter();
      childProcess.stderr = new EventEmitter();
      spawnSyncMock.mockReturnValue({ status: 0, stdout: ['799 1', '800 799'].join('\n') });
      execFileMock.mockImplementation(() => childProcess);

      try {
        const result = execCli('/tmp/agent-teams-controller', ['runtime', 'opencode-command'], {
          maxBuffer: 16,
        });
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
    });

    it('enforces independent stdout and stderr output limits', async () => {
      setPlatform('darwin');
      const execFileMock = child.execFile as unknown as Mock;
      const spawnSyncMock = child.spawnSync as unknown as Mock;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const childProcess = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      childProcess.pid = 801;
      childProcess.stdout = new EventEmitter();
      childProcess.stderr = new EventEmitter();
      spawnSyncMock.mockReturnValue({ status: 0, stdout: '801 1' });
      execFileMock.mockImplementation(() => childProcess);

      try {
        const result = execCli('/tmp/agent-teams-controller', ['runtime', 'opencode-command'], {
          stdoutMaxBuffer: 32,
          stderrMaxBuffer: 8,
        });
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
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
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
        stdout: ['100 1', '101 100', '102 101', '103 100'].join('\n'),
      });
      execFileMock.mockImplementation(() => childProcess);

      try {
        const result = execCli('/tmp/cli-dev', ['runtime', 'status'], { timeout: 100 });
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
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
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
        stdout: ['200 1', '201 200', '202 201'].join('\n'),
      });
      execFileMock.mockImplementation(() => childProcess);
      const controller = new AbortController();

      try {
        const result = execCli('/tmp/cli-dev', ['runtime', 'providers', 'models'], {
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

    it('bounds stdout and stderr snapshots on manual execFile timeout', async () => {
      setPlatform('darwin');
      vi.useFakeTimers();
      const execFileMock = child.execFile as unknown as Mock;
      const spawnSyncMock = child.spawnSync as unknown as Mock;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
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
        stdout: '150 1',
      });
      execFileMock.mockImplementation(() => childProcess);

      try {
        const result = execCli('/tmp/cli-dev', ['runtime', 'status'], { timeout: 100 });
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
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
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
        stdout: ['500 1', '501 500', '502 501'].join('\n'),
      });
      execFileMock.mockImplementation(() => childProcess);

      try {
        const result = execCli('/tmp/cli-dev', ['runtime', 'status', '--json'], { timeout: 100 });
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

    it('reports an unknown tree outcome when taskkill fails after direct launcher termination', async () => {
      setPlatform('win32');
      const execFileMock = child.execFile as unknown as Mock;
      let launcherAlive = true;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
        if (signal === 0) {
          if (launcherAlive) return true;
          throw Object.assign(new Error('process exited'), { code: 'ESRCH' });
        }
        launcherAlive = false;
        return true;
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
            { pid: 200 } as Parameters<typeof killProcessTreeAndWait>[0],
            'SIGKILL'
          )
        ).rejects.toThrow('descendant outcome is unknown');

        expect(killSpy).toHaveBeenCalledWith(200, 'SIGKILL');
      } finally {
        killSpy.mockRestore();
      }
    });

    it('rejects awaited Windows termination when taskkill and direct kill both fail', async () => {
      setPlatform('win32');
      const execFileMock = child.execFile as unknown as Mock;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
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
            { pid: 201 } as Parameters<typeof killProcessTreeAndWait>[0],
            'SIGKILL'
          )
        ).rejects.toThrow('Failed to verify termination of Windows process tree 201');
      } finally {
        killSpy.mockRestore();
      }
    });

    it('kills POSIX descendants discovered from ps output', () => {
      setPlatform('darwin');
      const spawnSyncMock = child.spawnSync as unknown as Mock;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      spawnSyncMock.mockReturnValue({
        status: 0,
        stdout: ['200 1', '201 200', '202 201'].join('\n'),
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
  });
});
