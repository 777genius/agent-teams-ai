// @vitest-environment node
import { execCli, spawnCli } from '@main/utils/childProcess';
import { once } from 'events';
import { copyFileSync, linkSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ADVERSARIAL_ARGS = [
  'TOKEN={"k":"x&echo INJECTED|rem ","pct":"%PATH%","bang":"!PATH!"}',
  '',
  'C:\\temp\\',
];

interface WindowsArgvFixture {
  binaryPath: string;
  echoScriptPath: string;
  root: string;
}

function createWindowsArgvFixture(): WindowsArgvFixture {
  const root = mkdtempSync(path.join(tmpdir(), 'child-process-Jane Müller-'));
  const binaryPath = path.join(root, 'Node Runtime.exe');
  const echoScriptPath = path.join(root, 'echo-args.cjs');
  try {
    linkSync(process.execPath, binaryPath);
  } catch {
    copyFileSync(process.execPath, binaryPath);
  }
  writeFileSync(
    echoScriptPath,
    'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
    'utf8'
  );
  return { binaryPath, echoScriptPath, root };
}

describe.skipIf(process.platform !== 'win32')('Windows CLI shell fallback round trip', () => {
  it('preserves adversarial argv through execCli for a spaced non-ASCII executable path', async () => {
    const fixture = createWindowsArgvFixture();
    try {
      const { stdout, stderr } = await execCli(
        fixture.binaryPath,
        [fixture.echoScriptPath, ...ADVERSARIAL_ARGS],
        { cwd: fixture.root, timeout: 10_000 }
      );

      expect(stderr).toBe('');
      expect(JSON.parse(stdout)).toEqual(ADVERSARIAL_ARGS);
      expect(stdout).not.toContain('INJECTED\r\n');
    } finally {
      rmSync(fixture.root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    }
  }, 30_000);

  it('preserves adversarial argv through spawnCli for a spaced non-ASCII executable path', async () => {
    const fixture = createWindowsArgvFixture();
    try {
      const child = spawnCli(fixture.binaryPath, [fixture.echoScriptPath, ...ADVERSARIAL_ARGS], {
        cwd: fixture.root,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });

      const [exitCode, signal] = (await once(child, 'close')) as [
        number | null,
        NodeJS.Signals | null,
      ];
      expect({ exitCode, signal, stderr }).toEqual({ exitCode: 0, signal: null, stderr: '' });
      expect(JSON.parse(stdout)).toEqual(ADVERSARIAL_ARGS);
    } finally {
      rmSync(fixture.root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    }
  }, 30_000);

  it('preserves adversarial argv through a batch launcher that forwards %*', async () => {
    const fixture = createWindowsArgvFixture();
    const launcherPath = path.join(fixture.root, 'proxy launcher.cmd');
    writeFileSync(
      launcherPath,
      '@echo off\r\n"%~dp0Node Runtime.exe" "%~dp0echo-args.cjs" %*\r\n',
      'utf8'
    );

    try {
      const { stdout, stderr } = await execCli(launcherPath, ADVERSARIAL_ARGS, {
        cwd: fixture.root,
        preferShellForWindowsBatch: true,
        timeout: 10_000,
      });

      expect(stderr).toBe('');
      expect(JSON.parse(stdout)).toEqual(ADVERSARIAL_ARGS);
    } finally {
      rmSync(fixture.root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    }
  }, 30_000);

  it('preserves safe argv through batch parameter modifiers', async () => {
    const fixture = createWindowsArgvFixture();
    const launcherPath = path.join(fixture.root, 'parameter launcher.cmd');
    const safeArgs = ['safe value', '', 'C:\\temp\\'];
    writeFileSync(
      launcherPath,
      '@echo off\r\n"%~dp0Node Runtime.exe" "%~dp0echo-args.cjs" "%~1" "%~2" "%~3"\r\n',
      'utf8'
    );

    try {
      const { stdout, stderr } = await execCli(launcherPath, safeArgs, {
        cwd: fixture.root,
        preferShellForWindowsBatch: true,
        timeout: 10_000,
      });

      expect(stderr).toBe('');
      expect(JSON.parse(stdout)).toEqual(safeArgs);
    } finally {
      rmSync(fixture.root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    }
  }, 30_000);

  it('rejects shell syntax before a batch launcher can reparse positional arguments', async () => {
    const fixture = createWindowsArgvFixture();
    const launcherPath = path.join(fixture.root, 'parameter launcher.cmd');
    writeFileSync(
      launcherPath,
      '@echo off\r\n"%~dp0Node Runtime.exe" "%~dp0echo-args.cjs" "%~1"\r\n',
      'utf8'
    );

    try {
      await expect(
        execCli(launcherPath, [ADVERSARIAL_ARGS[0]], {
          cwd: fixture.root,
          preferShellForWindowsBatch: true,
          timeout: 10_000,
        })
      ).rejects.toThrow('Unsafe Windows batch positional argument');
    } finally {
      rmSync(fixture.root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    }
  }, 30_000);
});
