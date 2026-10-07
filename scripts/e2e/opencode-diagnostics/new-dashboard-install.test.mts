import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertQualifiedPayload, assertRecoveredUi, assertSameSession } from './new-dashboard-install.mts';
import { assertProducer } from './new-qualified-payload.mts';

const file = { path: 'C:\\TEST\\app.exe', sha256: 'a'.repeat(64) };
const artifact = { app: file, archive: file, orchestrator: file, rendererArtifact: file };
const receipt = { schemaVersion: 1 as const, sourceCommit: 'b54020c17cc2624668fed77d5c8e98698866da59',
  runtimeVersion: '0.0.105', buildRunId: '37577692624', buildJobId: '112650170287', artifactId: '11462824999', buildAttempt: 1,
  originalArchivePath: new URL(import.meta.url).pathname, originalArchiveSha256: '92a6b30ec214240df1f2742060cfe993d858526b11c42f0ef51b0ac6b3a2ea91', artifact };
const recovered = { runtime: { installed: true, source: 'app-managed', state: 'ready' }, gate: 'ready',
  cards: [{ id: 'provider-quick-card-opencode-zen', blocked: false }],
  inventory: [{ launchModel: 'opencode/example-free', source: 'app-server', metadata: { opencode: { providerId: 'opencode', routeKind: 'builtin_free', accessKind: 'builtin_free' } } }],
  modelBadges: [{ modelId: 'opencode/example-free', label: 'Example Free' }],
  catalog: { state: 'ready', models: ['opencode/example-free'] } };
const session = { main: { pid: 1234, birth: '2026-10-07T00:00:00Z', executable: file.path },
  targetId: 'target-1', frameId: 'frame-1', loaderId: 'loader-1', url: 'file:///TEST/index.html', timeOrigin: 1000 };

await test('qualification binds all seeded bytes to the official source/runtime receipt', () => {
  assertQualifiedPayload(artifact, receipt);
  for (const key of ['app', 'archive', 'orchestrator', 'rendererArtifact'] as const)
    assert.throws(() => assertQualifiedPayload({ ...artifact, [key]: { ...file, sha256: 'b'.repeat(64) } }, receipt));
  assert.throws(() => assertQualifiedPayload(artifact, { ...receipt, sourceCommit: '0'.repeat(40) }));
  assert.throws(() => assertQualifiedPayload(artifact, { ...receipt, sourceCommit: receipt.sourceCommit.slice(1) }), /40-character/);
  assert.throws(() => assertQualifiedPayload(artifact, { ...receipt, runtimeVersion: '0.0.104' }));
  assert.throws(() => assertQualifiedPayload(artifact, { ...receipt, buildJobId: '112650170288' }));
  assert.throws(() => assertQualifiedPayload(artifact, { ...receipt, artifactId: '11462825000' }));
  assert.throws(() => assertQualifiedPayload(artifact, { ...receipt, originalArchiveSha256: 'b'.repeat(64) }));
});

await test('transport success, stale runtime state and blocked providers cannot qualify', () => {
  assertRecoveredUi(recovered);
  for (const broken of [
    { ...recovered, catalog: { state: 'ready', models: [] } },
    { ...recovered, catalog: { state: 'loading', models: ['cached/model'] } },
    { ...recovered, runtime: { installed: false, source: 'missing', state: 'idle' } },
    { ...recovered, gate: 'missing' }, { ...recovered, inventory: [] }, { ...recovered, modelBadges: [] },
    { ...recovered, cards: [{ id: 'provider-quick-card-opencode-zen', blocked: true }] },
  ]) assert.throws(() => assertRecoveredUi(broken));
});

await test('restart, target replacement, navigation and reload each fail the session boundary', () => {
  assertSameSession(session, { ...session });
  for (const changed of [
    { ...session, main: { ...session.main, pid: 5678 } },
    { ...session, main: { ...session.main, birth: '2026-10-07T00:01:00Z' } },
    { ...session, targetId: 'target-2' }, { ...session, loaderId: 'loader-2' },
    { ...session, timeOrigin: 2000 },
  ]) assert.throws(() => assertSameSession(session, changed));
});

await test('only successful same-source producer and unexpired complete artifact authorize staging', () => {
  const run = { id: 37577692624, run_attempt: 1, head_sha: receipt.sourceCommit, status: 'completed', conclusion: 'success', path: '.github/workflows/build-linux-windows-draft.yml' };
  const job = { id: 112650170287, run_id: run.id, name: 'release-win x64', conclusion: 'success', head_sha: run.head_sha };
  const payload = { id: 11462824999, name: 'draft-win32-x64-1', size_in_bytes: 239262824, expired: false, digest: `sha256:${receipt.originalArchiveSha256}`, workflow_run: { id: run.id, head_sha: run.head_sha } };
  assertProducer(run, job, payload);
  assert.throws(() => assertProducer({ ...run, conclusion: 'failure' }, job, payload));
  assert.throws(() => assertProducer(run, { ...job, head_sha: '0'.repeat(40) }, payload));
  assert.throws(() => assertProducer(run, job, { ...payload, expired: true }));
  assert.throws(() => assertProducer(run, job, { ...payload, digest: 'sha256:' + '0'.repeat(64) }));
  assert.throws(() => assertProducer(run, job, { ...payload, workflow_run: { ...payload.workflow_run, id: run.id + 1 } }));
});
