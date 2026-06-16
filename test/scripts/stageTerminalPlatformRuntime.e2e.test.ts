// @vitest-environment node
import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const currentPlatformKey = resolveCurrentPlatformKey();
const maybeIt = currentPlatformKey ? it : it.skip;

describe('stage-terminal-platform-runtime script e2e', () => {
  maybeIt('stages and cleans a local terminal-platform runtime archive', async () => {
    const platformKey = currentPlatformKey as string;
    const lock = JSON.parse(
      fsSync.readFileSync(path.join(repoRoot, 'terminal-platform.lock.json'), 'utf8')
    );
    const asset = lock.assets[platformKey];
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-platform-stage-'));
    const stageDir = path.join(tempRoot, 'stage');
    const downloadDir = path.join(tempRoot, 'download');
    const payloadRoot = path.join(tempRoot, 'payload');
    const payloadDir = path.join(payloadRoot, asset.payloadDirName);
    const packageDir = path.join(payloadDir, asset.packageDirName);
    const archivePath = path.join(tempRoot, asset.file);

    try {
      await fs.mkdir(path.join(packageDir, 'native'), { recursive: true });
      await fs.writeFile(path.join(payloadDir, 'VERSION'), `${lock.version}\n`);
      await fs.writeFile(path.join(payloadDir, 'COMMIT_SHA'), 'fixture-commit\n');
      await fs.writeFile(path.join(payloadDir, asset.binaryName), fixtureBinaryContent());
      await fs.writeFile(
        path.join(packageDir, 'index.mjs'),
        'export const TerminalNodeClient = {};\n'
      );
      await fs.writeFile(path.join(packageDir, 'native', 'manifest.json'), '{}\n');

      createArchive(payloadRoot, asset.payloadDirName, archivePath, asset.archiveKind);

      const stageResult = spawnSync(
        process.execPath,
        [
          'scripts/stage-terminal-platform-runtime.mjs',
          '--ensure',
          '--platform',
          platformKey,
          '--archive',
          archivePath,
        ],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            CLAUDE_TERMINAL_PLATFORM_DOWNLOAD_ROOT: downloadDir,
            CLAUDE_TERMINAL_PLATFORM_STAGE_DIR: stageDir,
          },
        }
      );
      expect(stageResult.status, formatProcessOutput(stageResult)).toBe(0);
      expect(fsSync.existsSync(path.join(stageDir, 'VERSION'))).toBe(true);
      expect(fsSync.existsSync(path.join(stageDir, asset.binaryName))).toBe(true);
      expect(fsSync.existsSync(path.join(stageDir, asset.packageDirName, 'index.mjs'))).toBe(true);
      expect(
        fsSync.existsSync(path.join(stageDir, asset.packageDirName, 'native', 'manifest.json'))
      ).toBe(true);

      const ensureResult = spawnSync(
        process.execPath,
        [
          'scripts/stage-terminal-platform-runtime.mjs',
          '--ensure',
          '--platform',
          platformKey,
          '--archive',
          archivePath,
        ],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            CLAUDE_TERMINAL_PLATFORM_DOWNLOAD_ROOT: downloadDir,
            CLAUDE_TERMINAL_PLATFORM_STAGE_DIR: stageDir,
          },
        }
      );
      expect(ensureResult.status, formatProcessOutput(ensureResult)).toBe(0);
      expect(ensureResult.stdout).toContain(
        `Using staged terminal-platform runtime ${lock.version} for ${platformKey}`
      );
      expect(ensureResult.stdout).not.toContain('Extracting');

      const cleanResult = spawnSync(
        process.execPath,
        ['scripts/stage-terminal-platform-runtime.mjs', '--clean'],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            CLAUDE_TERMINAL_PLATFORM_DOWNLOAD_ROOT: downloadDir,
            CLAUDE_TERMINAL_PLATFORM_STAGE_DIR: stageDir,
          },
        }
      );
      expect(cleanResult.status, formatProcessOutput(cleanResult)).toBe(0);
      expect(fsSync.readdirSync(stageDir)).toEqual([]);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

function resolveCurrentPlatformKey(): string | null {
  const key = `${process.platform}-${process.arch}`;
  return ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'].includes(key) ? key : null;
}

function fixtureBinaryContent(): string {
  return process.platform === 'win32' ? 'fixture exe\n' : '#!/bin/sh\n';
}

function createArchive(
  payloadRoot: string,
  payloadDirName: string,
  archivePath: string,
  archiveKind: string
): void {
  if (archiveKind === 'tar.gz') {
    runOrThrow('tar', ['-czf', archivePath, '-C', payloadRoot, payloadDirName]);
    return;
  }

  if (archiveKind === 'zip' && process.platform === 'win32') {
    runOrThrow('powershell', [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${path.join(payloadRoot, payloadDirName).replace(/'/g, "''")}' -DestinationPath '${archivePath.replace(/'/g, "''")}' -Force`,
    ]);
    return;
  }

  throw new Error(`Cannot create ${archiveKind} archive on ${process.platform}`);
}

function runOrThrow(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed\n${formatProcessOutput(result)}`);
  }
}

function formatProcessOutput(result: {
  stderr?: string | Buffer | null;
  stdout?: string | Buffer | null;
}): string {
  return [result.stdout?.toString(), result.stderr?.toString()].filter(Boolean).join('\n');
}
