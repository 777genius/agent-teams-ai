import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, expect, it, vi } from 'vitest';

const execution = vi.hoisted(() => ({
  allowed: new Map<string, string>(),
  attempted: [] as { binary: string; args: string[] }[],
  rejected: [] as string[],
  ambient: '',
  root: '',
  failedPeer: '',
}));
const versionWarning = vi.hoisted(() => vi.fn());
const execPeer = promisify(execFile);

vi.mock('@shared/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/utils/logger')>();
  return {
    ...actual,
    createLogger: (name: string) => {
      const logger = actual.createLogger(name);
      return name === 'OpenCodeVersionDiagnostics' ? { ...logger, warn: versionWarning } : logger;
    },
  };
});
vi.mock('@main/utils/childProcess', () => ({
  execCli: async (binary: string, args: string[]) => {
    execution.attempted.push({ binary, args: [...args] });
    const script = execution.allowed.get(binary);
    // Trap before execution: even a broken fallback can only fail this test,
    // never run an ambient provider, shell lookup or vendor --version.
    if (!script) {
      execution.rejected.push(binary);
      throw new Error('Unexpected ambient executable: ' + binary);
    }
    if (binary === execution.failedPeer) throw Object.assign(new Error('TEST version refused'), { code: 77 });
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.ELECTRON_RUN_AS_NODE;
    return execPeer(process.execPath, [script, ...args], {
      cwd: execution.root, env, encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
  },
}));
vi.mock('@main/utils/cliPathMerge', () => ({ buildMergedCliPath: () => execution.ambient }));
vi.mock('@main/utils/shellEnv', () => ({
  getCachedShellEnv: () => ({ PATH: execution.ambient }),
  getShellPreferredHome: () => execution.root,
  resolveInteractiveShellEnvBestEffort: async () => ({ PATH: execution.ambient }),
}));

import { createCodexRuntimeInstallerFeature } from '@features/codex-runtime-installer/main';
import { CodexBinaryResolver } from '@main/services/infrastructure/codexAppServer/CodexBinaryResolver';
import {
  clearOpenCodeRuntimeBinaryResolverCache,
  isSupportedOpenCodeRuntimeBinaryPath,
  OpenCodeRuntimeInstallerService,
} from '@main/services/infrastructure/OpenCodeRuntimeInstallerService';
import { ensureOpenCodeBridgeRuntimeBinaryEnv } from '@main/services/runtime/openCodeBridgeRuntimeEnv';
import { OpenCodeBridgeCommandClient } from '@main/services/team/opencode/bridge/OpenCodeBridgeCommandClient';
import { setAppDataBasePath } from '@main/utils/pathDecoder';

const { prepareVendorMetadataFence } = createRequire(import.meta.url)(
  '../../../scripts/lib/finite-provider-metadata.cjs'
) as {
  prepareVendorMetadataFence(root: string, userData: string, options: { openCode: true }): Record<string, string>;
};

afterEach(async () => {
  setAppDataBasePath(null);
  CodexBinaryResolver.clearCache();
  clearOpenCodeRuntimeBinaryResolverCache();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  execution.allowed.clear();
  execution.attempted.length = 0;
  execution.rejected.length = 0;
  execution.failedPeer = '';
  versionWarning.mockReset();
  if (execution.root) await rm(execution.root, { recursive: true, force: true });
});

it('keeps real installer/account/bridge discovery on private TEST peers and refuses bridge failure without fallback', async () => {
  execution.root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'custom-template-TEST-providers-')));
  const userData = path.join(execution.root, 'user-data');
  execution.ambient = path.join(execution.root, 'ambient');
  await mkdir(userData);
  await mkdir(execution.ambient);
  // Available ambient candidates make this a precedence regression, rather
  // than a passing check that only works on machines without vendor tools.
  for (const provider of ['codex', 'claude', 'opencode']) {
    await writeFile(path.join(execution.ambient, provider), '#!/bin/sh\nexit 91\n', { mode: 0o700 });
  }
  const environment = prepareVendorMetadataFence(execution.root, userData, { openCode: true });
  expect(environment.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(environment.OPENCODE_BIN_PATH);
  for (const [provider, key] of [
    ['codex', 'CODEX_CLI_PATH'], ['claude', 'CLAUDE_CLI_PATH'],
    ['opencode', 'CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH'],
  ]) {
    const selected = environment[key];
    expect(selected).toBeTruthy();
    execution.allowed.set(selected, path.join(execution.root, `TEST-${provider}-metadata.cjs`));
  }
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
  vi.stubEnv('PATH', execution.ambient);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network discovery'); }));
  setAppDataBasePath(userData);
  CodexBinaryResolver.clearCache();
  clearOpenCodeRuntimeBinaryResolverCache();

  const codex = await createCodexRuntimeInstallerFeature({ resolveLatestVersion: async () => '0.164.0' }).getStatus();
  expect(codex).toMatchObject({ installed: true, source: 'app-managed', binaryPath: environment.CODEX_CLI_PATH });
  expect(await CodexBinaryResolver.resolve()).toBe(environment.CODEX_CLI_PATH);
  const opencode = await new OpenCodeRuntimeInstallerService().getStatus();
  expect(opencode).toMatchObject({ installed: true, source: 'override',
    binaryPath: environment.OPENCODE_BIN_PATH, version: '1.16.0' });

  const fallback = vi.fn(async () => { throw new Error('Unexpected default OpenCode discovery'); });
  const bridgeEnvironment = { ...environment };
  const prepareBridgeEnvironment = async () => {
    await ensureOpenCodeBridgeRuntimeBinaryEnv({
      targetEnv: bridgeEnvironment,
      resolveVerifiedOpenCodeRuntimeBinaryPath: fallback,
      isSupportedOpenCodeRuntimeBinaryPath,
    });
    return bridgeEnvironment;
  };
  const bridge = new OpenCodeBridgeCommandClient({
    // The same metadata-only TEST program refuses the ordinary fork command.
    binaryPath: environment.CLAUDE_CLI_PATH,
    tempDirectory: path.join(execution.root, 'bridge'),
    envProvider: prepareBridgeEnvironment,
  });
  const result = await bridge.execute('opencode.handshake', {}, { cwd: execution.root, timeoutMs: 1000 });
  expect(result).toMatchObject({ ok: false, error: { kind: 'provider_error' } });
  expect(execution.attempted.filter((call) => call.args[0] === 'runtime')).toEqual([
    expect.objectContaining({ binary: environment.CLAUDE_CLI_PATH }),
  ]);
  expect(bridgeEnvironment.OPENCODE_BIN_PATH).toBe(environment.OPENCODE_BIN_PATH);
  expect(bridgeEnvironment.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(environment.OPENCODE_BIN_PATH);
  expect(fallback).not.toHaveBeenCalled();
  expect(execution.rejected).toEqual([]);
  expect(versionWarning).not.toHaveBeenCalled();

  execution.failedPeer = environment.OPENCODE_BIN_PATH;
  clearOpenCodeRuntimeBinaryResolverCache();
  await expect(prepareBridgeEnvironment()).rejects.toThrow('Could not verify');
  expect(versionWarning).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(/^OpenCode version probe failed, report oc-/),
    expect.objectContaining({ binaryPath: environment.OPENCODE_BIN_PATH, command: '--version', exitCode: 77 })
  );
  expect(fallback).not.toHaveBeenCalled();
  expect(execution.rejected).toEqual([]);
  const rows = (await readFile(path.join(execution.root, 'TEST-provider-metadata.ndjson'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));
  expect(rows.slice(0, 6)).toEqual(['codex', 'claude', 'opencode'].flatMap((provider) => [
    { provider, kind: 'version', args: ['--version'] },
    { provider, kind: 'refused', args: ['TEST-forbidden-native-command'] },
  ]));
  expect(rows.some((row) => row.provider === 'opencode' && row.kind === 'version')).toBe(true);
});
