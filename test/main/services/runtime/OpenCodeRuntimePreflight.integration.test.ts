// @vitest-environment node
/* eslint-disable security/detect-non-literal-fs-filename */
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const augmentConfiguredConnectionEnvMock = vi.hoisted(() =>
  vi.fn((env: NodeJS.ProcessEnv) => Promise.resolve(env))
);
const applyConfiguredConnectionEnvMock = vi.hoisted(() =>
  vi.fn((env: NodeJS.ProcessEnv) => Promise.resolve(env))
);
const getConfiguredConnectionIssuesMock = vi.hoisted(() => vi.fn(() => Promise.resolve({})));
const getConfiguredConnectionLaunchArgsMock = vi.hoisted(() => vi.fn(() => Promise.resolve([])));
const resolveVerifiedAppManagedCodexRuntimeBinaryPathMock = vi.hoisted(() =>
  vi.fn(() => Promise.resolve(null))
);

vi.mock('../../../../src/main/services/infrastructure/ConfigManager', () => ({
  configManager: {
    getConfig: () => ({
      runtime: {
        providerBackends: {
          codex: 'codex-native',
          gemini: 'cli',
        },
      },
    }),
  },
}));

vi.mock('../../../../src/main/services/runtime/ProviderConnectionService', () => ({
  providerConnectionService: {
    augmentConfiguredConnectionEnv: (
      ...args: Parameters<typeof augmentConfiguredConnectionEnvMock>
    ) => augmentConfiguredConnectionEnvMock(...args),
    applyConfiguredConnectionEnv: (...args: Parameters<typeof applyConfiguredConnectionEnvMock>) =>
      applyConfiguredConnectionEnvMock(...args),
    getConfiguredConnectionIssues: (
      ...args: Parameters<typeof getConfiguredConnectionIssuesMock>
    ) => getConfiguredConnectionIssuesMock(...args),
    getConfiguredConnectionLaunchArgs: (
      ...args: Parameters<typeof getConfiguredConnectionLaunchArgsMock>
    ) => getConfiguredConnectionLaunchArgsMock(...args),
  },
}));

vi.mock('@features/codex-runtime-installer/main', () => ({
  resolveVerifiedAppManagedCodexRuntimeBinaryPath: () =>
    resolveVerifiedAppManagedCodexRuntimeBinaryPathMock(),
}));

import { resolveVerifiedOpenCodeRuntimeBinaryPath } from '../../../../src/main/services/infrastructure/OpenCodeRuntimeInstallerService';
import { ensureOpenCodeBridgeRuntimeBinaryEnv } from '../../../../src/main/services/runtime/openCodeBridgeRuntimeEnv';
import { buildProviderAwareCliEnv } from '../../../../src/main/services/runtime/providerAwareCliEnv';
import { execCli } from '../../../../src/main/utils/childProcess';
import { setAppDataBasePath } from '../../../../src/main/utils/pathDecoder';
import { clearShellEnvCache } from '../../../../src/main/utils/shellEnv';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('OpenCode packaged-runtime preflight integration', () => {
  let tempDir: string | null = null;
  let originalPath: string | undefined;
  let originalShell: string | undefined;
  let originalFakeOpenCodeBinDir: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-prod-preflight-'));
    setAppDataBasePath(path.join(tempDir, 'app-data'));
    clearShellEnvCache();

    originalPath = process.env.PATH;
    originalShell = process.env.SHELL;
    originalFakeOpenCodeBinDir = process.env.FAKE_OPENCODE_BIN_DIR;
    process.env.PATH = '';

    vi.clearAllMocks();
  });

  afterEach(async () => {
    clearShellEnvCache();
    setAppDataBasePath(null);

    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = originalShell;
    }
    if (originalFakeOpenCodeBinDir === undefined) {
      delete process.env.FAKE_OPENCODE_BIN_DIR;
    } else {
      process.env.FAKE_OPENCODE_BIN_DIR = originalFakeOpenCodeBinDir;
    }

    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  async function createFakeOpenCodeBinary(): Promise<{ binDir: string; binaryPath: string }> {
    const binDir = path.join(tempDir!, 'homebrew', 'bin');
    const binaryPath = path.join(binDir, 'opencode');
    await mkdir(binDir, { recursive: true });
    await writeFile(
      binaryPath,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then',
        '  echo "opencode 9.9.9"',
        '  exit 0',
        'fi',
        'echo "unexpected opencode args: $*" >&2',
        'exit 2',
      ].join('\n'),
      'utf8'
    );
    await chmod(binaryPath, 0o755);
    return { binDir, binaryPath };
  }

  async function createFakeInteractiveShell(binDir: string): Promise<string> {
    const shellPath = path.join(tempDir!, 'fake-login-shell');
    process.env.FAKE_OPENCODE_BIN_DIR = binDir;
    await writeFile(
      shellPath,
      [
        '#!/bin/sh',
        'printf "%s\\0" "PATH=$FAKE_OPENCODE_BIN_DIR" "HOME=$HOME" "SHELL=$0"',
      ].join('\n'),
      'utf8'
    );
    await chmod(shellPath, 0o755);
    return shellPath;
  }

  it('keeps OpenCode launch preflight and bridge commands working when packaged Electron starts with an empty PATH', async () => {
    const { binDir, binaryPath } = await createFakeOpenCodeBinary();
    process.env.SHELL = await createFakeInteractiveShell(binDir);

    const providerEnv = await buildProviderAwareCliEnv({
      providerId: 'opencode',
      connectionMode: 'augment',
      shellEnv: {},
      env: {
        PATH: '',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: 'node',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: '/mock/mcp-server/index.js',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON: '["/mock/mcp-server/index.js"]',
      },
    });

    expect(providerEnv.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(binaryPath);
    expect(providerEnv.env.OPENCODE_BIN_PATH).toBe(binaryPath);
    expect(providerEnv.env.PATH?.split(path.delimiter)[0]).toBe(binDir);
    expect(augmentConfiguredConnectionEnvMock).toHaveBeenCalledWith(
      expect.objectContaining({
        CLAUDE_CODE_ENTRY_PROVIDER: 'opencode',
        CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: binaryPath,
        OPENCODE_BIN_PATH: binaryPath,
      }),
      'opencode',
      undefined
    );

    const bridgeEnv: NodeJS.ProcessEnv = { PATH: '' };
    await ensureOpenCodeBridgeRuntimeBinaryEnv({
      targetEnv: bridgeEnv,
      bridgeEnv,
      resolveVerifiedOpenCodeRuntimeBinaryPath,
    });

    const commandEnv = { ...bridgeEnv };
    await ensureOpenCodeBridgeRuntimeBinaryEnv({
      targetEnv: commandEnv,
      bridgeEnv,
      resolveVerifiedOpenCodeRuntimeBinaryPath,
    });

    expect(commandEnv.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(binaryPath);
    expect(commandEnv.OPENCODE_BIN_PATH).toBe(binaryPath);
    expect(commandEnv.PATH?.split(path.delimiter)[0]).toBe(binDir);

    const version = await execCli('opencode', ['--version'], {
      env: commandEnv,
      timeout: 2_000,
      windowsHide: true,
    });
    expect(version.stdout.trim()).toBe('opencode 9.9.9');
  });
});
