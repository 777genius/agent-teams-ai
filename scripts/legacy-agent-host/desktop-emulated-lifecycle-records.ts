import assert from 'node:assert/strict';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, json, jsonDigest, record, rows } from './desktop-resume-records.ts';
import { readDesktopNativeStopSessions } from './desktop-native-stop-fixture.ts';
import type { prepareDesktopEmulatedRuntimeFixture } from './desktop-emulated-runtime-fixture.ts';

export type EmulatedLifecycleFixture = Awaited<ReturnType<typeof prepareDesktopEmulatedRuntimeFixture>>;
export type EmulatedLifecycleRow = Record<string, unknown>;
export const lifecycleRows = (value: unknown): EmulatedLifecycleRow[] => {
  assert.ok(Array.isArray(value)); return value.map(record);
};

/** Published Host payload plus history written only by the original finite CLI peer. */
export async function readEmulatedClaudeCheckpoint(fixture: EmulatedLifecycleFixture, source: EmulatedLifecycleRow) {
  assert.equal(fixture.emulatedRuntime.provider, 'claude');
  assert.equal(fixture.emulatedRuntime.variant, 'lifecycle');
  assert.equal(source.phase, 'closed'); assert.equal(source.custody, 'released');
  const published = lifecycleRows(source.checkpoints).filter(row => row.status === 'published');
  assert.equal(published.length, 1);
  const attempt = published[0]!; assert.match(String(attempt.reference), /^cp1-[a-f0-9]{64}$/);
  const path = join(fixture.root, 'hoststore/runtime-checkpoints', `${attempt.reference}.json`);
  const payload = await json(path), { digest: expected, ...body } = payload;
  assert.equal(jsonDigest(body), expected); assert.equal(expected, attempt.payloadDigest);
  assert.equal(payload.historyDigest, attempt.historyDigest); assert.equal(payload.sourceSessionRef, source.sessionRef);
  assert.deepEqual(payload.sourceBinding, source.binding); assert.deepEqual(payload.sourceConfig, source.config);
  const operations = lifecycleRows(source.inputs).filter(row => row.phase === 'terminal').map(row => ({
    inputId: record(row.intent).inputId, operationRef: row.operationRef, fingerprint: row.fingerprint, outcome: row.terminal,
  }));
  assert.deepEqual(payload.completedOperations, operations);
  assert.equal(payload.historyDigest, jsonDigest({ baseline: record(source.config).checkpointRef ?? null, operations }));
  assert.equal(payload.reference, `cp1-${jsonDigest({ binding: source.binding, checkpointId: payload.checkpointId })}`);
  const nativeSession = String(record(payload.opaque).nativeSession);
  assert.match(nativeSession, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  const runtime = fixture.emulatedRuntime.peers.find(peer => peer.role === 'runtime')!;
  const namespace = runtime.environment.CLAUDE_CONFIG_DIR!;
  assert.equal(namespace, join(fixture.root, 'TEST-peer-claude-scope/config'));
  const historyPath = join(namespace, 'projects/TEST-desktop-peer', `${nativeSession}.jsonl`);
  assert.equal(await realpath(historyPath), historyPath);
  const info = await lstat(historyPath);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 1024 * 1024);
  const history = await readFile(historyPath);
  const transcript = history.toString('utf8').trim().split('\n').map(line => record(JSON.parse(line)));
  assert.ok(transcript.length > 0 && transcript.length <= 128);
  for (const row of transcript) {
    assert.equal(row.sessionId, nativeSession); assert.equal(row.cwd, join(fixture.root, 'workspace'));
    assert.equal(row.isSidechain, false); assert.ok(row.type === 'user' || row.type === 'assistant');
    assert.equal(record(row.message).role, row.type); assert.equal(typeof record(row.message).content, 'string');
  }
  return { attempt, payload, path, nativeSession, historyPath, transcript, history,
    historySha256: digest(history), payloadFileSha256: digest(await readFile(path)) };
}

export async function readEmulatedLifecycleSessions(fixture: EmulatedLifecycleFixture, launchId: unknown) {
  return (await readDesktopNativeStopSessions(fixture.root)).filter(row => record(row.binding).runId === launchId);
}

/** Product records are observation only; no copied checkpoint, outbox or receipt is accepted. */
export async function readEmulatedLifecycleProduct(fixture: EmulatedLifecycleFixture) {
  const owner = join(fixture.root, 'hoststore/teams/test-desktop-backend/.host-owner');
  return { state: await json(join(owner, 'state.json')), commands: await rows(join(owner, 'commands')),
    tasks: await rows(join(fixture.root, 'hoststore/tasks/test-desktop-backend')),
    outbox: await rows(join(owner, 'outbox')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []; throw error;
    }) };
}
