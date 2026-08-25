// @vitest-environment node
import { execCli, spawnCli } from '@main/utils/childProcess';
import { once } from 'events';
import { copyFileSync, mkdtempSync, writeFileSync } from 'fs';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ADVERSARIAL_ARGS = [
  'TOKEN={"k":"x&echo INJECTED|rem ","pct":"%PATH%","bang":"!PATH!"}',
  '',
  // eslint-disable-next-line sonarjs/publicly-writable-directories -- Synthetic argv value; the echo fixture never uses it as a filesystem path.
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
  // A hard link aliases the currently running test executable. Windows keeps
  // that file identity locked for the lifetime of the Vitest worker, so the
  // fixture can never be removed during test cleanup. A real copy gives the
  // launched child its own executable identity while preserving the spaced,
  // non-ASCII path exercised below.
  copyFileSync(process.execPath, binaryPath);
  writeFileSync(
    echoScriptPath,
    'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
    'utf8'
  );
  return { binaryPath, echoScriptPath, root };
}

async function removeWindowsArgvFixture(fixture: WindowsArgvFixture): Promise<void> {
  // Use asynchronous retries so libuv can finish closing the child-process
  // handles before Windows retries deletion of the copied executable.
  await rm(fixture.root, { force: true, maxRetries: 20, recursive: true, retryDelay: 50 });
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
      await removeWindowsArgvFixture(fixture);
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
      expect(child.stdout?.destroyed).toBe(true);
      expect(child.stderr?.destroyed).toBe(true);
    } finally {
      await removeWindowsArgvFixture(fixture);
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
      await removeWindowsArgvFixture(fixture);
    }
  }, 30_000);

  it('preserves safe argv through batch parameter modifiers', async () => {
    const fixture = createWindowsArgvFixture();
    const launcherPath = path.join(fixture.root, 'parameter launcher.cmd');
    const safeArgs = [
      'safe value',
      '',
      // eslint-disable-next-line sonarjs/publicly-writable-directories -- Synthetic argv value; the echo fixture never uses it as a filesystem path.
      'C:\\temp\\',
    ];
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
      await removeWindowsArgvFixture(fixture);
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
      await removeWindowsArgvFixture(fixture);
    }
  }, 30_000);
});
