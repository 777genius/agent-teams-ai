import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkpoint, digest, jsonDigest, originalHistoryMarker } from './desktop-resume-records.ts';
import { CONTEXT_MARKER, REQUIRED_TOOLS, startCodexModel } from '../../packages/legacy-agent-host/tests/fixtures/native-codex-team/model.ts';
import { seedDesktopCodexResumeOwner } from './desktop-codex-resume-fixture.ts';
import { verifyDesktopNativeFreeze } from './desktop-source-freeze.ts';
import { captureCodexCodeModeProcess, observeCodexCodeModeProcess } from '../../packages/legacy-agent-host/tests/fixtures/codex-native-closure.ts';
import { createFilesystemTeamOwner } from '../../packages/legacy-agent-host/dist/adapters/team/createFilesystemTeamOwner.js';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';

const thread = '019a1234-5678-7000-8000-123456789abc';
const callIds = Array.from({ length: 7 }, (_, index) => `native_CODEX_TEAM_ONE_${index}`);

test('original CodeMode helper witness binds parent, executable and birth without adopting a reused PID', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST codex helper identity ')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nativeInputs = await Promise.all(['codex', 'codex-code-mode-host'].map(async name => {
    const path = join(root, name), bytes = `TEST-${name}; never executed`;
    await writeFile(path, bytes, { mode: 0o755 });
    return { path, sha256: digest(bytes) };
  }));
  const codex = { pid: 300, parentPid: 200, groupId: 300, birth: 'Wed Oct 28 16:00:00 2026', command: nativeInputs[0]!.path };
  const helper = { pid: 301, parentPid: 300, groupId: 301, birth: 'Wed Oct 28 16:00:01 2026', command: nativeInputs[1]!.path };
  const witness = await captureCodexCodeModeProcess(200, nativeInputs, () => [codex, helper]);
  assert.deepEqual(witness.helper, helper); assert.deepEqual(witness.codex, codex);
  assert.equal(observeCodexCodeModeProcess(witness, () => [codex, helper]).state, 'same-live');
  assert.equal(observeCodexCodeModeProcess(witness, () => [codex]).state, 'absent');
  for (const changed of [{ ...helper, birth: 'Wed Oct 28 16:01:01 2026' },
    { ...helper, parentPid: 1 }, { ...helper, command: nativeInputs[0]!.path }, { ...helper, groupId: 300 }])
    assert.equal(observeCodexCodeModeProcess(witness, () => [codex, changed]).state, 'identity-mismatch');
  assert.deepEqual(witness.firstIdentityMismatch, { ...helper, birth: 'Wed Oct 28 16:01:01 2026' });
  assert.equal(observeCodexCodeModeProcess(witness, () => [codex]).state, 'absent');
  assert.deepEqual(witness.helper, helper, 'original saved identity is never adopted or replaced');
  assert.deepEqual(witness.firstIdentityMismatch, { ...helper, birth: 'Wed Oct 28 16:01:01 2026' }, 'absence retains the first drift fact');
  await assert.rejects(captureCodexCodeModeProcess(200, nativeInputs, () => [codex]), /helper must be observed/);
  await assert.rejects(captureCodexCodeModeProcess(200, nativeInputs, () => [codex, { ...helper, parentPid: 999 }]), /helper must be observed/);
  await assert.rejects(captureCodexCodeModeProcess(200, nativeInputs, () => [codex, helper, { ...helper, pid: 302 }]), /helper must be observed/);
});

