#!/usr/bin/env node
// Explicit unpacked Windows executable runner. Never builds, installs dependencies,
// copies credentials, edits runtime manifests or launches agents/teams.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { open, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packagedArguments } from './packaged.mjs';
import { processes, listeners, sameIdentity } from './platform.mjs';

const args = process.argv.slice(2);
packagedArguments(args); // Validate before creating a profile or launching anything.
const harness = fileURLToPath(new URL('../opencode-diagnostics-desktop.mjs', import.meta.url));
const command = (mode, rest, timeout = 30000) =>
  spawnSync(process.execPath, [harness, mode, ...rest], {
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
const seed = command('seed-packaged', args, 120000);
assert.equal(seed.status, 0, seed.stderr || String(seed.error));
const root = seed.stdout.trim();
console.log(`Packaged artifacts/profile: ${root}`);
const manifestPath = path.join(root, 'manifest.json');
const results = [];
let cleanupFailed = false;
for (const run of ['cold', 'warm-1', 'warm-2']) {
  const runDir = path.join(root, run);
  await mkdir(runDir);
  const data = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert(!data.launcher, 'Previous ownership manifest must be retired only after verified cleanup');
  data.run = run;
  await writeFile(manifestPath, JSON.stringify(data, null, 2));
  const log = await open(path.join(runDir, 'desktop.log'), 'a');
  const launcher = spawn(process.execPath, [harness, 'start', root], {
    stdio: ['ignore', log.fd, log.fd],
  });
  const result = { run, passed: false, cleanup: false };
  results.push(result);
  let exited = false;
  launcher.once('exit', () => {
    exited = true;
  });
  launcher.once('error', (error) => {
    exited = true;
    result.launchError = String(error);
  });
  try {
    const deadline = Date.now() + 120000;
    let inspection;
    do {
      assert(!exited, 'Owned launcher exited; see desktop.log');
      inspection = command('inspect', [root]);
      if (inspection.status === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } while (Date.now() < deadline);
    await writeFile(
      path.join(runDir, 'inspect.txt'),
      (inspection?.stdout || '') + (inspection?.stderr || '')
    );
    assert.equal(
      inspection?.status,
      0,
      'Packaged renderer unavailable; ownership/entrypoint checks were not bypassed'
    );
    const verified = command('verify', [root], 900000);
    await writeFile(path.join(runDir, 'verify.txt'), verified.stdout + verified.stderr);
    assert.equal(
      verified.status,
      0,
      `Packaged verification failed: ${verified.error || 'see evidence'}`
    );
    const evidence = JSON.parse(await readFile(path.join(runDir, 'evidence.json'), 'utf8'));
    assert.equal(evidence.passed, true);
    assert(['provider-inventory', 'transport-only'].includes(evidence.qualification));
    result.qualification = evidence.qualification;
    result.providerQualified = evidence.providerQualified === true;
    result.passed = true;
  } catch (error) {
    result.error = String(error);
  } finally {
    try {
      // Capture identity set before stop. Never kill by executable name, port, or /T.
      const ownedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(ownedManifest, null, 2));
      const stopped = command('stop', [root], 60000);
      await writeFile(path.join(runDir, 'stop.txt'), stopped.stdout + stopped.stderr);
      assert.equal(stopped.status, 0, 'Manifest-owned cleanup refused');
      // stop writes the exact identities it signalled; detect surviving owned children
      // even if Electron exited and they have since been reparented.
      const identities = JSON.parse(
        await readFile(path.join(root, 'cleanup-identities.json'), 'utf8')
      );
      await writeFile(
        path.join(runDir, 'cleanup-identities.json'),
        JSON.stringify(identities, null, 2)
      );
      const deadline = Date.now() + 15000;
      let alive;
      do {
        const snapshot = processes();
        alive = identities.filter((entry) =>
          snapshot.some((now) => now.pid === entry.pid && now.birth === entry.birth)
        );
        if (!alive.length) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      } while (Date.now() < deadline);
      assert.equal(alive.length, 0, 'Owned processes survived cleanup; refusing warm restart');
      const listenerPids = listeners();
      await writeFile(
        path.join(runDir, 'cleanup.json'),
        JSON.stringify(
          {
            at: new Date().toISOString(),
            ownedRemaining: alive,
            listenerPids,
          },
          null,
          2
        )
      );
      assert.equal(listenerPids.length, 0, 'Port occupied after cleanup; refusing warm restart');
      const current = JSON.parse(await readFile(manifestPath, 'utf8'));
      sameIdentity(ownedManifest.launcher, current.launcher);
      delete current.launcher;
      delete current.observedProcesses;
      await writeFile(manifestPath, JSON.stringify(current, null, 2));
      result.cleanup = true;
    } catch (error) {
      cleanupFailed = true;
      result.cleanupError = String(error);
      launcher.unref();
    }
    await log.close();
    await writeFile(
      path.join(root, 'packaged-runs.json'),
      JSON.stringify(
        {
          passed: results.length === 3 && results.every((r) => r.passed && r.cleanup),
          providerQualified:
            results.length === 3 &&
            results.every((r) => r.passed && r.cleanup && r.providerQualified),
          results,
        },
        null,
        2
      )
    );
  }
  if (cleanupFailed) break;
}
process.exitCode = results.length === 3 && results.every((r) => r.passed && r.cleanup) ? 0 : 1;
