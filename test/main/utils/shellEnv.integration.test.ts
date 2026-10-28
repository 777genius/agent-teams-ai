// @vitest-environment node
import {
  clearShellEnvCache,
  getCachedShellEnv,
  resolveInteractiveShellEnv,
  resolveInteractiveShellEnvBestEffort,
} from '@main/utils/shellEnv';
import { existsSync } from 'fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCachedEnv(timeoutMs = 2_000): Promise<NodeJS.ProcessEnv | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const cached = getCachedShellEnv();
    if (cached) {
      return cached;
    }
    await sleep(25);
  }
  return getCachedShellEnv();
}

async function createFakeShell(tempDir: string, name: string, source: string): Promise<string> {
  const shellPath = path.join(tempDir, name);
  await writeFile(shellPath, `#!/usr/bin/env node\n${source}\n`, 'utf8');
  await chmod(shellPath, 0o755);
  return shellPath;
}

function envWriterSource(envExpression: string, shellPath = '/bin/sh'): string {
  return `
function writeEnv(env) {
  // Execute the actual probe command; the fixture never manufactures its markers.
  const result = require('node:child_process').spawnSync(${JSON.stringify(shellPath)}, ['-c', process.argv[3]], {
    env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ...env },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status || 1;
}
${envExpression}
`;
}

