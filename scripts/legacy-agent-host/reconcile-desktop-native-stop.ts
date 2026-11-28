import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileDigest } from './desktop-backend-fixture.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};

// Deliberately read-only reconciliation of one closed capture. No app startup,
// Host/RPC, native control or replay is available through this entrypoint.
assert.equal(process.env.LEGACY_DESKTOP_NATIVE_STOP_RECONCILE_GO, '1');
const root = process.env.LEGACY_DESKTOP_NATIVE_STOP_CAPTURE_ROOT;
assert.ok(
  root && (await realpath(root)) === root && basename(root).startsWith('TEST-desktop-backend-')
);
const receipt = join(root, 'desktop-backend-receipt.json');
const receiptSha256 = await fileDigest(receipt);
assert.equal(receiptSha256, process.env.LEGACY_DESKTOP_NATIVE_STOP_CAPTURE_SHA256);
const original = record(JSON.parse(await readFile(receipt, 'utf8')));
assert.equal(original.status, 'INCOMPLETE');
assert.equal(original.mode, 'native-stop-ui');
assert.match(String(original.failure), /0 !== 1/);
assert.equal(record(original.nativeStopProof).status, 'INCOMPLETE');
assert.equal(record(original.nativeSetup).status, 'ready');
assert.equal(record(original.cleanup).capturedHostAbsent, true);
assert.deepEqual(record(original.cleanup).remaining, []);
assert.equal(record(original.cleanup).appExitCode, 0);
assert.equal(
  record(original.nativeSetup).nativeExecutableSha256,
  'ea3ea3c08d2a9634a4651e687fcf900d410c489bce2b00f22bd7352b91ba704f'
);
assert.equal(
  await fileDigest(join(root, 'host-profile.json')),
  record(original.pins).profileSha256
);
const repo = resolve(import.meta.dirname, '../..');
const source = join(
  repo,
  '.artifacts/provider-migration/p5-desktop-native-stop-attempt1-source/scripts/legacy-agent-host/desktop-team-ui-smoke.ts'
);
assert.equal(await fileDigest(source), record(original.pins).uiSourceSha256);
const steps = record(original.userControlProof).steps;
assert.ok(Array.isArray(steps));
assert.equal(
  steps
    .map(record)
    .filter((step) => step.action === 'mouseClick' && step.label === 'ordinary Stop team control')
    .length,
  1
);
assert.ok(
  steps
    .map(record)
    .some((step) => step.assertion === 'same Task ID and product fields after reload')
);
assert.equal(record(original.uiBusinessReceipt).phase, 'completed');
const sessions = await readDesktopNativeStopSessions(root);
assert.equal(sessions.length, 1);
const session = sessions[0]!;
assert.equal(session.schemaVersion, 1);
assert.equal(session.phase, 'closed');
assert.equal(session.custody, 'released');
assert.equal(record(session.binding).memberId, 'alice-id');
assert.equal(record(session.binding).generation, '1');
assert.deepEqual(session.inputs, [], 'this Stop proof did not run native model inputs');
const children = record(original.nativeSetup).nativeChildren;
assert.ok(Array.isArray(children) && children.length === 1);
for (const child of children.map(record)) {
  assert.ok(Number.isSafeInteger(child.pid) && Number(child.pid) > 1);
  try {
    const output = execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'pid='], {
      encoding: 'utf8',
      timeout: 3000,
    });
    assert.equal(output.trim(), '', 'captured PID remains live; do not signal or infer cleanup');
  } catch (error) {
    assert.equal(
      (error as { status?: number }).status,
      1,
      'only native no-process status proves current absence'
    );
  }
}
assert.equal(await fileDigest(receipt), receiptSha256, 'original receipt is immutable');
const result = {
  status: 'INCOMPLETE',
  originalReceiptSha256: receiptSha256,
  collectorSha256: await fileDigest(import.meta.filename),
  facts: {
    taskCreatedThroughOrdinaryUi: true,
    taskPreservedAfterRendererReload: true,
    ordinaryStopClickedOnce: true,
    finalRuntimePhase: session.phase,
    finalCustody: session.custody,
    nativeChildAbsentAfterGuardedQuit: true,
    refusedLegacyInvocations: record(original.finalSentinelCensus).refusedInvocations,
  },
  correctedObservation:
    'The Runtime store has a namespace directory above generation JSON files; the original flat collector counted zero records.',
  limitation:
    'The first failure entered guarded Quit before an OS census of the native child after Stop. Final released state/current absence cannot independently prove the before-Quit timing. Original INCOMPLETE remains unchanged.',
  effectsReplayed: 0,
  next: 'Use the corrected collector in the next native Desktop conversation/control scenario; do not repeat completed Task creation to repair observation.',
};
const output = join(root, 'native-stop-readonly-reconciliation.json');
await writeFile(output, JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ status: result.status, receipt: output, effectsReplayed: 0 }));
