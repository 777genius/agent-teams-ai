import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { cp, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
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
const text = (value: unknown): string => { assert.equal(typeof value, 'string'); return value as string; };
const hash = (value: unknown): string => { const result = text(value); assert.match(result, /^[a-f0-9]{64}$/); return result; };
const json = async (path: string) => row(JSON.parse(await readFile(path, 'utf8')));
const jsonRows = (content: string) => content.split('\n').flatMap(line => {
  try { return line.startsWith('{') ? [row(JSON.parse(line))] : []; } catch { return []; }
});
async function pinned(value: unknown, maximum = 512 * 1024 * 1024) {
  const pin = row(value), path = text(pin.path), sha256 = hash(pin.sha256), info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= maximum);
  assert.equal(await realpath(path), path); assert.equal(await fileDigest(path), sha256);
  return { path, sha256 };
}

/** Real cold Host/ProcessesSection positive Stop, separate from the completed genuine SDK window. */
export async function qualifyLinuxProcessColdUi(input: {
  output: string; sdkReceipt: string; sdkReceiptSha256: string; pnpmEntry: string;
}) {
  assert.equal(process.env.LEGACY_PROCESS_COLD_UI_GO, '1');
  for (const name of ['LEGACY_M19_ORIGINAL_HOST_CRASH_GO', 'LEGACY_M19_PROVIDER_UI_GO',
    'LEGACY_DESKTOP_READBACK_ROOT', 'LEGACY_M19_COLD_UI_ACTION']) assert.equal(process.env[name], undefined);
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  assert.equal(process.version, 'v24.21.0');
  assert.match(process.env.LEGACY_DESKTOP_TEST_DISPLAY ?? '', /^:\d+$/);
  assert.ok(process.env.LEGACY_DESKTOP_TEST_XAUTHORITY && process.env.LEGACY_DESKTOP_COREPACK_HOME);
  assert.match(input.output, /^\/(?:[^/]+\/)*TEST-[^/]+$/);
  await mkdir(input.output, { mode: 0o700 });
  const output = await realpath(input.output); assert.equal(output, input.output);
  for (const name of ['home', 'tmp']) await mkdir(join(output, name), { mode: 0o700 });
  const sdkReceipt = await pinned({ path: input.sdkReceipt, sha256: input.sdkReceiptSha256 }, 8 * 1024 * 1024);
  const sdk = await json(sdkReceipt.path);
  assert.equal(sdk.status, 'PASS'); assert.equal(sdk.sourceFreeze, 'PASS');
  assert.equal(sdk.platform, 'linux'); assert.equal(sdk.architecture, 'x64');
  assert.equal(row(sdk.native).status, 'NORMAL_SDK_PROCESS_STOP_OBSERVED');
  assert.ok(Array.isArray(sdk.pins) && Array.isArray(sdk.trees));
  const sourcePins = sdk.pins.map(row), trees = sdk.trees.map(row);
  const originalPin = async (path: string) => {
    const matches = sourcePins.filter(pin => pin.path === path);
    assert.equal(matches.length, 1, 'one exact input from the completed SDK window');
    return pinned(matches[0]);
  };
  const originalTree = (path: string) => {
    const matches = trees.filter(tree => tree.path === path); assert.equal(matches.length, 1);
    return hash(matches[0]!.sha256);
  };
  const node = await originalPin(await realpath(process.execPath));
  const hostPath = await realpath(join(repository, 'packages/legacy-agent-host/dist/cli.js'));
  const host = { ...await originalPin(hostPath),
    sourceSha256: originalTree(join(repository, 'packages/legacy-agent-host/src')),
    distSha256: originalTree(join(repository, 'packages/legacy-agent-host/dist')) };
  const claude = await pinned(sdk.claude), entry = await originalPin(await realpath(input.pnpmEntry));
  const packagePin = await originalPin(join(dirname(entry.path), '../package.json'));
  const library = await originalPin(join(dirname(entry.path), 'lib/corepack.cjs'));
  const capturePath = join(output, 'controlled-capture.json');
  await writeFile(capturePath, JSON.stringify({ schemaVersion: 1, platform: 'linux-x64', node, host, claude,
    corepack: { entry, package: packagePin, library }, processArtifact: sdk.selection }),
  { mode: 0o600, flag: 'wx' });
  const capture = await pinned({ path: capturePath, sha256: await fileDigest(capturePath) });
  const self = await pinned({ path: import.meta.filename, sha256: await fileDigest(import.meta.filename) });
  const verify = async () => {
    for (const pin of [sdkReceipt, self, capture, ...sourcePins]) await pinned(pin);
    for (const tree of trees) assert.equal(await treeHash(text(tree.path), text(tree.suffix)), hash(tree.sha256));
  };
  await verify();
  const receiptPath = join(output, 'cold-ui-receipt.json'), logPath = join(output, 'cold-ui.log');
  const proof: Record<string, unknown> = { schemaVersion: 1, status: 'INCOMPLETE', sdkReceipt, capture,
    scope: 'Linux controlled native services, cold Host restart, existing ProcessesSection original-ref Stop/history',
    sdkColdSurvivalClaim: false, packagedClaim: false, providerSessions: 0, wrapper: self };
  await writeFile(receiptPath, JSON.stringify(proof), { mode: 0o600, flag: 'wx' });
  const log = openSync(logPath, 'wx', 0o600);
  let failure: unknown;
  let fixtureRoot: string | undefined;
  try {
    execFileSync(node.path, [join(import.meta.dirname, 'desktop-backend-smoke.ts')], {
      cwd: repository, stdio: ['ignore', log, log], env: {
        HOME: join(output, 'home'), TMPDIR: join(output, 'tmp'), PATH: dirname(node.path) + ':/usr/bin:/bin', NO_COLOR: '1',
        LEGACY_DESKTOP_BACKEND_GO: '1', LEGACY_PROCESS_COLD_UI_GO: '1', LEGACY_DESKTOP_PROOF_MODE: 'process-cold-ui',
        LEGACY_DESKTOP_PROCESS_CAPTURE_PATH: capture.path, LEGACY_DESKTOP_PROCESS_CAPTURE_SHA256: capture.sha256,
        LEGACY_DESKTOP_NODE_SHA256: node.sha256, LEGACY_DESKTOP_HOST_ENTRY_SHA256: host.sha256,
        LEGACY_DESKTOP_PNPM_PATH: entry.path, LEGACY_DESKTOP_PNPM_SHA256: entry.sha256,
        LEGACY_DESKTOP_COREPACK_PACKAGE_SHA256: packagePin.sha256, LEGACY_DESKTOP_COREPACK_LIBRARY_SHA256: library.sha256,
        LEGACY_DESKTOP_COREPACK_HOME: process.env.LEGACY_DESKTOP_COREPACK_HOME,
        LEGACY_DESKTOP_TEST_DISPLAY: process.env.LEGACY_DESKTOP_TEST_DISPLAY,
        LEGACY_DESKTOP_TEST_XAUTHORITY: process.env.LEGACY_DESKTOP_TEST_XAUTHORITY,
      },
    });
    const records = jsonRows(await readFile(logPath, 'utf8'));
    const prepared = records.filter(value => value.phase === 'prepared'); assert.equal(prepared.length, 1);
    const desktopReceipt = text(prepared[0]!.receipt);
    assert.ok(desktopReceipt.startsWith(join(output, 'tmp', 'TEST-desktop-backend-')));
    assert.match(desktopReceipt, /\/TEST-desktop-backend-[^/]+\/desktop-backend-receipt\.json$/);
    fixtureRoot = dirname(desktopReceipt);
    const receipt = await json(desktopReceipt);
    assert.equal(receipt.mode, 'process-cold-ui'); assert.equal(receipt.status, 'PASS');
    assert.equal(records.filter(value => value.receipt === desktopReceipt && value.status === 'PASS').length, 1);
    const controlled = row(receipt.controlledProcessColdUi), ui = row(receipt.nativeProcessUi);
    assert.equal(controlled.status, 'PASS'); assert.equal(ui.status, 'PASS');
    assert.equal(ui.stopQualification, 'COMPLETED_ORIGINAL_REF_STOP');
    assert.equal(ui.runtimeCustody, 'NOT_ALLOCATED'); assert.equal(controlled.runtimeCustody, 'NOT_ALLOCATED');
    assert.deepEqual(ui.nativeRuntimeAllocation, { providerSessions: 0, inputs: 0, modelServers: 0 });
    const hostA = row(controlled.hostA), cleanup = row(controlled.cleanup);
    assert.equal(hostA.exitCode, 0); assert.equal(hostA.signalCode, null); assert.equal(hostA.writerLockReleased, true);
    assert.equal(row(controlled.hostB).distinctFromHostA, true);
    const stopped = row(row(controlled.stoppedHistory).stop);
    assert.equal(stopped.commandId, row(ui.terminalStop).commandId);
    assert.equal(stopped.processRef, controlled.originalProcessRef);
    assert.equal(row(ui.stoppedOwnerRead).observation, 'absent');
    assert.equal(row(ui.stoppedOwnerRead).canTerminate, false); assert.equal(row(ui.stoppedRenderedRow).killCount, 0);
    assert.equal(cleanup.status, 'PASS'); assert.equal(cleanup.rootExitCode, 0); assert.equal(cleanup.rootSignalCode, null);
    for (const key of ['originalTargetObservation', 'originalNeighborObservation', 'originalRootObservation'])
      assert.equal(cleanup[key], 'absent');
    assert.equal(cleanup.primaryCleanupSignals, 0); assert.equal(cleanup.neighborCleanupSignals, 1);
    assert.equal(controlled.neighborHealthyBeforeCleanup, true);
    const before = receipt.selectedSourceHashesBeforeApp;
    assert.ok(Array.isArray(before)); assert.deepEqual(receipt.selectedSourceHashesAfterFlow, before);
    assert.deepEqual(before.map(pin => text(row(pin).path)), desktopProofSources);
    for (const pin of before.map(row))
      assert.equal((await originalPin(join(repository, text(pin.path)))).sha256, hash(pin.sha256));
    proof.desktopReceipt = { path: desktopReceipt, sha256: await fileDigest(desktopReceipt) };
    proof.positiveStop = ui.stopQualification; proof.cleanup = cleanup; proof.status = 'PASS';
  } catch (error) { failure = error; }
  finally {
    closeSync(log);
    try { await verify(); proof.sourceFreeze = 'PASS'; } catch (error) { failure ??= error; proof.sourceFreeze = 'INCOMPLETE'; }
    if (!fixtureRoot) {
      const prepared = jsonRows(await readFile(logPath, 'utf8')).filter(value => value.phase === 'prepared');
      if (prepared.length === 1 && typeof prepared[0]!.receipt === 'string' &&
          prepared[0]!.receipt.startsWith(join(output, 'tmp', 'TEST-desktop-backend-')))
        fixtureRoot = dirname(prepared[0]!.receipt);
    }
    if (fixtureRoot) {
      try { await cp(fixtureRoot, join(output, 'fixture'), { recursive: true, errorOnExist: true, force: false }); }
      catch (error) { failure ??= error; }
    }
    if (failure) { proof.status = 'INCOMPLETE'; proof.failure = failure instanceof Error ? failure.message : String(failure); }
    proof.log = { path: logPath, sha256: await fileDigest(logPath) };
    await writeFile(receiptPath, JSON.stringify(proof, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ root: output, receipt: receiptPath, status: proof.status }));
  }
  if (failure) throw failure;
  return proof;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, sdkReceipt, sdkReceiptSha256, pnpmEntry, ...extra] = process.argv.slice(2);
  assert.ok(output && sdkReceipt && sdkReceiptSha256 && pnpmEntry && extra.length === 0);
  await qualifyLinuxProcessColdUi({ output, sdkReceipt, sdkReceiptSha256, pnpmEntry });
}