describePosix('shellEnv real child-process integration', () => {
  const originalShell = process.env.SHELL;
  const originalInvocationFile = process.env.FAKE_SHELL_INVOCATIONS;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let tempDir = '';

  beforeEach(async () => {
    clearShellEnvCache();
    tempDir = await mkdtemp(path.join(tmpdir(), 'agent-teams-shell-env-'));
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
    delete process.env.FAKE_SHELL_INVOCATIONS;
  });

  afterEach(async () => {
    clearShellEnvCache();
    if (originalShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = originalShell;
    }
    if (originalInvocationFile === undefined) {
      delete process.env.FAKE_SHELL_INVOCATIONS;
    } else {
      process.env.FAKE_SHELL_INVOCATIONS = originalInvocationFile;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns a real shell env from an executable shell path before best-effort timeout', async () => {
    const fakeShell = await createFakeShell(
      tempDir,
      'fast-shell.js',
      envWriterSource(`
writeEnv({
  PATH: '/fake-fast/bin:/usr/bin',
  HOME: '/fake-home',
  SHELL: process.argv[1],
});
`)
    );
    process.env.SHELL = fakeShell;

    const env = await resolveInteractiveShellEnvBestEffort({
      timeoutMs: 1_000,
      fallbackEnv: { PATH: 'FALLBACK_PATH', HOME: 'FALLBACK_HOME' },
    });

    expect(env).toMatchObject({
      PATH: '/fake-fast/bin:/usr/bin',
      HOME: '/fake-home',
      SHELL: fakeShell,
    });
    expect(getCachedShellEnv()).toMatchObject({
      PATH: '/fake-fast/bin:/usr/bin',
      HOME: '/fake-home',
    });
  });

  it('returns fallback quickly while a slow shell warms the cache in the background', async () => {
    const fakeShell = await createFakeShell(
      tempDir,
      'slow-shell.js',
      envWriterSource(`
setTimeout(() => {
  writeEnv({
    PATH: '/slow-real/bin:/usr/bin',
    HOME: '/slow-home',
  });
}, 200);
`)
    );
    process.env.SHELL = fakeShell;

    const startedAt = Date.now();
    const env = await resolveInteractiveShellEnvBestEffort({
      timeoutMs: 25,
      fallbackEnv: { PATH: 'FALLBACK_PATH', HOME: 'FALLBACK_HOME' },
    });
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(150);
    expect(env).toMatchObject({ PATH: 'FALLBACK_PATH', HOME: 'FALLBACK_HOME' });
    expect(getCachedShellEnv()).toBeNull();

    await expect(waitForCachedEnv()).resolves.toMatchObject({
      PATH: '/slow-real/bin:/usr/bin',
      HOME: '/slow-home',
    });
  });

  it('returns fallback without spawning shell when background resolution is disabled', async () => {
    const invocationFile = path.join(tempDir, 'no-background-invocations.log');
    process.env.FAKE_SHELL_INVOCATIONS = invocationFile;
    const fakeShell = await createFakeShell(
      tempDir,
      'no-background-shell.js',
      envWriterSource(`
const fs = require('fs');
fs.appendFileSync(process.env.FAKE_SHELL_INVOCATIONS, 'spawned\\n');
writeEnv({
  PATH: '/should-not-run/bin',
  HOME: '/should-not-run-home',
});
`)
    );
    process.env.SHELL = fakeShell;

    const startedAt = Date.now();
    const env = await resolveInteractiveShellEnvBestEffort({
      timeoutMs: 25,
      fallbackEnv: { PATH: 'FALLBACK_PATH', HOME: 'FALLBACK_HOME' },
      background: false,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(150);
    expect(env).toMatchObject({ PATH: 'FALLBACK_PATH', HOME: 'FALLBACK_HOME' });
    expect(getCachedShellEnv()).toBeNull();
    await expect(readFile(invocationFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('falls back from a failed login shell process to a successful interactive shell process', async () => {
    const fakeShell = await createFakeShell(
      tempDir,
      'login-fails-shell.js',
      envWriterSource(`
if ((process.argv[2] || '').includes('l')) {
  process.exit(42);
}
writeEnv({
  PATH: '/interactive-real/bin:/usr/bin',
  HOME: '/interactive-home',
});
`)
    );
    process.env.SHELL = fakeShell;

    await expect(resolveInteractiveShellEnv()).resolves.toMatchObject({
      PATH: '/interactive-real/bin:/usr/bin',
      HOME: '/interactive-home',
    });
    expect(console.warn).not.toHaveBeenCalled();
    vi.mocked(console.warn).mockClear();
    expect(getCachedShellEnv()).toMatchObject({
      PATH: '/interactive-real/bin:/usr/bin',
      HOME: '/interactive-home',
    });
  });

  it.each([
    ['banner', 'TEST shell plugin failed\n'],
    ['banner with equals', 'PLUGIN_INIT=failed\n'],
    ['equals banner before complete-looking env', 'PLUGIN_INIT=failed\nPATH=/login/bin\0'],
    ['complete-looking partial env', 'PATH=/login/bin\0'],
  ])(
    'recovers the four Anthropic variables after a failed login shell prints a %s',
    async (_name, banner) => {
      const invocationFile = path.join(tempDir, 'noisy-login-invocations.log');
      process.env.FAKE_SHELL_INVOCATIONS = invocationFile;
      const expectedEnv = {
        HOME: tempDir,
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
        ANTHROPIC_AUTH_TOKEN: 'TEST-interactive-token',
        ANTHROPIC_MODEL: 'TEST-main-model',
        ANTHROPIC_SMALL_FAST_MODEL: 'TEST-fast-model',
      };
      process.env.SHELL = await createFakeShell(
        tempDir,
        'noisy-login-shell.js',
        envWriterSource(`
const fs = require('fs');
fs.appendFileSync(process.env.FAKE_SHELL_INVOCATIONS, process.argv[2] + '\\n');
if (process.argv[2] === '-lic') {
  process.stdout.write(${JSON.stringify(banner)});
  process.exitCode = 42;
} else {
  writeEnv(${JSON.stringify(expectedEnv)});
}
`)
      );

      await expect(
        resolveInteractiveShellEnvBestEffort({ timeoutMs: 2_000, fallbackEnv: {} })
      ).resolves.toMatchObject(expectedEnv);
      expect(getCachedShellEnv()).toMatchObject(expectedEnv);
      expect(getCachedShellEnv()).not.toHaveProperty('PLUGIN_INIT');
      await expect(readFile(invocationFile, 'utf8')).resolves.toBe('-lic\n-ic\n');
      expect(console.warn).not.toHaveBeenCalled();
    }
  );

  it('does not cache noisy failures or retry real shell processes during the cooldown', async () => {
    const invocationFile = path.join(tempDir, 'noisy-failure-invocations.log');
    process.env.FAKE_SHELL_INVOCATIONS = invocationFile;
    process.env.SHELL = await createFakeShell(
      tempDir,
      'noisy-failure-shell.js',
      `const fs = require('fs');
fs.appendFileSync(process.env.FAKE_SHELL_INVOCATIONS, process.argv[2] + '\\n');
process.stdout.write('PLUGIN_INIT=failed\\n');
process.exitCode = 42;`
    );
    const firstFallback = { HOME: tempDir, PATH: '/fallback/first' };
    const secondFallback = { HOME: tempDir, PATH: '/fallback/second' };

    await expect(
      resolveInteractiveShellEnvBestEffort({ timeoutMs: 2_000, fallbackEnv: firstFallback })
    ).resolves.toBe(firstFallback);
    expect(getCachedShellEnv()).toBeNull();
    await expect(
      resolveInteractiveShellEnvBestEffort({ timeoutMs: 2_000, fallbackEnv: secondFallback })
    ).resolves.toBe(secondFallback);
    expect(getCachedShellEnv()).toBeNull();
    await expect(readFile(invocationFile, 'utf8')).resolves.toBe('-lic\n-ic\n');
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      '[Utils:shellEnv]',
      'Failed to resolve shell env after login and interactive probes: login=shell env command exited with code 42; interactive=shell env command exited with code 42'
    );
    vi.mocked(console.warn).mockClear();
  });

  it.skipIf(!existsSync('/bin/bash'))(
    'retains a real complete env dump despite startup noise and a failing logout hook',
    async () => {
      const invocationFile = path.join(tempDir, 'logout-failure-invocations.log');
      process.env.FAKE_SHELL_INVOCATIONS = invocationFile;
      const expectedEnv = {
        HOME: tempDir,
        EMPTY: '',
        NOTE: 'first=value\nsecond=value',
        'BASH_FUNC_module%%': '() {\n printf "%s\\n" "a=b";\n}',
        ANTHROPIC_AUTH_TOKEN: 'TEST-complete-token',
      };
      process.env.SHELL = await createFakeShell(
        tempDir,
        'logout-failure-shell.js',
        envWriterSource(
          `
const fs = require('fs');
fs.appendFileSync(process.env.FAKE_SHELL_INVOCATIONS, process.argv[2] + '\\n');
process.stdout.write('PLUGIN_INIT=ready\\nPATH=/wrong/bin\\0');
writeEnv(${JSON.stringify(expectedEnv)});
process.stdout.write('LOGOUT=failed\\n');
process.exitCode = 42;
`,
          '/bin/bash'
        )
      );

      const env = await resolveInteractiveShellEnv();
      // Bash may normalize whitespace when importing/exporting a function.
      expect(env).toMatchObject({
        ...expectedEnv,
        'BASH_FUNC_module%%': expect.stringContaining('a=b'),
      });
      expect(getCachedShellEnv()).toBe(env);
      expect(env).not.toHaveProperty('PLUGIN_INIT');
      expect(env).not.toHaveProperty('LOGOUT');
      await expect(readFile(invocationFile, 'utf8')).resolves.toBe('-lic\n');
      expect(console.warn).not.toHaveBeenCalled();
    }
  );

  it('requires the end marker after env itself prints a partial dump and fails', async () => {
    const invocationFile = path.join(tempDir, 'partial-env-invocations.log');
    process.env.FAKE_SHELL_INVOCATIONS = invocationFile;
    const binDir = path.join(tempDir, 'partial-env-bin');
    await mkdir(binDir);
    const envPath = path.join(binDir, 'env');
    await writeFile(envPath, "#!/bin/sh\nprintf 'ANTHROPIC_MODEL=TEST-partial\\0'\nexit 42\n");
    await chmod(envPath, 0o755);
    const expectedEnv = {
      HOME: tempDir,
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
      ANTHROPIC_AUTH_TOKEN: 'TEST-complete-token',
      ANTHROPIC_MODEL: 'TEST-complete-model',
      ANTHROPIC_SMALL_FAST_MODEL: 'TEST-complete-fast',
    };
    process.env.SHELL = await createFakeShell(
      tempDir,
      'partial-env-shell.js',
      envWriterSource(`
require('fs').appendFileSync(process.env.FAKE_SHELL_INVOCATIONS, process.argv[2] + '\\n');
writeEnv(process.argv[2] === '-lic'
  ? { HOME: ${JSON.stringify(tempDir)}, PATH: ${JSON.stringify(`${binDir}:/usr/bin:/bin`)} }
  : ${JSON.stringify(expectedEnv)});
`)
    );

    await expect(resolveInteractiveShellEnv()).resolves.toMatchObject(expectedEnv);
    expect(getCachedShellEnv()).toMatchObject(expectedEnv);
    await expect(readFile(invocationFile, 'utf8')).resolves.toBe('-lic\n-ic\n');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('coalesces concurrent best-effort calls into one real shell process', async () => {
    const invocationFile = path.join(tempDir, 'invocations.log');
    process.env.FAKE_SHELL_INVOCATIONS = invocationFile;
    const fakeShell = await createFakeShell(
      tempDir,
      'coalesced-shell.js',
      envWriterSource(`
const fs = require('fs');
fs.appendFileSync(process.env.FAKE_SHELL_INVOCATIONS, 'spawned\\n');
setTimeout(() => {
  writeEnv({
    PATH: '/coalesced-real/bin:/usr/bin',
    HOME: '/coalesced-home',
  });
}, 200);
`)
    );
    process.env.SHELL = fakeShell;

    const results = await Promise.all(
      Array.from({ length: 10 }, async (_, index) =>
        resolveInteractiveShellEnvBestEffort({
          timeoutMs: 25,
          fallbackEnv: { PATH: `FALLBACK_${index}`, HOME: `FALLBACK_HOME_${index}` },
        })
      )
    );

    expect(results).toHaveLength(10);
    expect(results.every((env, index) => env.PATH === `FALLBACK_${index}`)).toBe(true);
    await expect(waitForCachedEnv()).resolves.toMatchObject({
      PATH: '/coalesced-real/bin:/usr/bin',
      HOME: '/coalesced-home',
    });

    const invocations = await readFile(invocationFile, 'utf8');
    expect(invocations.trim().split('\n')).toHaveLength(1);
  });
});
