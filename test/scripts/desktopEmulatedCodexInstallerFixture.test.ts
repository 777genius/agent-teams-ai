// @vitest-environment node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, expect, it, vi } from 'vitest';

const selected = vi.hoisted(() => ({
  root: '',
  shell: null as NodeJS.ProcessEnv | null,
  launches: [] as string[],
}));

vi.mock('@main/utils/pathDecoder', () => ({
  getClaudeBasePath: () => join(selected.root, 'claude'),
}));
vi.mock('@main/utils/shellEnv', () => ({
  getCachedShellEnv: () => selected.shell,
  getShellPreferredHome: () => join(selected.root, 'home'),
}));
vi.mock('@main/utils/cliEnv', () => ({
  buildEnrichedEnv: () => ({ PATH: process.env.PATH }),
}));
vi.mock('@main/utils/managedGit', () => ({
  createManagedGitEnv: (env: NodeJS.ProcessEnv) => ({ ...env }),
}));
vi.mock('@features/codex-runtime-installer/main', async () => {
  const captured = await import('@features/codex-runtime-installer/main/infrastructure/captureCodexNativeSelection');
  return {
    ...captured,
    captureAppManagedCodexRuntime: () =>
      captured.captureCodexManagedManifest(join(selected.root, 'current.json')),
    resolveAppManagedCodexRuntimeBinaryPath: () => null,
    resolveVerifiedAppManagedCodexRuntimeBinaryPath: async () => null,
  };
});
vi.mock('@main/utils/childProcess', () => ({
  execCli: async (file: string, args: string[], options: { env: NodeJS.ProcessEnv; timeout: number }) => {
    expect(file.startsWith(selected.root + '/')).toBe(true);
    expect(args).toEqual(['--version']);
    selected.launches.push(file);
    return promisify(execFile)(file, args, { ...options, encoding: 'utf8' });
  },
}));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;

afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  Object.defineProperty(process, 'arch', arch);
  vi.unstubAllEnvs();
  selected.shell = null;
  selected.launches = [];
  if (selected.root) await rm(selected.root, { recursive: true, force: true });
  selected.root = '';
});

it.skipIf(process.platform === 'win32')('selects the finite installer source with cold and warm shell PATH, then yields to the installed source', async () => {
  const { prepareDesktopEmulatedCodexInstaller } = await import('../../scripts/legacy-agent-host/desktop-emulated-codex-installer-fixture');
  const { CodexBinaryResolver } = await import('@main/services/infrastructure/codexAppServer/CodexBinaryResolver');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-desktop-backend-')));
  selected.root = root;
  const node = await realpath(process.execPath);
  const vendorBin = join(root, 'claude/local/node_modules/.bin');
  await mkdir(vendorBin, { recursive: true });
  await mkdir(join(root, 'bin'));
  const versionProgram = (version: string) => `#!${node}\nprocess.stdout.write(${JSON.stringify(version + '\n')});\n`;
  await writeFile(join(vendorBin, 'codex'), versionProgram('2.777.777 (TEST sentinel)'), { mode: 0o700 });
  const peer = join(root, 'TEST-no-agent.mjs');
  await writeFile(peer, 'throw new Error("No provider invocation is allowed in this test");\n');
  const sources = [{ path: peer, sha256: createHash('sha256').update(await readFile(peer)).digest('hex') }];
  const fixture = {
    root, node,
    appEnvironment: { PATH: join(root, 'bin'), CODEX_CLI_PATH: join(root, 'bin/codex') } as Record<string, string>,
    pins: { sentinelSha256: createHash('sha256').update(await readFile(join(vendorBin, 'codex'))).digest('hex') },
  };
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
  const installer = await prepareDesktopEmulatedCodexInstaller(fixture, resolve(import.meta.dirname, '../..'), sources);
  expect(fixture.appEnvironment.CODEX_CLI_PATH).toBeUndefined();
  vi.stubEnv('PATH', fixture.appEnvironment.PATH);
  vi.stubEnv('CODEX_CLI_PATH', undefined);

  for (const shell of [null, { PATH: fixture.appEnvironment.PATH }]) {
    selected.shell = shell;
    const result = await CodexBinaryResolver.captureSelection(() => true).resolve();
    expect(result?.selection).toEqual({ sourceKind: 'path', nativeCli: { executable: installer.executable, version: installer.binaryVersionA } });
    await result?.assertCurrent();
  }
  expect(selected.launches).toEqual([join(vendorBin, 'codex'), installer.executable.path]);

  const installed = join(root, 'installed/codex');
  await mkdir(dirname(installed));
  await writeFile(installed, versionProgram('codex-cli ' + installer.binaryVersionB), { mode: 0o700 });
  await writeFile(join(root, 'current.json'), JSON.stringify({
    schemaVersion: 1, binaryPath: installed, rootVersion: installer.binaryVersionB,
    platformVersion: installer.binaryVersionB + '-darwin-arm64', platformTarget: 'aarch64-apple-darwin',
    integrity: 'TEST', installedAt: 'TEST',
  }));
  const next = await CodexBinaryResolver.captureSelection(() => true).resolve();
  expect(next?.selection.sourceKind).toBe('app-managed');
  expect(next?.selection.nativeCli.executable.path).toBe(installed);
  expect(next?.selection.nativeCli.version).toBe(installer.binaryVersionB);
  expect(selected.launches).toEqual([join(vendorBin, 'codex'), installer.executable.path, installed]);
});
