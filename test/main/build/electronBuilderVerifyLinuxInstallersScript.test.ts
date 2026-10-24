// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const verifierPath = path.resolve(
  __dirname,
  '../../../scripts/electron-builder/verifyLinuxInstallers.cjs'
);
const tempRoots: string[] = [];

// Deep directory names keep each listing line long, so the filler crosses the old
// 16 MiB buffer with a moderate number of files and stays under macOS PATH_MAX.
const fillerDir = path.join('filler', 'a'.repeat(200), 'b'.repeat(200), 'c'.repeat(200));
const OLD_LISTING_BUFFER_BYTES = 16 * 1024 * 1024;

function writeFile(root: string, relativePath: string, content: string, mode = 0o644): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode });
}

function buildDeb(options: {
  fillerFiles: number;
  withSandbox?: boolean;
  fillerFirst?: boolean;
  truncateData?: boolean;
  launcherMode?: number;
  executableDecoyLauncher?: boolean;
}): { releaseDir: string; fillerListingBytes: number } {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-linux-installers-'));
  tempRoots.push(workDir);
  const dataRoot = path.join(workDir, 'data');
  const controlRoot = path.join(workDir, 'control');
  const releaseDir = path.join(workDir, 'release');
  fs.mkdirSync(releaseDir);

  const launcher = '#!/bin/sh\nexec /opt/Agent-Teams-AI/agent-teams-ai "$@"\n';
  writeFile(dataRoot, 'usr/bin/agent-teams-ai', launcher, options.launcherMode ?? 0o755);
  if (options.executableDecoyLauncher) {
    // Listed before ./usr and ends with the launcher path, but is a different entry.
    writeFile(dataRoot, 'opt/decoy./usr/bin/agent-teams-ai', launcher, 0o755);
  }
  writeFile(dataRoot, 'opt/Agent-Teams-AI/agent-teams-ai', 'binary', 0o755);
  if (options.withSandbox ?? true) {
    writeFile(dataRoot, 'opt/Agent-Teams-AI/chrome-sandbox', 'sandbox', 0o755);
  }
  let fillerListingBytes = 0;
  for (let index = 0; index < options.fillerFiles; index += 1) {
    const relativePath = path.join(fillerDir, `file-${String(index).padStart(6, '0')}`);
    writeFile(dataRoot, relativePath, '');
    fillerListingBytes += `./${relativePath}\n`.length;
  }

  writeFile(controlRoot, 'control', 'Package: agent-teams-ai\n');
  writeFile(
    controlRoot,
    'postinst',
    '#!/bin/bash\nSANDBOX_PATH="/opt/Agent-Teams-AI/chrome-sandbox"\nchmod 4755 "$SANDBOX_PATH"\n',
    0o755
  );

  const appEntries = ['./opt', './usr'];
  const fillerEntries = options.fillerFiles > 0 ? ['./filler'] : [];
  const dataEntries = (options.fillerFirst ?? true)
    ? [...fillerEntries, ...appEntries]
    : [...appEntries, ...fillerEntries];
  const tarEnv = { ...process.env, COPYFILE_DISABLE: '1' };
  const dataTar = path.join(workDir, 'data.tar.gz');
  execFileSync('tar', ['-czf', dataTar, '-C', dataRoot, ...dataEntries], { env: tarEnv });
  if (options.truncateData) {
    fs.truncateSync(dataTar, Math.floor(fs.statSync(dataTar).size / 2));
  }
  execFileSync('tar', ['-czf', 'control.tar.gz', '-C', controlRoot, './control', './postinst'], {
    cwd: workDir,
    env: tarEnv,
  });
  fs.writeFileSync(path.join(workDir, 'debian-binary'), '2.0\n');
  execFileSync(
    'ar',
    [
      'rc',
      path.join(releaseDir, 'agent-teams-ai_0.0.0_amd64.deb'),
      'debian-binary',
      'control.tar.gz',
      'data.tar.gz',
    ],
    { cwd: workDir }
  );

  return { releaseDir, fillerListingBytes };
}

function runVerifier(releaseDir: string) {
  // spawnSync blocks the vitest timeout, so the child gets its own deadline.
  const result = spawnSync(process.execPath, [verifierPath, releaseDir], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  expect(result.error).toBeUndefined();
  return result;
}

afterAll(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === 'win32')('verifyLinuxInstallers deb checks', () => {
  it('streams a data listing larger than the old 16 MiB buffer and finds the app entries', () => {
    const { releaseDir, fillerListingBytes } = buildDeb({ fillerFiles: 28_000 });
    expect(fillerListingBytes).toBeGreaterThan(OLD_LISTING_BUFFER_BYTES);

    const result = runVerifier(releaseDir);

    expect(result.stderr).not.toContain('ENOBUFS');
    expect(result.stdout).toContain('[verifyLinuxInstallers] OK agent-teams-ai_0.0.0_amd64.deb');
    expect(result.status).toBe(0);
  }, 180_000);

  it('fails when chrome-sandbox is missing from the deb data', () => {
    const { releaseDir } = buildDeb({ fillerFiles: 0, withSandbox: false });

    const result = runVerifier(releaseDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'agent-teams-ai_0.0.0_amd64.deb does not contain ./opt/Agent-Teams-AI/chrome-sandbox'
    );
  });

  it('checks the mode of the launcher entry itself, not of a path ending with it', () => {
    const { releaseDir } = buildDeb({
      fillerFiles: 0,
      launcherMode: 0o644,
      executableDecoyLauncher: true,
    });

    const result = runVerifier(releaseDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('/usr/bin/agent-teams-ai is not executable in');
  });

  it('fails on a truncated data archive even after the required entries were listed', () => {
    const { releaseDir } = buildDeb({ fillerFiles: 2_000, fillerFirst: false, truncateData: true });

    const result = runVerifier(releaseDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Listing data.tar.gz in');
    expect(result.stderr).not.toContain('does not contain');
  }, 60_000);
});
