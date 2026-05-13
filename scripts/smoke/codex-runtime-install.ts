#!/usr/bin/env tsx

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  CodexRuntimeInstallerService,
  resolveAppManagedCodexRuntimeBinaryPath,
  resolveVerifiedAppManagedCodexRuntimeBinaryPath,
} from '@features/codex-runtime-installer/main/infrastructure/CodexRuntimeInstallerService';
import { CodexBinaryResolver } from '@main/services/infrastructure/codexAppServer/CodexBinaryResolver';
import { getAppDataPath, setAppDataBasePath } from '@main/utils/pathDecoder';

const execFileAsync = promisify(execFile);
const VERSION_TIMEOUT_MS = 15_000;

interface CodexRuntimeSmokeManifest {
  rootVersion?: string;
  platformVersion?: string;
  platformTarget?: string;
  binaryPath?: string;
  integrity?: string;
}

interface CodexRuntimeSmokeReport {
  platform: NodeJS.Platform;
  arch: string;
  appDataPath: string;
  binaryPath: string;
  statusVersion: string | null;
  versionStdout: string;
  resolverVersion: string | null;
  rootVersion: string | null;
  platformVersion: string | null;
  platformTarget: string | null;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isInsidePath(parentPath: string, childPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);
  return Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

async function readManifest(appDataPath: string): Promise<CodexRuntimeSmokeManifest> {
  const manifestPath = path.join(appDataPath, 'runtimes', 'codex', 'current.json');
  const raw = await readFile(manifestPath, 'utf8');
  return JSON.parse(raw) as CodexRuntimeSmokeManifest;
}

async function assertExecutableVersion(binaryPath: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync(binaryPath, ['--version'], {
    timeout: VERSION_TIMEOUT_MS,
    windowsHide: true,
  });
  const output = `${stdout ?? ''}\n${stderr ?? ''}`.trim();
  assertCondition(
    /\bcodex-cli\s+\d+\.\d+\.\d+\b/i.test(output),
    `Unexpected version output: ${output}`
  );
  return output;
}

async function runSmoke(): Promise<CodexRuntimeSmokeReport> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-runtime-smoke-'));
  const keepTemp = process.env.CODEX_RUNTIME_SMOKE_KEEP_TEMP === '1';
  setAppDataBasePath(tempRoot);
  CodexBinaryResolver.clearCache();

  try {
    const service = new CodexRuntimeInstallerService();
    const status = await service.install();
    assertCondition(status.installed, `Codex runtime install failed: ${JSON.stringify(status)}`);
    assertCondition(status.binaryPath, 'Codex runtime install did not return a binary path');
    assertCondition(
      path.isAbsolute(status.binaryPath),
      `Binary path is not absolute: ${status.binaryPath}`
    );
    assertCondition(existsSync(status.binaryPath), `Binary does not exist: ${status.binaryPath}`);

    const binaryStat = await stat(status.binaryPath);
    assertCondition(binaryStat.isFile(), `Binary path is not a file: ${status.binaryPath}`);

    const appDataPath = getAppDataPath();
    assertCondition(
      isInsidePath(path.join(appDataPath, 'runtimes', 'codex'), status.binaryPath),
      `Binary path is outside the app-managed Codex runtime root: ${status.binaryPath}`
    );

    const manifest = await readManifest(appDataPath);
    assertCondition(
      manifest.binaryPath === status.binaryPath,
      'Manifest binary path does not match install status'
    );
    assertCondition(
      typeof manifest.integrity === 'string' && manifest.integrity.startsWith('sha512-'),
      'Manifest integrity is missing sha512 metadata'
    );
    assertCondition(typeof manifest.rootVersion === 'string', 'Manifest rootVersion is missing');
    assertCondition(
      typeof manifest.platformVersion === 'string',
      'Manifest platformVersion is missing'
    );
    assertCondition(
      typeof manifest.platformTarget === 'string',
      'Manifest platformTarget is missing'
    );

    const appManagedPath = resolveAppManagedCodexRuntimeBinaryPath();
    const verifiedPath = await resolveVerifiedAppManagedCodexRuntimeBinaryPath();
    const resolvedPath = await CodexBinaryResolver.resolve();
    assertCondition(
      appManagedPath === status.binaryPath,
      'resolveAppManagedCodexRuntimeBinaryPath mismatch'
    );
    assertCondition(
      verifiedPath === status.binaryPath,
      'resolveVerifiedAppManagedCodexRuntimeBinaryPath mismatch'
    );
    assertCondition(
      resolvedPath === status.binaryPath,
      'CodexBinaryResolver did not prefer the app-managed binary'
    );

    const versionStdout = await assertExecutableVersion(status.binaryPath);
    const resolverVersion = await CodexBinaryResolver.resolveVersion(resolvedPath);
    assertCondition(
      typeof resolverVersion === 'string' && /^\d+\.\d+\.\d+/.test(resolverVersion),
      `CodexBinaryResolver returned an invalid version: ${resolverVersion}`
    );

    return {
      platform: process.platform,
      arch: process.arch,
      appDataPath,
      binaryPath: status.binaryPath,
      statusVersion: status.version ?? null,
      versionStdout,
      resolverVersion,
      rootVersion: manifest.rootVersion,
      platformVersion: manifest.platformVersion,
      platformTarget: manifest.platformTarget,
    };
  } finally {
    CodexBinaryResolver.clearCache();
    setAppDataBasePath(null);
    if (keepTemp) {
      console.log(`CODEX_RUNTIME_SMOKE_KEEP_TEMP=1, keeping temp root: ${tempRoot}`);
    } else {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

runSmoke()
  .then((report) => {
    console.log(JSON.stringify(report, null, 2));
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