test('external native pair freeze retains a failed flow and refuses changed or missing companions after cleanup', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST codex native freeze ')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = await Promise.all(['codex', 'codex-code-mode-host'].map(async name => {
    const path = join(root, name), bytes = `TEST-${name}; never executed`;
    await writeFile(path, bytes, { mode: 0o755 });
    return { path, sha256: digest(bytes) };
  }));
  const originalFailure = 'TEST original business failure';
  const good: Record<string, unknown> = { status: 'INCOMPLETE', originalFailure };
  await verifyDesktopNativeFreeze(before, good);
  assert.deepEqual(good.selectedNativeInputHashesAfterCleanup, before);
  assert.equal(good.nativeInputFreezeFailure, undefined);
  for (const change of [
    () => writeFile(before[1]!.path, 'CHANGED helper'),
    () => rm(before[1]!.path),
    () => symlink(before[0]!.path, before[1]!.path),
    async () => { await rm(before[1]!.path); await writeFile(before[1]!.path, 'TEST-codex-code-mode-host; never executed'); await chmod(before[1]!.path, 0o644); },
  ]) {
    await change();
    const failed: Record<string, unknown> = { status: 'PASS', originalFailure };
    await verifyDesktopNativeFreeze(before, failed);
    assert.equal(failed.status, 'INCOMPLETE');
    assert.equal(failed.originalFailure, originalFailure);
    assert.equal(typeof failed.nativeInputFreezeFailure, 'string');
  }
});

