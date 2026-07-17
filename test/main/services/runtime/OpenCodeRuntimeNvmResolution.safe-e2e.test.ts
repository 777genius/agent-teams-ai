// @vitest-environment node
/* eslint-disable security/detect-non-literal-fs-filename */
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  OpenCodeRuntimeInstallerService,
  resolveVerifiedOpenCodeRuntimeBinaryPath,
} from '../../../../src/main/services/infrastructure/OpenCodeRuntimeInstallerService';
import { ensureOpenCodeBridgeRuntimeBinaryEnv } from '../../../../src/main/services/runtime/openCodeBridgeRuntimeEnv';
import { execCli } from '../../../../src/main/utils/childProcess';
import { setAppDataBasePath } from '../../../../src/main/utils/pathDecoder';
import { clearShellEnvCache } from '../../../../src/main/utils/shellEnv';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('OpenCode nvm runtime resolution safe e2e', () => {
  let tempDir: string | null = null;
  let originalHome: string | undefined;
  let originalPath: string | undefined;
  let originalShell: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-nvm-resolution-e2e-'));
    setAppDataBasePath(path.join(tempDir, 'app-data'));
    clearShellEnvCache();

    originalHome = process.env.HOME;
    originalPath = process.env.PATH;
    originalShell = process.env.SHELL;
    process.env.HOME = tempDir;
    process.env.PATH = '';
    process.env.SHELL = path.join(tempDir, 'missing-shell');
  });

  afterEach(async () => {
    clearShellEnvCache();
    setAppDataBasePath(null);

    restoreEnvValue('HOME', originalHome);
    restoreEnvValue('PATH', originalPath);
    restoreEnvValue('SHELL', originalShell);

    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('reports and launches an npm global OpenCode binary installed under nvm when GUI PATH is empty', async () => {
    await createFakeNvmOpenCodeBinary('v23.0.0', { broken: true });
    const binaryPath = await createFakeNvmOpenCodeBinary('v22.22.1');
    const binDir = path.dirname(binaryPath);

    await expect(resolveVerifiedOpenCodeRuntimeBinaryPath({ shellEnvTimeoutMs: 0 })).resolves.toBe(
      binaryPath
    );

    await expect(new OpenCodeRuntimeInstallerService().getStatus()).resolves.toMatchObject({
      installed: true,
      source: 'path',
      state: 'ready',
      binaryPath,
      version: 'opencode 1.15.6',
    });

    const bridgeEnv: NodeJS.ProcessEnv = { PATH: '' };
    await ensureOpenCodeBridgeRuntimeBinaryEnv({
      targetEnv: bridgeEnv,
      bridgeEnv,
      resolveVerifiedOpenCodeRuntimeBinaryPath,
    });

    expect(bridgeEnv.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(binaryPath);
    expect(bridgeEnv.OPENCODE_BIN_PATH).toBe(binaryPath);
    expect(bridgeEnv.PATH?.split(path.delimiter)[0]).toBe(binDir);

    const version = await execCli('opencode', ['--version'], {
      env: bridgeEnv,
      timeout: 2_000,
      windowsHide: true,
    });
    expect(version.stdout.trim()).toBe('opencode 1.15.6');
  });

  async function createFakeNvmOpenCodeBinary(
    version: string,
    options: { broken?: boolean } = {}
  ): Promise<string> {
    const binDir = path.join(tempDir!, '.nvm', 'versions', 'node', version, 'bin');
    const binaryPath = path.join(binDir, 'opencode');
    await mkdir(binDir, { recursive: true });
    await writeFile(
      binaryPath,
      options.broken
        ? ['#!/bin/sh', 'echo "broken opencode" >&2', 'exit 2'].join('\n')
        : [
            '#!/bin/sh',
            'if [ "$1" = "--version" ]; then',
            '  echo "opencode 1.15.6"',
            '  exit 0',
            'fi',
            'echo "unexpected opencode args: $*" >&2',
            'exit 2',
          ].join('\n'),
      'utf8'
    );
    await chmod(binaryPath, 0o755);
    return binaryPath;
  }
});

function restoreEnvValue(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
