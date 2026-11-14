#!/usr/bin/env node
// Explicit unpacked Windows executable runner. Never builds, installs dependencies,
// copies credentials, edits runtime manifests or launches agents/teams.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, readFile, writeFile, mkdir, lstat, opendir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { connect, createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  packagedArguments,
  packagedDrainSnapshot,
  packagedOrphanObservation,
} from './packaged.mjs';
import { settingsRefreshFailureSummary } from './packaged-verify.mjs';
import { assertV2SupportWarmReuse, prepareV2SupportRepair } from './v2-support-repair.mjs';
import {
  processes,
  listeners,
  sameIdentity,
  windowsCleanupEvidence,
  ownedTree,
} from './platform.mjs';

async function retainPackagedNativeCrash(data, run, runDir, owner, cleanupConfirmed) {
  if (!data.packaged || data.runtimeSetup !== 'app-install-v2-repair') return;
  const result = {
    schemaVersion: 1, observationOnly: true, run, state: 'unknown', phase: 'owner',
    pid: null, bootstrap: 'unavailable', entries: 0, totalBytes: 0, files: [],
  };
  const same = (left, right) =>
    left.isFile() && right.isFile() && !left.isSymbolicLink() && !right.isSymbolicLink() &&
    left.nlink === 1n && right.nlink === 1n && left.ino !== 0n &&
    left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
  const directory = async (selected) => {
    const info = await lstat(selected, { bigint: true });
    assert(info.isDirectory() && !info.isSymbolicLink() && info.ino !== 0n);
    assert.equal(path.relative(await realpath(selected), path.resolve(selected)), '');
    const after = await lstat(selected, { bigint: true });
    assert(after.isDirectory() && !after.isSymbolicLink());
    assert(info.dev === after.dev && info.ino === after.ino && info.birthtimeNs === after.birthtimeNs);
    return info;
  };
  const owned = new Map();
  const currentOwned = async () => {
    assert.equal(owned.size, 3);
    for (const [selected, original] of owned) {
      const now = await directory(selected);
      assert(now.dev === original.dev && now.ino === original.ino);
    }
  };
  const regular = async (selected, maxBytes) => {
    const before = await lstat(selected, { bigint: true });
    assert(same(before, before) && before.size > 0n && before.size <= BigInt(maxBytes));
    assert.equal(path.relative(await realpath(selected), path.resolve(selected)), '');
    const fd = await open(selected, 'r');
    try {
      assert(same(before, await fd.stat({ bigint: true })));
      const bytes = Buffer.alloc(Number(before.size));
      assert.equal((await fd.read(bytes, 0, bytes.length, 0)).bytesRead, bytes.length);
      assert(same(before, await fd.stat({ bigint: true })));
      assert(same(before, await lstat(selected, { bigint: true })));
      assert.equal(path.relative(await realpath(selected), path.resolve(selected)), '');
      return bytes;
    } finally {
      await fd.close();
    }
  };
  try {
    assert(cleanupConfirmed === true, 'Original physical cleanup required');
    assert(['cold', 'warm-1', 'warm-2', 'support-repair', 'support-repair-restart'].includes(run));
    assert(owner && Number.isSafeInteger(owner.pid) && owner.pid > 0);
    assert(typeof owner.birth === 'string' && Number.isFinite(Date.parse(owner.birth)));
    assert.equal(path.relative(owner.appPath, data.artifact.app.path), '');
    assert.equal(path.relative(path.join(data.root, 'user-data'), data.userData), '');
    assert.equal(path.relative(path.join(data.root, run), runDir), '');
    assert(path.basename(data.root).startsWith('opencode-diagnostics-e2e-'));
    for (const selected of [data.root, data.userData, runDir])
      owned.set(selected, await directory(selected));
    result.pid = owner.pid;
    result.phase = 'bootstrap';
    const bootstrap = JSON.parse(
      (await regular(path.join(data.root, 'native-crash-' + run + '.json'), 4096)).toString('utf8')
    );
    if (['started', 'refused', 'failed'].includes(bootstrap?.state))
      result.bootstrap = bootstrap.state;
    assert(bootstrap?.schemaVersion === 1 && bootstrap.observationOnly === true);
    assert(bootstrap.run === run && bootstrap.pid === owner.pid);
    assert(bootstrap.state === 'started' && bootstrap.uploadToServer === false);
    assert(typeof bootstrap.electronVersion === 'string' && bootstrap.electronVersion.length <= 32);
    assert(bootstrap.directory && typeof bootstrap.directory === 'object');
    const crashRoot = path.join(data.userData, 'crashes');
    const source = path.join(crashRoot, run);
    await directory(crashRoot);
    const original = await directory(source);
    assert(original.birthtimeNs >= BigInt(Date.parse(owner.birth)) * 1000000n);
    const current = async () => {
      await currentOwned();
      await directory(crashRoot);
      const info = await directory(source);
      assert.equal(info.dev.toString(), bootstrap.directory.device);
      assert.equal(info.ino.toString(), bootstrap.directory.inode);
      assert.equal(info.birthtimeNs.toString(), bootstrap.directory.birthtimeNs);
      assert(info.dev === original.dev && info.ino === original.ino);
    };
    await current();
    result.phase = 'reports';
    const destination = path.join(runDir, 'native-crash');
    let outputDirectory;
    const walk = async (selected, depth) => {
      if (depth > 4) {
        result.state = 'unknown-truncated';
        throw new Error('Diagnostic directory bound');
      }
      await current();
      const before = await directory(selected);
      const names = [];
      const entries = await opendir(selected, { bufferSize: 1 });
      try {
        for (;;) {
          if (result.entries >= 128) {
            result.state = 'unknown-truncated';
            throw new Error('Diagnostic entry bound');
          }
          const entry = await entries.read();
          if (!entry) break;
          result.entries += 1;
          names.push(entry.name);
        }
      } finally {
        await entries.close();
      }
      for (const name of names.sort()) {
        assert(/^[A-Za-z0-9_.-]{1,128}$/.test(name) && name !== '.' && name !== '..');
        const file = path.join(selected, name);
        const info = await lstat(file, { bigint: true });
        assert(!info.isSymbolicLink());
        if (info.isDirectory()) {
          await walk(file, depth + 1);
          continue;
        }
        assert(info.isFile());
        if (!name.toLowerCase().endsWith('.dmp')) continue;
        if (
          result.files.length >= 8 || info.size > 32n * 1024n * 1024n ||
          BigInt(result.totalBytes) + info.size > 64n * 1024n * 1024n
        ) {
          result.state = 'unknown-truncated';
          throw new Error('Diagnostic dump bound');
        }
        const bytes = await regular(file, Math.min(32 * 1024 * 1024, 64 * 1024 * 1024 - result.totalBytes));
        assert(bytes.length >= 32 && bytes.subarray(0, 4).equals(Buffer.from('MDMP')));
        await current();
        await directory(runDir);
        if (!outputDirectory) {
          await mkdir(destination, { mode: 0o700 });
          outputDirectory = await directory(destination);
        }
        const outputNow = await directory(destination);
        assert(outputNow.dev === outputDirectory.dev && outputNow.ino === outputDirectory.ino);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const staged = String(result.files.length + 1) + '-' + sha256 + '.dmp';
        const targetPath = path.join(destination, staged);
        const target = await open(targetPath, 'wx', 0o600);
        let created;
        try {
          created = await target.stat({ bigint: true });
          assert(same(created, created));
          await target.writeFile(bytes);
          const written = await target.stat({ bigint: true });
          assert(written.dev === created.dev && written.ino === created.ino);
          assert(written.size === BigInt(bytes.length));
          assert(same(written, await lstat(targetPath, { bigint: true })));
          assert.equal(path.relative(await realpath(targetPath), targetPath), '');
          await current();
          const after = await directory(destination);
          assert(after.dev === outputDirectory.dev && after.ino === outputDirectory.ino);
          await target.close();
        } catch (error) {
          try { await target.close(); } catch { /* Keep the original diagnostic failure. */ }
          try {
            await currentOwned();
            const after = await directory(destination);
            assert(after.dev === outputDirectory.dev && after.ino === outputDirectory.ino);
            const failed = await lstat(targetPath, { bigint: true });
            assert.equal(path.relative(await realpath(targetPath), targetPath), '');
            if (created && same(failed, failed) && failed.dev === created.dev && failed.ino === created.ino)
              await unlink(targetPath);
          } catch { /* Never claim that an incomplete staged file was retained. */ }
          throw error;
        }
        result.files.push({
          relativePath: path.relative(source, file).split(path.sep).join('/'),
          staged, bytes: bytes.length, sha256,
        });
        result.totalBytes += bytes.length;
      }
      const after = await directory(selected);
      assert(before.dev === after.dev && before.ino === after.ino);
    };
    await walk(source, 0);
    await current();
    result.state = result.files.length ? 'retained' : 'absent';
    result.phase = 'complete';
  } catch {
    // This observation never changes the original verification or cleanup result.
  }
  try {
    await currentOwned();
    const serialized = JSON.stringify(result) + '\n';
    if (Buffer.byteLength(serialized, 'utf8') <= 16384)
      await writeFile(path.join(runDir, 'native-crash.json'), serialized, {
        flag: 'wx', mode: 0o600,
      });
  } catch {
    // Retention/serialization failure cannot replace the first native failure.
  }
}