test('Codex sidebar seed persists final settings once without a roster or delivery transition', async t => {
  const root = await mkdtemp(join(tmpdir(), 'TEST-desktop-backend-codex-seed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'hoststore'));
  const binding = { backendId: 'TEST-owner', teamId: 'TEST-team', teamName: 'test-desktop-backend' };
  const profile: TeamHostProfile = { schemaVersion: 1, principalId: 'TEST-human',
    owner: { ownerId: 'TEST-owner', revision: 'TEST-revision', storageRoot: join(root, 'hoststore'), profileId: 'TEST-profile',
      protocolVersion: 1, buildId: 'TEST-build', nodeSha256: 'a'.repeat(64), hostEntrySha256: 'b'.repeat(64) },
    teams: [{ binding, scope: { projectId: 'TEST-project', workspaceId: 'TEST-workspace', teamId: binding.teamId,
      runId: 'TEST-run', memberId: 'human', generation: '1' },
      savedSettings: { cwd: join(root, 'workspace'), providerId: 'codex', model: 'TEST-retained-native-model', effort: 'low' },
      members: [{ memberId: 'alice-id', name: 'alice', role: 'lead', delivery: { ...binding, runId: 'TEST-run', memberId: 'alice-id', generation: '1' } }],
      grants: [{ principalId: 'TEST-human', memberName: 'user', permissions: ['read', 'task.write', 'admin'] },
        { principalId: 'alice-session', memberName: 'alice', permissions: ['read', 'task.write', 'message.write'] }] }],
  };
  const selected = profile.teams[0]!, seeded = await seedDesktopCodexResumeOwner(root, profile);
  assert.deepEqual(seeded.savedSettings, selected.savedSettings);
  const reopened = createFilesystemTeamOwner({ root: profile.owner.storageRoot, binding, members: selected.members, grants: selected.grants,
    savedSettings: { cwd: join(root, 'workspace'), providerId: 'anthropic', model: 'TEST-obsolete-base-model' } }).connect(profile.principalId);
  assert.deepEqual(reopened.readRoster().savedSettings, selected.savedSettings, 'reopen hydrates persisted Codex choice, not obsolete base options');
  assert.equal(reopened.listTasks().length, 1); assert.equal(reopened.listTasks()[0]!.id, seeded.uiSeed.taskId);
  const state = JSON.parse(await readFile(join(root, 'hoststore/teams/test-desktop-backend/.host-owner/state.json'), 'utf8'));
  assert.deepEqual(state.members, selected.members); assert.deepEqual(state.runtimeCaptures ?? [], []);
  assert.equal(state.rosterVersion ?? 0, 0); assert.deepEqual(state.rosterCommands ?? [], []);
  assert.ok(state.grants.every((grant: { revoked?: boolean }) => grant.revoked !== true));
  await assert.rejects(seedDesktopCodexResumeOwner(root, profile), 'never reseed an existing canonical owner');
});

test('Codex checkpoint proof requires exact captured thread metadata and preserves original payload bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'TEST-desktop-backend-codex-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'native-codex/config'), cwd = join(root, 'workspace');
  const sessions = join(home, 'sessions/2026/10/28');
  for (const path of [sessions, cwd, join(root, 'hoststore/runtime-checkpoints')]) await mkdir(path, { recursive: true });
  const profilePath = join(root, 'host-profile.json');
  const member = { provider: 'codex', teamId: 'TEST-team', memberId: 'alice-id', cwd, environment: { CODEX_HOME: home } };
  const saveProfile = (value: unknown) => writeFile(profilePath, JSON.stringify({ runtime: { members: [value] } }));
  await saveProfile(member);
  const binding = { teamId: 'TEST-team', memberId: 'alice-id', generation: '1' };
  const config = { sessionId: 'TEST-derived-captured-session' };
  const historyDigest = jsonDigest({ baseline: null, operations: [] });
  const reference = `cp1-${jsonDigest({ binding, checkpointId: 'TEST-checkpoint' })}`;
  const body = { reference, checkpointId: 'TEST-checkpoint', sourceSessionRef: 'TEST-session-ref',
    sourceBinding: binding, sourceConfig: config, historyDigest, completedOperations: [],
    opaque: { version: 2, engine: 'codex-app-server', nativeThreadId: thread } };
  const payload = { ...body, digest: jsonDigest(body) };
  const payloadPath = join(root, 'hoststore/runtime-checkpoints', `${reference}.json`);
  await writeFile(payloadPath, JSON.stringify(payload));
  const session = { sessionRef: body.sourceSessionRef, binding, config, inputs: [],
    checkpoints: [{ status: 'published', reference, payloadDigest: payload.digest, historyDigest }] };
  const historyPath = join(sessions, `rollout-2026-10-28T00-00-00-${thread}.jsonl`);
  const metadata = (id = thread, workspace = cwd) => JSON.stringify({ type: 'session_meta', payload: { id, cwd: workspace } }) + '\n';
  const history = metadata() + JSON.stringify({ type: 'event_msg', payload: { text: 'CODEX_TEAM_ONE REPLY_CODEX_ONE' } }) + '\n';
  await writeFile(historyPath, history);
  const original = await checkpoint(root, session, 'codex');
  assert.equal(original.nativeSession, thread); assert.equal(original.historyPath, historyPath);
  assert.equal(original.historySha256, digest(history));
  await writeFile(historyPath, history + '{"type":"event_msg","payload":{"text":"CODEX_TEAM_TWO"}}\n');
  const continued = await checkpoint(root, session, 'codex');
  assert.equal(continued.nativeSession, original.nativeSession);
  assert.equal(digest(continued.history.subarray(0, original.history.length)), original.historySha256);
  assert.equal(digest(await readFile(payloadPath)), original.payloadFileSha256);
  for (const invalid of [metadata('019a1234-5678-7000-8000-000000000000'), metadata(thread, '/TEST-foreign/workspace'), '{}\n']) {
    await writeFile(historyPath, invalid);
    await assert.rejects(checkpoint(root, session, 'codex'));
  }
  await writeFile(historyPath, history);
  await saveProfile({ ...member, environment: { CODEX_HOME: '/TEST-foreign/config' } });
  await assert.rejects(checkpoint(root, session, 'codex'));
  await saveProfile(member);
  const duplicate = join(sessions, `rollout-duplicate-${thread}.jsonl`);
  await writeFile(duplicate, history); await assert.rejects(checkpoint(root, session, 'codex'));
  await rm(duplicate); await rm(historyPath); await symlink(payloadPath, historyPath);
  await assert.rejects(checkpoint(root, session, 'codex'));
  assert.equal(originalHistoryMarker(callIds, 'codex'), jsonDigest(callIds));
  assert.throws(() => originalHistoryMarker([...callIds.slice(1), callIds[0]!], 'codex'));
  assert.throws(() => originalHistoryMarker(callIds), 'Claude default remains distinct');
});

