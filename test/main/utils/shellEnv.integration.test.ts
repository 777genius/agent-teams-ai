// @vitest-environment node
import {
  clearShellEnvCache,
  getCachedShellEnv,
  resolveInteractiveShellEnv,
  resolveInteractiveShellEnvBestEffort,
} from '@main/utils/shellEnv';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
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

function envWriterSource(envExpression: string): string {
  return `
function writeEnv(env) {
  process.stdout.write(Object.entries(env).map(([key, value]) => key + '=' + value).join('\\0') + '\\0');
}
${envExpression}
`;
}

describePosix('shellEnv real child-process integration', () => {
  const originalShell = process.env.SHELL;
  const originalInvocationFile = process.env.FAKE_SHELL_INVOCATIONS;
  let tempDir = '';

  beforeEach(async () => {
    clearShellEnvCache();
    tempDir = await mkdtemp(path.join(tmpdir(), 'agent-teams-shell-env-'));
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
