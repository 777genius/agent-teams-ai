import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { captureMacCleanupDiagnostics } from './mac-cleanup-diagnostics.mts';

void test('failed cleanup diagnostics retain PF stderr and baseline without app or provider logs', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-mac-diagnostics-')));
  const sourceName = 'TEST-mac-old-evidence-fresh';
  const outputName = `TEST-mac-cleanup-diagnostics-${sourceName}`;
  try {
    const source = path.join(root, sourceName);
    await mkdir(source);
    const stderr = 'stderr:\npfctl: baseline syntax error\n';
    await writeFile(path.join(source, '7470-099-pf-restore-active-baseline.log'), stderr);
    await writeFile(path.join(source, 'pf-baseline-active.conf'), 'captured active baseline\n');
    await writeFile(path.join(source, 'app.log'), 'private app output');
    await writeFile(path.join(source, 'environment.json'), 'private environment');
    await writeFile(path.join(source, 'pf-owned.json'), 'private ownership data');
    await captureMacCleanupDiagnostics(root, sourceName, outputName);
    assert.deepEqual(
      (await readdir(path.join(root, outputName))).toSorted((a, b) => a.localeCompare(b, 'en')),
      ['7470-099-pf-restore-active-baseline.log', 'diagnostics.json', 'pf-baseline-active.conf']
    );
    assert.equal(
      await readFile(
        path.join(root, outputName, '7470-099-pf-restore-active-baseline.log'),
        'utf8'
      ),
      stderr
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('PF diagnostic paths cannot redirect to files outside the evidence directory', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-mac-diagnostics-')));
  const sourceName = 'TEST-mac-updater-evidence';
  try {
    await mkdir(path.join(root, sourceName));
    const privateFile = path.join(root, 'private.txt');
    await writeFile(privateFile, 'must not be copied');
    await symlink(privateFile, path.join(root, sourceName, 'pf-baseline-active.conf'));
    await assert.rejects(
      captureMacCleanupDiagnostics(root, sourceName, `TEST-mac-cleanup-diagnostics-${sourceName}`),
      /regular file/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
