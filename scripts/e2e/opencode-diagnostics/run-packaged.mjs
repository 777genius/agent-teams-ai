#!/usr/bin/env node
// Explicit unpacked Windows executable runner. Never builds, installs dependencies,
// copies credentials, edits runtime manifests or launches agents/teams.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { open, readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { connect, createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { packagedArguments, packagedDrainSnapshot } from './packaged.mjs';
import {
  processes,
  listeners,
  sameIdentity,
  windowsCleanupEvidence,
  ownedTree,
} from './platform.mjs';

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
    let history;
    const observeHistory = () => {
      const current = processes();
      return history.expected.map((expected) => {
        const live = current.find((p) => p.pid === expected.pid);
        return {
          expected,
          state: !live
            ? 'absent-from-census'
            : !expected.birth || !live.birth
              ? 'unknown'
              : expected.birth !== live.birth
                ? 'pid-reused'
                : expected.executable &&
                    live.executable &&
                    expected.executable.toLowerCase() !== live.executable.toLowerCase()
                  ? 'executable-changed'
                  : 'same-birth-present',
          current: live
            ? {
                pid: live.pid,
                parent: live.parent,
                birth: live.birth,
                executable: live.executable ?? null,
              }
            : null,
        };
      });
    };
    try {
      // Capture identity set before stop. Never kill by executable name, port, or /T.
      const ownedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(ownedManifest, null, 2));
      try {
        const current = ownedTree(processes(), ownedManifest.launcher);
        const prior = ownedManifest.observedProcesses ?? [];
        assert(prior.length + current.length <= 500, 'Historical diagnostic bound exceeded');
        const union = [...prior, ...current].filter(
          (entry, index, all) =>
            all.findIndex((p) => p.pid === entry.pid && p.birth === entry.birth) === index
        );
        history = {
          at: Date.now(),
          observationOnly: true,
          expected: union.map((p) => ({
            pid: p.pid,
            parent: p.parent,
            birth: p.birth,
            executable: p.executable ?? null,
          })),
        };
        history.beforeStop = observeHistory();
        await writeFile(
          path.join(runDir, 'cleanup-history.json'),
          JSON.stringify(history, null, 2)
        );
      } catch {
        history = { observationOnly: true, collectionFailed: true };
      }
      const stopped = command('stop', [root], 60000);
      await writeFile(path.join(runDir, 'stop.txt'), stopped.stdout + stopped.stderr);
      assert.equal(stopped.status, 0, 'Manifest-owned cleanup refused');
      try {
        const receiptPath = path.join(root, 'cleanup-graceful.json');
        const leaf = await lstat(receiptPath);
        assert(leaf.isFile() && !leaf.isSymbolicLink() && leaf.size <= 1024 * 1024);
        const after = JSON.parse(await readFile(receiptPath, 'utf8')).afterClose;
        assert(
          history?.expected &&
            after?.observationOnly === true &&
            Number.isFinite(after.at) &&
            after.at >= history.at &&
            after.at <= Date.now()
        );
        assert(
          Array.isArray(after.known) &&
            after.known.length <= 500 &&
            Array.isArray(after.descendants) &&
            after.descendants.length <= 500
        );
        const valid = (p) =>
          p &&
          Number.isSafeInteger(p.pid) &&
          p.pid > 0 &&
          Number.isSafeInteger(p.parent) &&
          p.parent >= 0 &&
          typeof p.birth === 'string' &&
          p.birth.length <= 64 &&
          Number.isFinite(Date.parse(p.birth)) &&
          (p.executable === null ||
            (typeof p.executable === 'string' && p.executable.length <= 4096));
        const known = after.known.map((record) => record.expected);
        assert(
          known.every(
            (p) =>
              valid(p) &&
              history.expected.some(
                (previous) =>
                  previous.pid === p.pid &&
                  previous.birth === p.birth &&
                  previous.executable === p.executable
              )
          )
        );
        assert(after.descendants.every(valid));
        const lineage = [ownedManifest.launcher];
        for (let index = 0; index < lineage.length; index++) {
          for (const p of after.descendants) {
            if (
              p.parent === lineage[index].pid &&
              Date.parse(p.birth) >= Date.parse(lineage[index].birth) &&
              !lineage.some((parent) => parent.pid === p.pid)
            )
              lineage.push(p);
          }
        }
        assert(
          after.descendants.every((p) =>
            lineage.some(
              (parent) =>
                parent.pid === p.pid &&
                parent.birth === p.birth &&
                parent.executable === p.executable
            )
          )
        );
        const union = [...history.expected, ...known, ...after.descendants].filter(
          (p, index, all) =>
            all.findIndex((previous) => previous.pid === p.pid && previous.birth === p.birth) ===
            index
        );
        assert(union.length <= 500);
        history.expected = union.map((p) => ({
          pid: p.pid,
          parent: p.parent,
          birth: p.birth,
          executable: p.executable,
        }));
        history.afterCloseReceipt = {
          at: after.at,
          source: 'cleanup-graceful.json/afterClose',
          observationOnly: true,
        };
      } catch {
        if (history) history.afterCloseCollectionFailed = true;
      }
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
      let drain;
      do {
        drain = packagedDrainSnapshot(identities, processes(), listeners());
        if (drain.drained) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      } while (Date.now() < deadline);
      await writeFile(
        path.join(runDir, 'cleanup.json'),
        JSON.stringify(
          {
            at: new Date().toISOString(),
            ...drain,
          },
          null,
          2
        )
      );
      if (!drain.drained) {
        let diagnostic;
        try {
          diagnostic = windowsCleanupEvidence([
            ...new Set([
              ...identities.map((p) => p.pid),
              ...drain.listenerPids,
              ...(history?.expected ?? []).map((p) => p.pid),
            ]),
          ]);
        } catch (error) {
          diagnostic = { collectionError: String(error) };
        }
        try {
          const loopback = [];
          for (const operation of ['connect', 'exclusive-bind']) {
            loopback.push(
              ...(await Promise.all(
                ['127.0.0.1', '::1'].map(
                  (host) =>
                    new Promise((resolve) => {
                      const startedAt = Date.now();
                      const controller = new AbortController();
                      let resource,
                        timer,
                        finished = false;
                      const finish = (outcome, code) => {
                        if (finished) return;
                        finished = true;
                        clearTimeout(timer);
                        controller.abort();
                        if (operation === 'connect') resource?.destroy();
                        else {
                          try {
                            resource?.close();
                          } catch {
                            /* Diagnostic resource cleanup cannot replace the original failed drain. */
                          }
                        }
                        resolve({
                          host,
                          port: 9222,
                          operation,
                          outcome,
                          code,
                          startedAt,
                          elapsedMs: Date.now() - startedAt,
                        });
                      };
                      timer = setTimeout(() => finish('timeout'), 1000);
                      try {
                        if (operation === 'connect') {
                          resource = connect({ host, port: 9222 });
                          resource.once('connect', () => finish('connected'));
                        } else {
                          resource = createServer((socket) => socket.destroy());
                          resource.once('listening', () => finish('bound'));
                          resource.listen({
                            host,
                            port: 9222,
                            exclusive: true,
                            ipv6Only: host === '::1',
                            signal: controller.signal,
                          });
                        }
                        resource.once('error', (error) =>
                          finish(
                            'error',
                            typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
                              ? error.code
                              : 'UNKNOWN'
                          )
                        );
                      } catch {
                        finish('collection_failed');
                      }
                    })
                )
              ))
            );
          }
          diagnostic = { ...diagnostic, loopback };
        } catch {
          diagnostic = { ...diagnostic, loopbackCollectionFailed: true };
        }
        await writeFile(path.join(runDir, 'cleanup-os.json'), JSON.stringify(diagnostic, null, 2));
      }
      assert(
        drain.drained,
        'Owned processes or CDP listener survived cleanup; refusing warm restart'
      );
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
    } finally {
      try {
        if (history?.expected) history.final = { at: Date.now(), records: observeHistory() };
        await writeFile(
          path.join(runDir, 'cleanup-history.json'),
          JSON.stringify(history ?? { observationOnly: true, collectionFailed: true }, null, 2)
        );
      } catch {
        /* Historical observation cannot replace the cleanup result. */
      }
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
