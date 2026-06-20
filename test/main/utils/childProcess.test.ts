// @vitest-environment node
import {
  execCli,
  killProcessTree,
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

    it('uses shell directly when path contains non-ASCII on windows', () => {
      setPlatform('win32');
      const fake = createMockProcess<SpawnCliChild>();
      const spawnMock = child.spawn as unknown as Mock;
      spawnMock.mockReturnValue(fake);

      const result = spawnCli('C:\\Users\\Алексей\\AppData\\Roaming\\npm\\claude.cmd', ['a', 'b'], {
        env: { FOO: 'bar' },
      });
      // Non-ASCII detected upfront, so launch through cmd.exe fallback once.
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0][0]).toMatch(/cmd\.exe$/i);
      const shellCmd = spawnMock.mock.calls[0][1][3] as string;
      expect(shellCmd).toMatch(/claude\.cmd/);
      expect(spawnMock.mock.calls[0][2]).toMatchObject({ shell: false, env: { FOO: 'bar' } });
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
        spawnCli('C:\\Users\\R&D\\bin\\claude.cmd', [
          'safe&bad',
          'safe|bad',
          'safe<bad',
          'safe>bad',
          'safe^bad',
        ])
      ).not.toThrow();
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const shellCmd = spawnMock.mock.calls[0][1][3] as string;
      expect(shellCmd).toContain('"C:\\Users\\R&D\\bin\\claude.cmd"');
      for (const shellArg of ['safe&bad', 'safe|bad', 'safe<bad', 'safe>bad', 'safe^bad']) {
        expect(shellCmd).toContain(`"${shellArg}"`);
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
        ['/d', '/s', '/c', expect.stringContaining('cli-dev.cmd')],
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
        const result = await execCli(launcher, ['runtime', 'opencode-command'], {
          preferShellForWindowsBatch: true,
        });
        expect(execFileMock).toHaveBeenCalledTimes(1);
        expect(execFileMock.mock.calls[0][0]).toMatch(/cmd\.exe$/i);
        expect(execFileMock.mock.calls[0][1][3]).toContain('runtime');
        expect(execFileMock.mock.calls[0][1][3]).toContain('opencode-command');
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

    it('skips straight to shell when path contains non-ASCII on windows', async () => {
      setPlatform('win32');
      const execFileMock = child.execFile as unknown as Mock;
      const execMock = child.exec as unknown as Mock;
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
        cb(null, '1.2.3', '');
        return createMockProcess<ExecChild>();
        }
      );

      const result = await execCli('C:\\Users\\Алексей\\AppData\\Roaming\\npm\\claude.cmd', [
        '--version',
      ]);
      expect(execFileMock).toHaveBeenCalledWith(
        expect.stringMatching(/cmd\.exe$/i),
        ['/d', '/s', '/c', expect.stringContaining('claude.cmd')],
        expect.any(Object),
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

      await execCli('C:\\Users\\Алексей\\bin\\claude.cmd', ['--model', 'test%PATH%"arg']);
      const shellCmd = execFileMock.mock.calls[0][1][3] as string;
      // Keep % outside quoted chunks so cmd.exe does not expand it as an env var.
      expect(shellCmd).toContain('^%"PATH"^%');
      expect(shellCmd).not.toContain('%PATH%');
      expect(shellCmd).not.toContain('%%PATH%%');
      // Quotes inside JSON-like args must survive cmd.exe and the target argv parser.
      expect(shellCmd).toContain('\\"arg');
      expect(shellCmd).not.toContain('""arg');
    });

    it('keeps inline settings JSON as one argv-safe argument for Windows cmd launchers', async () => {
      setPlatform('win32');
      const execFileMock = child.execFile as unknown as Mock;
      execFileMock.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
        cb(null, 'ok', '');
        return createMockProcess<ExecChild>();
        }
      );

      await execCli('C:\\runtime\\cli-dev.cmd', [
        '--settings',
        '{"codex":{"forced_login_method":"chatgpt"}}',
        'runtime',
        'status',
        '--json',
        '--provider',
        'codex',
      ]);
      const shellCmd = execFileMock.mock.calls[0][1][3] as string;
      expect(shellCmd).toContain('"{\\"codex\\":{\\"forced_login_method\\":\\"chatgpt\\"}}"');
      expect(shellCmd).not.toContain('{""codex"":');
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
        execCli('C:\\Users\\R&D\\bin\\claude.cmd', ['safe&bad', 'safe^bad'])
      ).resolves.toMatchObject({ stdout: 'ok' });
      expect(execFileMock).toHaveBeenCalledWith(
        expect.stringMatching(/cmd\.exe$/i),
        [
          '/d',
          '/s',
          '/c',
          expect.stringContaining('"C:\\Users\\R&D\\bin\\claude.cmd"'),
        ],
        expect.any(Object),
        expect.any(Function)
      );
      const shellCmd = execFileMock.mock.calls[0][1][3] as string;
      expect(shellCmd).toContain('"safe&bad"');
      expect(shellCmd).toContain('"safe^bad"');
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