test('Codex UI oracle records actual model/effort, original call IDs and incoming reply contract without replay', async t => {
  const model = await startCodexModel({ memberName: 'alice', uiGeneratedMessageIds: true, captureHistoryMarkers: true,
    principalId: () => 'TEST-actual-captured-Alice' });
  t.after(() => model.close());
  const messageId = '019a1234-5678-7000-8000-123456789def';
  const input: Record<string, unknown>[] = [
    { role: 'developer', content: CONTEXT_MARKER },
    ...callIds.flatMap((call_id, index) => [
      { type: 'function_call', call_id, name: 'TEST-original-native-tool', arguments: '{}' },
      { type: 'function_call_output', call_id, output: index === 3 ? 'Process exited with code 7\n' :
        JSON.stringify({ phase: 'completed', principalId: 'TEST-actual-captured-Alice' }) },
    ]),
    { role: 'user', content: `CODEX_TEAM_TWO {"messageId":"${messageId}"} message_send tool to="user", including commandId and text. Do not reuse the incoming messageId as a reply commandId` },
  ];
  const next = () => fetch(model.url + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'TEST-retained-native-launch-model', reasoning: { effort: 'medium' }, input,
      tools: [{ type: 'function', name: 'exec_command' }, { type: 'namespace', name: 'mcp__team', tools: REQUIRED_TOOLS.map(name => ({ name })) }] }) });
  const nativeCall = async (response: Response) => {
    const text = await response.text();
    const events = text.split('\n').filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6)) as { type: string; item?: Record<string, unknown> });
    const call = events.find(event => event.type === 'response.output_item.done')!.item!;
    assert.equal(call.type, 'function_call'); input.push(call); return text;
  };
  const shell = await next(); assert.equal(shell.status, 200); await nativeCall(shell);
  input.push({ type: 'function_call_output', call_id: 'native_CODEX_TEAM_TWO_0', output: 'Process exited with code 0\nFinal output:\n' });
  const reply = await next(); assert.equal(reply.status, 200); assert.match(await nativeCall(reply), /REPLY_CODEX_TWO/);
  input.push({ type: 'function_call_output', call_id: 'native_CODEX_TEAM_TWO_1', output: JSON.stringify({ phase: 'completed', principalId: 'TEST-actual-captured-Alice' }) });
  const terminal = await next(); assert.equal(terminal.status, 200); assert.match(await terminal.text(), /DONE_CODEX_TEAM_TWO/);
  assert.deepEqual(model.observations.map(value => value.step), [0, 1, 2]);
  for (const value of model.observations) {
    assert.equal(value.requestedModel, 'TEST-retained-native-launch-model'); assert.equal(value.requestedEffort, 'medium');
    assert.equal(value.incomingMessageId, messageId); assert.equal(value.visibleReplyContract, true);
    assert.equal(value.toolResultError, false); assert.deepEqual(value.priorNativeToolIds, callIds);
  }
  const replay = await next(); assert.equal(replay.status, 400); await replay.text();
  assert.equal(model.observations.length, 3, 'no fourth inference continuation is fabricated');
});

test('Codex UI oracle refuses a copied message id before any business continuation', async t => {
  const model = await startCodexModel({ memberName: 'alice', uiGeneratedMessageIds: true });
  t.after(() => model.close());
  const response = await fetch(model.url + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: [{ role: 'developer', content: CONTEXT_MARKER }, { role: 'user', content:
      'CODEX_TEAM_TWO {"messageId":"TEST-copied-id"} message_send tool to="user", including commandId and text. Do not reuse the incoming messageId as a reply commandId' }] }) });
  assert.equal(response.status, 400); await response.text(); assert.deepEqual(model.observations, []);
  assert.equal(model.failures.length, 1);
});
