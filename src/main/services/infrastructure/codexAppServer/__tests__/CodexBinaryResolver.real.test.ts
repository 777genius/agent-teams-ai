// @vitest-environment node
import { chmod, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@main/utils/cliPathMerge', () => ({
  buildMergedCliPath: () => process.env.PATH ?? '',
}));

vi.mock('@main/utils/shellEnv', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/utils/shellEnv')>();
  return {
    ...actual,
    getCachedShellEnv: () => null,
  };
});

const originalPath = process.env.PATH;
const originalCodexCliPath = process.env.CODEX_CLI_PATH;
const originalFakeFailFile = process.env.CODEX_FAKE_CODEX_FAIL_FILE;
const describePosix = process.platform === 'win32' ? describe.skip : describe;
const LIVE_CODEX_BINARY_SMOKE = process.env.LIVE_CODEX_BINARY_RESOLVER_SMOKE === '1';
const describeLive = LIVE_CODEX_BINARY_SMOKE ? describe : describe.skip;
const BASE_TIME_MS = 1_767_225_600_000;

let tempDirs: string[] = [];

async function clearResolverCache(): Promise<void> {
  const { CodexBinaryResolver } = await import('../CodexBinaryResolver');
  CodexBinaryResolver.clearCache();
}

async function createFakeCodexBinary(): Promise<{
  binaryPath: string;
  failMarkerPath: string;
}> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-binary-resolver-real-'));
  tempDirs.push(tempDir);
  const binaryPath = path.join(tempDir, 'codex');
  const failMarkerPath = path.join(tempDir, 'fail');
  await writeFile(
    binaryPath,
    [
      '#!/bin/sh',
      'if [ -n "$CODEX_FAKE_CODEX_FAIL_FILE" ] && [ -f "$CODEX_FAKE_CODEX_FAIL_FILE" ]; then',
      '  echo "fake codex failure" >&2',
      '  exit 42',
      'fi',
      'if [ "$1" = "--version" ]; then',
      '  echo "codex-cli 99.0.0"',
      '  exit 0',
      'fi',
      'echo "unexpected args: $*" >&2',
      'exit 2',
      '',
    ].join('\n'),
    'utf8'
  );
  await chmod(binaryPath, 0o755);
  process.env.PATH = tempDir;
  return { binaryPath, failMarkerPath };
}

afterEach(async () => {
  vi.restoreAllMocks();
  process.env.PATH = originalPath;
  process.env.CODEX_CLI_PATH = originalCodexCliPath;
  process.env.CODEX_FAKE_CODEX_FAIL_FILE = originalFakeFailFile;
  await clearResolverCache();
  await Promise.all(tempDirs.map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs = [];
});

describePosix('CodexBinaryResolver real filesystem/process smoke', () => {
  it('resolves an explicit executable through real fs access and execFile', async () => {
    const { binaryPath, failMarkerPath } = await createFakeCodexBinary();
    process.env.CODEX_CLI_PATH = binaryPath;
    process.env.CODEX_FAKE_CODEX_FAIL_FILE = failMarkerPath;
    const { CodexBinaryResolver } = await import('../CodexBinaryResolver');
    CodexBinaryResolver.clearCache();

    await expect(CodexBinaryResolver.resolve()).resolves.toBe(binaryPath);
    await expect(CodexBinaryResolver.resolveVersion(binaryPath)).resolves.toBe('99.0.0');
  });

  it('keeps a recent real executable during transient launch failure, then expires it', async () => {
    const { binaryPath, failMarkerPath } = await createFakeCodexBinary();
    process.env.CODEX_CLI_PATH = binaryPath;
    process.env.CODEX_FAKE_CODEX_FAIL_FILE = failMarkerPath;
    const nowSpy = vi.spyOn(Date, 'now');
    const { CodexBinaryResolver } = await import('../CodexBinaryResolver');
    CodexBinaryResolver.clearCache();

    nowSpy.mockReturnValue(BASE_TIME_MS);
    await expect(CodexBinaryResolver.resolve()).resolves.toBe(binaryPath);

    await writeFile(failMarkerPath, 'fail', 'utf8');
    nowSpy.mockReturnValue(BASE_TIME_MS + 30_001);
    await expect(CodexBinaryResolver.resolve()).resolves.toBe(binaryPath);

    nowSpy.mockReturnValue(BASE_TIME_MS + 300_001);
    await expect(CodexBinaryResolver.resolve()).resolves.toBeNull();
  });

  it('does not keep a recent real executable after it is removed', async () => {
    const { binaryPath, failMarkerPath } = await createFakeCodexBinary();
    process.env.CODEX_CLI_PATH = binaryPath;
    process.env.CODEX_FAKE_CODEX_FAIL_FILE = failMarkerPath;
    const nowSpy = vi.spyOn(Date, 'now');
    const { CodexBinaryResolver } = await import('../CodexBinaryResolver');
    CodexBinaryResolver.clearCache();

    nowSpy.mockReturnValue(BASE_TIME_MS);
    await expect(CodexBinaryResolver.resolve()).resolves.toBe(binaryPath);

    await unlink(binaryPath);
    nowSpy.mockReturnValue(BASE_TIME_MS + 30_001);
    await expect(CodexBinaryResolver.resolve()).resolves.toBeNull();
  });
});

describeLive('CodexBinaryResolver live local Codex smoke', () => {
  it('resolves and versions the current local Codex binary', async () => {
    const { CodexBinaryResolver } = await import('../CodexBinaryResolver');
    CodexBinaryResolver.clearCache();

    const binaryPath = await CodexBinaryResolver.resolve();
    expect(binaryPath).toEqual(expect.any(String));
    const version = await CodexBinaryResolver.resolveVersion(binaryPath);
    expect(version).toEqual(expect.any(String));
  });
});
