import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { treeHash } from '../../packages/legacy-agent-host/tests/fixtures/native-host.ts';
import { fileDigest } from './desktop-backend-fixture.ts';
import { desktopProofSources } from './desktop-proof-sources.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const row = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  assert.equal(typeof value, 'string');
  return value as string;
};
const hash = (value: unknown): string => {
  const result = text(value);
  assert.match(result, /^[a-f0-9]{64}$/);
  return result;
};
const json = async (path: string) => row(JSON.parse(await readFile(path, 'utf8')));
const jsonRows = (content: string) => content.split('\n').flatMap(line => {
  try { return line.startsWith('{') ? [row(JSON.parse(line))] : []; }
  catch { return []; }
});
async function pinned(value: unknown, maximumBytes = 512 * 1024 * 1024) {
  const valueRow = row(value), path = text(valueRow.path), sha256 = hash(valueRow.sha256);
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= maximumBytes);
  assert.equal(await realpath(path), path);
  assert.equal(await fileDigest(path), sha256);
  return { path, sha256 };
}

/** Separate controlled-native cold UI window, after the original P7 freeze has finished. */
export async function qualifyProcessColdUi(p7LogPath: string, p7LogSha256: string) {
  assert.equal(process.env.LEGACY_PROCESS_COLD_UI_GO, '1');
  for (const key of ['LEGACY_M19_ORIGINAL_HOST_CRASH_GO', 'LEGACY_M19_PROVIDER_UI_GO',
    'LEGACY_DESKTOP_READBACK_ROOT', 'LEGACY_M19_COLD_UI_ACTION'])
    assert.equal(process.env[key], undefined, 'controlled proof never continues a historical native/crash run');
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  assert.equal(process.version, 'v24.21.0');
  const logPin = await pinned({ path: p7LogPath, sha256: p7LogSha256 }, 16 * 1024 * 1024);
  const originalResults = jsonRows(await readFile(logPin.path, 'utf8'))
    .filter(value => typeof value.root === 'string' && typeof value.receipt === 'string');
  assert.equal(originalResults.length, 1, 'one original final P7 result; no glob or retry selection');
  const original = originalResults[0]!;
  assert.equal(original.status, 'PASS');
  const root = text(original.root), p7ReceiptPath = text(original.receipt);
  assert.match(root, /^\/private\/tmp\/TEST-stage1-p7-[^/]+$/);
  assert.equal(await realpath(root), root);
  assert.equal(p7ReceiptPath, join(root, 'p7-receipt.json'));
  const p7Pin = await pinned({ path: p7ReceiptPath, sha256: await fileDigest(p7ReceiptPath) }, 4 * 1024 * 1024);
  const p7 = await json(p7Pin.path);
  assert.equal(p7.status, 'PASS'); assert.equal(p7.root, root);
  assert.equal(row(p7.sourceFreeze).status, 'PASS', 'original P7 freeze window is already closed');
  for (const stage of ['kernel', 'normalSdk', 'packed']) assert.equal(row(p7[stage]).status, 'PASS');
  assert.equal(p7.gitSha, execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim());
  if (process.env.GITHUB_SHA) assert.equal(p7.gitSha, process.env.GITHUB_SHA);
  const frozen = row(p7.frozenInputs);
  assert.ok(Array.isArray(frozen.files));
  const frozenFiles = frozen.files.map(row);
  const originalPin = async (path: string) => {
    const matches = frozenFiles.filter(value => value.path === path);
    assert.equal(matches.length, 1, 'selected input belongs to the original successful P7 window');
    return pinned(matches[0]);
  };
  const capturePin = await originalPin(join(root, 'normal-sdk-capture.json'));
  const capture = await json(capturePin.path);
  assert.equal(capture.schemaVersion, 1);
  const node = await pinned(capture.node), host = await pinned(capture.host), claude = await pinned(capture.claude);
  assert.equal(node.path, await realpath(process.execPath));
  assert.equal(node.path, await realpath(join(repository, 'resources/legacy-agent-host/node/v24.21.0/darwin-arm64/node')));
  assert.equal(host.path, await realpath(join(repository, 'packages/legacy-agent-host/dist/cli.js')));
  const corepack = row(capture.corepack);
  const entry = await pinned(corepack.entry), packagePin = await pinned(corepack.package), library = await pinned(corepack.library);
  const artifact = row(capture.processArtifact);
  assert.equal(artifact.directory, join(root, 'process-artifact'));
  const manifest = await originalPin(join(text(artifact.directory), 'manifest.json'));
  assert.equal(manifest.sha256, hash(artifact.manifestSha256));
  const modulePin = await originalPin(join(text(artifact.directory), 'registered-process.node'));
  assert.equal(modulePin.sha256, hash((await json(manifest.path)).binarySha256));
  const pins = [logPin, p7Pin, capturePin, node, host, claude, entry, packagePin, library, manifest, modulePin];
  const verifyInputs = async () => {
    for (const pin of pins) await pinned(pin);
    assert.equal(await treeHash(join(repository, 'packages/legacy-agent-host/src'), '.ts'), hash(row(capture.host).sourceSha256));
    assert.equal(await treeHash(join(repository, 'packages/legacy-agent-host/dist'), '.js'), hash(row(capture.host).distSha256));
  };
  await verifyInputs();
  const oraclePath = join(root, 'cold-ui-runner-oracle.json'), logPath = join(root, 'cold-ui.log');
  const oracle: Record<string, unknown> = {
    schemaVersion: 1, status: 'INCOMPLETE', root,
    scope: 'Controlled original native TEST child registration, real Host restart and existing ProcessesSection Stop; no SDK cold survival',
    originalP7: p7Pin, originalP7Log: logPin, capture: capturePin, processModule: modulePin,
    p7FreezeWindow: 'Completed before this separate source Desktop proof; compiled Desktop outputs may change during dev startup',
    original911Unchanged: true, publication: false,
  };
  await writeFile(oraclePath, JSON.stringify(oracle, null, 2), { flag: 'wx', mode: 0o600 });
  const fd = openSync(logPath, 'wx', 0o600);
  let failure: unknown;
  try {
    execFileSync(node.path, [join(import.meta.dirname, 'desktop-backend-smoke.ts')], {
      cwd: repository, stdio: ['ignore', fd, fd],
      env: { HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), PATH: dirname(node.path) + ':/usr/bin:/bin', NO_COLOR: '1',
        LEGACY_DESKTOP_BACKEND_GO: '1', LEGACY_PROCESS_COLD_UI_GO: '1',
        LEGACY_DESKTOP_PROOF_MODE: 'process-cold-ui',
        LEGACY_DESKTOP_PROCESS_CAPTURE_PATH: capturePin.path, LEGACY_DESKTOP_PROCESS_CAPTURE_SHA256: capturePin.sha256,
        LEGACY_DESKTOP_NODE_SHA256: node.sha256, LEGACY_DESKTOP_HOST_ENTRY_SHA256: host.sha256,
        LEGACY_DESKTOP_PNPM_PATH: entry.path, LEGACY_DESKTOP_PNPM_SHA256: entry.sha256,
        LEGACY_DESKTOP_COREPACK_PACKAGE_SHA256: packagePin.sha256, LEGACY_DESKTOP_COREPACK_LIBRARY_SHA256: library.sha256,
      },
    });
    const records = jsonRows(await readFile(logPath, 'utf8'));
    const prepared = records.filter(value => value.phase === 'prepared');
    assert.equal(prepared.length, 1, 'one original controlled Desktop proof');
    const receiptPath = text(prepared[0]!.receipt);
    assert.ok(receiptPath.startsWith(join(root, 'tmp', 'TEST-desktop-backend-')));
    assert.match(receiptPath, /\/TEST-desktop-backend-[^/]+\/desktop-backend-receipt\.json$/);
    const receiptPin = await pinned({ path: receiptPath, sha256: await fileDigest(receiptPath) }, 8 * 1024 * 1024);
    const receipt = await json(receiptPath);
    assert.equal(receipt.root, dirname(receiptPath));
    assert.equal(receipt.mode, 'process-cold-ui'); assert.equal(receipt.status, 'PASS');
    const final = records.filter(value => value.receipt === receiptPath && value.status === 'PASS');
    assert.equal(final.length, 1, 'one original final successful Desktop result');
    const proof = row(receipt.controlledProcessColdUi), ui = row(receipt.nativeProcessUi);
    assert.equal(proof.status, 'PASS'); assert.equal(ui.status, 'PASS');
    assert.equal(ui.stopQualification, 'COMPLETED_ORIGINAL_REF_STOP');
    assert.equal(ui.runtimeCustody, 'NOT_ALLOCATED');
    assert.equal(proof.runtimeCustody, 'NOT_ALLOCATED');
    assert.deepEqual(ui.nativeRuntimeAllocation, { providerSessions: 0, inputs: 0, modelServers: 0 });
    const hostA = row(proof.hostA), cleanup = row(proof.cleanup);
    assert.equal(hostA.exitCode, 0); assert.equal(hostA.signalCode, null); assert.equal(hostA.writerLockReleased, true);
    assert.equal(row(proof.hostB).distinctFromHostA, true);
    const stopped = row(row(proof.stoppedHistory).stop);
    assert.equal(stopped.commandId, row(ui.terminalStop).commandId);
    assert.equal(stopped.processRef, proof.originalProcessRef);
    assert.equal(row(ui.stoppedOwnerRead).observation, 'absent');
    assert.equal(row(ui.stoppedOwnerRead).canTerminate, false);
    assert.equal(row(ui.stoppedRenderedRow).killCount, 0);
    assert.equal(cleanup.status, 'PASS'); assert.equal(cleanup.rootExitCode, 0); assert.equal(cleanup.rootSignalCode, null);
    for (const key of ['originalTargetObservation', 'originalNeighborObservation', 'originalRootObservation'])
      assert.equal(cleanup[key], 'absent');
    assert.equal(cleanup.primaryCleanupSignals, 0); assert.equal(cleanup.neighborCleanupSignals, 1);
    assert.equal(proof.neighborHealthyBeforeCleanup, true);
    const sourceBefore = receipt.selectedSourceHashesBeforeApp, sourceAfter = receipt.selectedSourceHashesAfterFlow;
    assert.ok(Array.isArray(sourceBefore)); assert.deepEqual(sourceAfter, sourceBefore);
    assert.deepEqual(sourceBefore.map(value => text(row(value).path)), desktopProofSources);
    for (const pin of sourceBefore.map(row)) {
      const path = join(repository, text(pin.path));
      assert.equal(await fileDigest(path), hash(pin.sha256));
      assert.equal((await originalPin(path)).sha256, pin.sha256, 'same source composition as original P7');
    }
    oracle.desktopReceipt = receiptPin;
    oracle.selectedSourcePins = sourceBefore.length;
    oracle.sourceBeforeAfterUnchanged = true;
    oracle.positiveStopQualification = ui.stopQualification;
    oracle.cleanup = cleanup;
    oracle.status = 'PASS';
  } catch (error) { failure = error; }
  finally {
    closeSync(fd);
    try { await verifyInputs(); oracle.originalP7InputsUnchanged = true; }
    catch (error) { failure ??= error; oracle.originalP7InputsUnchanged = false; }
    if (failure) { oracle.status = 'INCOMPLETE'; oracle.failure = failure instanceof Error ? failure.message : String(failure); }
    oracle.log = { path: logPath, sha256: await fileDigest(logPath) };
    await writeFile(oraclePath, JSON.stringify(oracle, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ root, receipt: oraclePath, status: oracle.status }));
  }
  if (failure) throw failure;
  return { root, receipt: oraclePath, status: 'PASS' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [logPath, logSha256, ...extra] = process.argv.slice(2);
  assert.ok(logPath && logSha256 && extra.length === 0,
    'Usage: node qualify-process-cold-ui.ts ORIGINAL_P7_LOG SHA256');
  await qualifyProcessColdUi(logPath, logSha256);
}
