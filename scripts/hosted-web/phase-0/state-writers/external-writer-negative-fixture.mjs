#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reproduces the TeamTaskWriter failure model: the app's promise lock protects only app callbacks.
 * A separate process writes after the app read and before its atomic rename. The app then commits
 * stale bytes and erases the external update. The fixture succeeds only when that loss is observed.
 */
export async function runExternalWriterNegativeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-teams-w3-external-writer-'));
  const markerPath = join(root, '.agent-teams-phase-0-w3-fixture');
  const statePath = join(root, 'task.json');
  await writeFile(markerPath, 'marker-owned\n', { mode: 0o600 });
  await writeFile(
    statePath,
    JSON.stringify({ revision: 1, appValue: 'before', externalValue: 'before' })
  );

  try {
    const appSnapshot = JSON.parse(await readFile(statePath, 'utf8'));
    const childCode = [
      "const fs=require('node:fs');",
      'const p=process.argv[1];',
      "const value=JSON.parse(fs.readFileSync(p,'utf8'));",
      "value.externalValue='written-by-external-process';",
      'value.revision+=1;',
      "fs.writeFileSync(p+'.external.tmp',JSON.stringify(value));",
      "fs.renameSync(p+'.external.tmp',p);",
    ].join('');
    const child = spawn(process.execPath, ['-e', childCode, statePath], { stdio: 'ignore' });
    const childExit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code));
    });
    if (childExit !== 0) throw new Error(`external fixture writer exited ${childExit}`);

    // This delay represents arbitrary work inside the in-process lock. It does not coordinate child.
    await delay(5);
    appSnapshot.appValue = 'written-by-app';
    appSnapshot.revision += 1;
    await writeFile(`${statePath}.app.tmp`, JSON.stringify(appSnapshot));
    await import('node:fs/promises').then(({ rename }) =>
      rename(`${statePath}.app.tmp`, statePath)
    );

    const finalState = JSON.parse(await readFile(statePath, 'utf8'));
    return {
      markerOwned: true,
      externalWriteCompleted: true,
      finalState,
      lostExternalUpdate: finalState.externalValue !== 'written-by-external-process',
      conclusion: 'app-only locking does not coordinate an external process',
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runExternalWriterNegativeFixture()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.lostExternalUpdate) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}