const args = process.argv.slice(2);
const options = packagedArguments(args); // Validate before creating a profile or launching anything.
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
const runs = ['cold', 'warm-1', 'warm-2', ...(options.runtimeSetup === 'app-install-v2-repair'
  ? ['support-repair', 'support-repair-restart'] : [])];
const passed = () => results.length === runs.length && results.every((r) => r.passed && r.cleanup);
const saveResults = () => writeFile(path.join(root, 'packaged-runs.json'), JSON.stringify({
  passed: passed(), providerQualified: passed() && results.every((r) => r.providerQualified), results,
}, null, 2));
let cleanupFailed = false;
for (const run of runs) {
  const runDir = path.join(root, run);
  await mkdir(runDir);
  const data = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert(!data.launcher, 'Previous ownership manifest must be retired only after verified cleanup');
  if (run === 'support-repair') {
    try {
      assert(results.length === 3 && results.every((r) => r.passed && r.cleanup),
        'Repair requires three successful owned cold/warm runs');
      data.supportRepair = await prepareV2SupportRepair(data);
    } catch (error) {
      results.push({ run, passed: false, cleanup: true, error: String(error) });
      await saveResults();
      break;
    }
  }
  data.run = run;
  delete data.diagnosticLineage;
  delete data.diagnosticLineageCollectionFailed;
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
    if (verified.status !== 0) {
      const evidencePath = path.join(runDir, 'evidence.json');
      try {
        const leaf = await lstat(evidencePath);
        assert(leaf.isFile() && !leaf.isSymbolicLink() && leaf.size <= 4 * 1024 * 1024);
        const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
        if (typeof evidence.error === 'string')
          result.verificationError = evidence.error.slice(0, 2000);
        const failure = settingsRefreshFailureSummary(evidence.settingsRefreshFailure);
        if (failure) {
          result.settingsRefreshFailure = failure;
          console.error(
            `[opencode-packaged] ${run}: ${failure.phase}/${failure.category}/${failure.cause}; evidence: ${evidencePath}`
          );
        }
      } catch {
        // Diagnostic collection never replaces the original verification failure.
      }
    }
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
    if (options.runtimeSetup === 'app-install-v2-repair') result.v2Support = evidence.v2Support;
    if (run === 'support-repair') result.repairedSupport = evidence.v2Support;
    result.passed = true;
  } catch (error) {
    result.error = String(error);
  } finally {
    let history;
    let crashOwner;
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
        const app = history.expected.filter(
          (p) =>
            p.parent === ownedManifest.launcher.pid &&
            p.executable?.toLowerCase() === ownedManifest.artifact.app.path.toLowerCase()
        );
        if (
          app.length === 1 &&
          Number.isSafeInteger(app[0].pid) &&
          app[0].pid > 0 &&
          typeof app[0].birth === 'string' &&
          Number.isFinite(Date.parse(app[0].birth))
        ) {
          crashOwner = {
            pid: app[0].pid,
            birth: app[0].birth,
            appPath: ownedManifest.artifact.app.path,
          };
        }
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
        // Metadata-only census may expose an unobserved child of an exited helper.
        // It never extends the exact identities authorized for cleanup.
        try {
          const latest = JSON.parse(await readFile(manifestPath, 'utf8'));
          await writeFile(
            path.join(runDir, 'cleanup-lineage.json'),
            JSON.stringify(
              {
                at: Date.now(),
                lineage: latest.diagnosticLineage ?? null,
                lineageCollectionFailed: latest.diagnosticLineageCollectionFailed === true,
                ...packagedOrphanObservation(latest.diagnosticLineage?.records ?? [], processes()),
              },
              null,
              2
            )
          );
        } catch {
          try {
            await writeFile(
              path.join(runDir, 'cleanup-lineage.json'),
              JSON.stringify({ observationOnly: true, collectionFailed: true })
            );
          } catch {
            /* Observation failure cannot replace the original failed drain. */
          }
        }
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
      if (result.passed && options.runtimeSetup === 'app-install-v2-repair') {
        if (run === 'cold') {
          assert(!current.v2SupportCold, 'Cold support baseline already exists');
          assertV2SupportWarmReuse(result.v2Support, result.v2Support);
          current.v2SupportCold = result.v2Support;
        } else if (run === 'warm-1' || run === 'warm-2') {
          assertV2SupportWarmReuse(current.v2SupportCold, result.v2Support);
        }
      }
      if (run === 'support-repair' && result.passed)
        current.supportRepair.after = result.repairedSupport;
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
    if (!result.passed || !result.cleanup) {
      let crash = { observationOnly: true, state: 'unknown-no-captured-app-identity' };
      try {
        if (crashOwner && crashOwner.appPath.length <= 1024) {
          const input = Buffer.from(
            JSON.stringify({ ...crashOwner, until: new Date().toISOString() })
          ).toString('base64');
          const script = String.raw`
$ErrorActionPreference = 'Stop'
$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}')) | ConvertFrom-Json
$start = [DateTime]::Parse($t.birth, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
$end = [DateTime]::Parse($t.until, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
try {
  $events = @(Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000,1001; StartTime=$start; EndTime=$end} -MaxEvents 64 -ErrorAction Stop)
} catch {
  if ($_.FullyQualifiedErrorId -ceq 'NoMatchingEventsFound,Microsoft.PowerShell.Commands.GetWinEventCommand') { $events = @() }
  else { throw }
}
if ($events.Count -ge 64) { @{observationOnly=$true;state='unknown-truncated';count=64} | ConvertTo-Json -Compress; exit }
$errors = @(); $reports = @(); $unknown = 0
foreach ($event in $events) {
  if (!$event.TimeCreated -or $event.TimeCreated.ToUniversalTime() -lt $start -or $event.TimeCreated.ToUniversalTime() -gt $end) { $unknown++; continue }
  $xml = $event.ToXml()
  if ($xml.Length -gt 32768) { $unknown++; continue }
  $fields = @{}; $valid = $true
  foreach ($entry in ([xml]$xml).Event.EventData.Data) {
    $name = [string]$entry.Name
    if (!$name -or $fields.ContainsKey($name)) { $valid=$false; break }
    $fields[$name] = [string]$entry.'#text'
  }
  if (!$valid) { $unknown++; continue }
  if ($event.Id -eq 1000 -and $event.ProviderName -ceq 'Application Error') {
    if ($fields.ProcessId -notmatch '^0[xX][0-9a-fA-F]{1,8}$' -or $fields.ProcessCreationTime -notmatch '^0[xX][0-9a-fA-F]{1,16}$' -or !$fields.AppPath) { $unknown++; continue }
    try {
      $pidValue = [Convert]::ToUInt32($fields.ProcessId.Substring(2),16)
      $birthValue = [DateTime]::FromFileTimeUtc([Convert]::ToInt64($fields.ProcessCreationTime.Substring(2),16))
    } catch { $unknown++; continue }
    if ($pidValue -ne $t.pid -or ($birthValue.Ticks - ($birthValue.Ticks % 10)) -ne $start.Ticks -or ![String]::Equals($fields.AppPath,$t.appPath,[StringComparison]::OrdinalIgnoreCase)) { continue }
    $module = [IO.Path]::GetFileName($fields.ModuleName)
    if ($module -notmatch '^[A-Za-z0-9_.-]{1,128}$') { $module=$null }
    $version = $fields.ModuleVersion
    if ($version -notmatch '^\d{1,6}(\.\d{1,6}){0,3}$') { $version=$null }
    $exception = $fields.ExceptionCode
    if ($exception -notmatch '^(0x)?[0-9a-fA-F]{8}$') { $exception=$null }
    $offset = $fields.FaultingOffset
    if ($offset -notmatch '^(0x)?[0-9a-fA-F]{1,16}$') { $offset=$null }
    $guid = [Guid]::Empty; $report=$null
    if ([Guid]::TryParse($fields.IntegratorReportId,[ref]$guid) -and $guid -ne [Guid]::Empty) { $report=$guid.ToString() }
    $errors += @{eventId=1000;recordId=$event.RecordId;at=$event.TimeCreated.ToUniversalTime().ToString('o');moduleName=$module;moduleVersion=$version;exceptionCode=$exception;faultingOffset=$offset;integratorReportId=$report}
  } elseif ($event.Id -eq 1001 -and $event.ProviderName -ceq 'Windows Error Reporting') {
    $guid = [Guid]::Empty
    if ([Guid]::TryParse($fields.ReportId,[ref]$guid) -and $guid -ne [Guid]::Empty) {
      $reports += @{eventId=1001;recordId=$event.RecordId;at=$event.TimeCreated.ToUniversalTime().ToString('o');reportId=$guid.ToString()}
    } else { $unknown++ }
  } else { $unknown++ }
}
$ids = @($errors | ForEach-Object { $_.integratorReportId } | Where-Object { $_ })
@{observationOnly=$true;state='bounded-query';event1000=@($errors);event1001=@($reports | Where-Object {$ids -contains $_.reportId});unknownSchemaCount=$unknown} | ConvertTo-Json -Depth 5 -Compress
`;
          const queried = spawnSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-EncodedCommand',
              Buffer.from(script, 'utf16le').toString('base64'),
            ],
            { encoding: 'utf8', timeout: 5000, maxBuffer: 65536, windowsHide: true }
          );
          if (queried.status === 0 && Buffer.byteLength(queried.stdout) <= 65536)
            crash = JSON.parse(queried.stdout);
          else
            crash = {
              observationOnly: true,
              state:
                queried.error?.code === 'ETIMEDOUT'
                  ? 'unknown-query-timeout'
                  : 'unknown-query-failed',
            };
        }
      } catch {
        crash = { observationOnly: true, state: 'unknown-collection-failed' };
      }
      try {
        await writeFile(
          path.join(root, `crash-observation-${run}.json`),
          JSON.stringify(crash, null, 2)
        );
      } catch {
        /* Diagnostic retention cannot replace the original failure or cleanup decision. */
      }
      try {
        await retainPackagedNativeCrash(data, run, runDir, crashOwner, result.cleanup);
      } catch {
        /* No diagnostic failure may replace the original result or cleanup decision. */
      }
    }
    await log.close();
    await saveResults();
  }
  if (cleanupFailed) break;
}
for (const result of results) {
  console.log('[opencode-packaged] result ' + JSON.stringify({
    run: result.run, passed: result.passed, cleanup: result.cleanup,
    qualification: result.qualification, providerQualified: result.providerQualified,
    verificationError: result.verificationError,
    error: typeof result.error === 'string' ? result.error.slice(0, 2000) : undefined,
    cleanupError: typeof result.cleanupError === 'string' ? result.cleanupError.slice(0, 2000) : undefined,
    launchError: typeof result.launchError === 'string' ? result.launchError.slice(0, 2000) : undefined,
  }));
}
process.exitCode = passed() ? 0 : 1;
