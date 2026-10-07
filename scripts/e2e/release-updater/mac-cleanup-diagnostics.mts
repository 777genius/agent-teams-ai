import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const evidenceNames = [
  'TEST-mac-updater-evidence',
  'TEST-mac-old-evidence-older',
  'TEST-mac-old-evidence-fresh',
];

// Failure diagnostics never include app logs, homes, provider state or environment.
// Capturing these files cannot disable PF or signal a process after cleanup failed.
export async function captureMacCleanupDiagnostics(
  runnerTemp: string,
  evidenceName: string,
  outputName: string
) {
  assert(evidenceNames.includes(evidenceName));
  assert.equal(outputName, `TEST-mac-cleanup-diagnostics-${evidenceName}`);
  assert.equal(await realpath(runnerTemp), runnerTemp);
  const source = path.join(runnerTemp, evidenceName);
  const destination = path.join(runnerTemp, outputName);
  await mkdir(destination);
  let entries: string[];
  try {
    assert.equal(await realpath(source), source, 'Evidence directory must not redirect');
    entries = await readdir(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    entries = [];
  }
  const files = [];
  for (const name of entries.toSorted((a, b) => a.localeCompare(b, 'en'))) {
    if (name !== 'pf-baseline-active.conf' && !/^[1-9]\d*-\d{3,}-pf-[a-z0-9-]+\.log$/u.test(name))
      continue;
    const sourceFile = path.join(source, name);
    const metadata = await lstat(sourceFile);
    assert(metadata.isFile() && !metadata.isSymbolicLink(), 'PF evidence must be a regular file');
    assert(metadata.size <= 1_048_576, 'Unexpectedly large PF diagnostic file');
    await writeFile(path.join(destination, name), await readFile(sourceFile), { flag: 'wx' });
    files.push(name);
  }
  await writeFile(
    path.join(destination, 'diagnostics.json'),
    `${JSON.stringify({ evidenceName, files, cleanupPassed: false }, null, 2)}\n`,
    { flag: 'wx' }
  );
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.GITHUB_REPOSITORY, '777genius/agent-teams-ai');
  const runnerTemp = process.env.RUNNER_TEMP;
  const evidenceName = process.argv[2];
  assert(runnerTemp && evidenceName);
  await captureMacCleanupDiagnostics(
    runnerTemp,
    evidenceName,
    `TEST-mac-cleanup-diagnostics-${evidenceName}`
  );
}
