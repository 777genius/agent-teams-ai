import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fileHash, tick, treeHash, startHost } from './fixtures/native-host.ts';
import { CONTEXT_MARKER, record, startNativeTeamModel } from './fixtures/native-claude-team/model.ts';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const required = (name: string) => { const value = process.env[name]; assert.ok(value, `${name} is selected by Root`); return value; };

test('actual solo DO ordinary child effect/provenance, ASK denial and owned parent stop preserve a neighboring native member', { timeout: 180_000 }, async t => {
  assert.equal(process.env.LEGACY_NATIVE_CLAUDE_SUBAGENT_GO, '1', 'Root release required; never run this fixture implicitly');
  const pkg = dirname(import.meta.dirname), node = await realpath(required('LEGACY_NATIVE_SUBAGENT_NODE'));
  assert.equal(await realpath(process.execPath), node);
  const entry = join(pkg, 'dist/cli.js');
  const artifact = { path: required('LEGACY_NATIVE_PROVIDER_ARTIFACT'), sha256: required('LEGACY_NATIVE_PROVIDER_SHA256') };
  assert.equal(await fileHash(join(pkg, '../..', artifact.path)), artifact.sha256);
  const pins = { artifact, node: { path: node, sha256: await fileHash(node) }, hostSource: await treeHash(join(pkg, 'src'), '.ts'), hostDist: await treeHash(join(pkg, 'dist'), '.js'), hostEntry: await fileHash(entry), providerDist: '', sdk: '', native: { path: '', sha256: '' } };
  assert.equal(pins.hostSource, required('LEGACY_NATIVE_HOST_SOURCE_SHA256')); assert.equal(pins.hostDist, required('LEGACY_NATIVE_HOST_DIST_SHA256'));
  const providerEntry = fileURLToPath(import.meta.resolve('@agent-teams/provider-implementations/claude'));
  pins.providerDist = await treeHash(dirname(providerEntry), '.js'); assert.equal(pins.providerDist, required('LEGACY_NATIVE_PROVIDER_DIST_SHA256'));
  const sdk = createRequire(providerEntry).resolve('@anthropic-ai/claude-agent-sdk');
  pins.sdk = await fileHash(sdk); assert.equal(pins.sdk, 'c8d3e6cf794501c9b2dad3199762e4594e7b890e8ce76f957e9d748e02680bb1');
  assert.equal(record(JSON.parse(await readFile(join(dirname(sdk), 'package.json'), 'utf8'))).version, '0.3.305');
  pins.native.path = await realpath(createRequire(sdk).resolve('@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'));
  pins.native.sha256 = await fileHash(pins.native.path); assert.equal(pins.native.sha256, required('LEGACY_NATIVE_CLAUDE_SHA256'));
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-claude-subagent-'))), ns = basename(root);
  t.diagnostic(`TEST receipt: ${join(root, 'receipt.json')}`);
  for (const name of ['home-a', 'home-b', 'config-a', 'config-b', 'workspace-a', 'workspace-b', 'tmp', 'store']) await mkdir(join(root, name), { mode: 0o700 });
  let parentStopRequested = false;
  const model = await startNativeTeamModel({ ordinarySubagents: { workspace: join(root, 'workspace-a'), parentStopRequested: () => parentStopRequested } });
  let host: ReturnType<typeof startHost> | undefined; let passed = false; let originalFailure: unknown;
  const proofs: Record<string, unknown> = {};
  const owner = { ownerId: `TEST-owner-${ns}`, revision: 'TEST-1', storageRoot: join(root, 'store'), profileId: `TEST-profile-${ns}`, protocolVersion: 1 as const, buildId: 'TEST-subagent', nodeSha256: pins.node.sha256, hostEntrySha256: pins.hostEntry };
  const scope = (key: string) => ({ projectId: `TEST-project-${ns}`, workspaceId: `TEST-workspace-${key}-${ns}`, teamId: `TEST-team-${key}`, runId: `TEST-run-${key}-${ns}`, memberId: 'human', generation: '1' });
  const team = (key: string, name: string) => { const selected = scope(key), binding = { backendId: owner.ownerId, teamId: selected.teamId, teamName: `test-subagent-${key}` }; return { scope: selected, binding,
    members: [{ memberId: `${key}-id`, name, role: 'member' as const, delivery: { ...binding, runId: selected.runId, memberId: `${key}-id`, generation: '1' } }],
    grants: [{ principalId: 'human', memberName: 'user', permissions: ['read', 'message.write', 'task.write', 'admin'] as ('read' | 'message.write' | 'task.write' | 'admin')[] }, { principalId: `${key}-session`, memberName: name, permissions: ['read', 'message.write', 'task.write'] as ('read' | 'message.write' | 'task.write')[] }] }; };
  const profile: TeamHostProfile = { schemaVersion: 1, owner, principalId: 'human', teams: [team('a', 'alice'), team('b', 'bob')], runtime: { members: ['a', 'b'].map(key => ({
    teamId: scope(key).teamId, memberId: `${key}-id`, principalId: `${key}-session`, provider: 'claude' as const, sessionId: `TEST-session-${key}-${ns}`, generation: 1, configRevision: 'TEST-config-1', cwd: join(root, `workspace-${key}`), model: 'claude-sonnet-4-6', accountBinding: `TEST-dummy-account-${key}`, executable: pins.native,
    environment: { HOME: join(root, `home-${key}`), CLAUDE_CONFIG_DIR: join(root, `config-${key}`), TMPDIR: join(root, 'tmp'), PATH: `${dirname(node)}:/usr/bin:/bin`, ANTHROPIC_API_KEY: 'TEST-LOCALHOST-ONLY-NOT-A-REAL-KEY', ANTHROPIC_BASE_URL: model.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', DISABLE_AUTOUPDATER: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_TELEMETRY: '1', NO_COLOR: '1', TERM: 'dumb' },
    nativeTools: ['Read', 'Write', 'Bash'], autoAllowedTools: ['Read', 'Write', 'Bash', 'Agent'], nativeOptions: { projectInstructions: { append: `${CONTEXT_MARKER} TEST isolated ordinary subagent qualification only.` } }, limits: { queuedInputs: 2, inputBytes: 8192, outputBytes: 2_000_000, outputEvents: 2000, pendingInteractions: 4, timeoutMs: 45_000 },
  })) } };
  const profilePath = join(root, 'profile.json'), bytes = JSON.stringify(profile); await writeFile(profilePath, bytes, { mode: 0o600 });
  const envelope = (key: string, commandId: string, payload: unknown) => ({ commandId, binding: { schemaVersion: 1, handleId: `TEST-handle-${key}-${ns}`, owner, scope: scope(key) }, payload });
  const rpc = (method: string, key: string, commandId: string, payload: unknown) => host!.rpc(method, envelope(key, commandId, payload));
  const size = async () => { try { return (await readFile(join(root, 'workspace-a/child-running.txt'))).byteLength; } catch { return 0; } };
  const terminal = async (key: string, inputId: unknown) => {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      assert.deepEqual(model.failures, []);
      const value = await rpc('runtime.read', key, `TEST-read-${key}`, { memberId: `${key}-id` }); assert.equal(value.ok, true);
      const selected = (record(value.value).inputs as unknown[]).map(record).find(input => input.inputId === inputId);
      if (selected?.phase === 'terminal') { assert.equal(selected.terminal, 'succeeded'); return; }
      await tick();
    }
    throw new Error('Actual native input did not reach terminal');
  };
  const send = async (key: string, marker: string, actionMode: 'do' | 'ask') => { const receipt = await rpc('team.execute', key, `TEST-message-${marker}`, { operation: 'message.send', payload: { to: key === 'a' ? 'alice' : 'bob', text: marker, actionMode, messageId: `TEST-message-${marker}` } }); assert.equal(receipt.ok, true); return record(record(receipt.value).effects).deliveryId; };
  try {
    let diagnosticBytes = 0;
    host = startHost({ node, entry, root, profile: profilePath, profileHash: hash(bytes), onDiagnostic(chunk) {
      const retained = chunk.subarray(0, Math.max(0, 64 * 1024 - diagnosticBytes)); diagnosticBytes += retained.length;
      if (retained.length) appendFileSync(join(root, 'host-stderr.log'), retained, { mode: 0o600 });
    } }); await host.rpc('host.handshake', { protocolVersion: 1 });
    for (const key of ['a', 'b']) {
      const launch = await rpc('team.launch.read', key, `TEST-launch-read-${key}`, {}); assert.equal(launch.ok, true);
      const selected = record(launch.value);
      const start = await rpc('team.launch.start', key, `TEST-launch-start-${key}`, { launchId: selected.launchId, rosterRevision: selected.rosterRevision,
        configuration: { members: [{ memberId: `${key}-id`, model: 'claude-sonnet-4-6', permissions: 'bypass', context: 'model-default' }] } }); assert.equal(start.ok, true, JSON.stringify(start));
    }
    await terminal('b', await send('b', 'NATIVE_SOLO_NEIGHBOR_ONE', 'do'));
    await terminal('a', await send('a', 'NATIVE_SOLO_DENY', 'ask'));
    assert.equal(model.ordinaryRequests.some(request => request.turn === 'TEST_CHILD_DENY'), false);
    const effectInput = await send('a', 'NATIVE_SOLO_EFFECT', 'do'); await terminal('a', effectInput);
    assert.equal(await readFile(join(root, 'workspace-a/child-effect.txt'), 'utf8'), 'TEST_ACTUAL_ORDINARY_CHILD_EFFECT\n');
    const activity = await rpc('runtime.activity.snapshot', 'a', 'TEST-child-activity', { memberId: 'a-id' }); assert.equal(activity.ok, true);
    proofs.activity = activity.value;
    const serialized = JSON.stringify(activity.value); assert.match(serialized, /"kind":"subagent"/); assert.match(serialized, /child-[a-f0-9]{64}/); assert.match(serialized, /TEST_CHILD_REPORT_COMPLETE/);
    const binding = { backendId: owner.ownerId, teamId: scope('a').teamId, runId: scope('a').runId, memberId: 'a-id', generation: '1' };
    const member = { backendId: binding.backendId, teamId: binding.teamId, memberId: binding.memberId };
    const storedSession = record(JSON.parse(await readFile(join(root, 'store/runtime-sessions', hash(JSON.stringify(member)), `${hash(JSON.stringify(binding))}.json`), 'utf8')));
    const originalInput = (storedSession.inputs as unknown[]).map(record).find(input => record(input.intent).inputId === effectInput);
    assert.equal(typeof originalInput?.operationRef, 'string');
    const storedActivity = record(JSON.parse(await readFile(join(root, 'store/runtime-events', `${hash(JSON.stringify(binding))}.json`), 'utf8')));
    const childRows = (storedActivity.events as unknown[]).map(record).filter(row => record(row.data).kind === 'subagent' && row.inputId === effectInput);
    assert.ok(childRows.length > 0);
    assert.ok(childRows.every(row => row.operationRef === originalInput?.operationRef), 'every actual child observation retains its original parent operation');
    const start = childRows.find(row => record(row.data).phase === 'started'); assert.ok(start, 'actual SDK foreground task_started was accepted with required native ownership fields');
    const child = record(start.data); assert.match(String(child.childId), /^child-[a-f0-9]{64}$/); assert.match(String(child.parentToolRef), /^tool-[a-f0-9]{64}$/);
    assert.ok(childRows.every(row => record(row.data).childId === child.childId && record(row.data).parentToolRef === child.parentToolRef));
    assert.ok(childRows.some(row => record(record(row.data).fact).text === 'TEST_CHILD_REPORT_COMPLETE'), 'real child report remains a child fact');
    assert.equal(childRows.some(row => record(row.data).phase === 'gap'), false, 'child provenance must be complete for this scoped proof');
    const latest = record(record(activity.value).latest);
    const publicTools = (latest.tools as unknown[]).map(record);
    assert.ok(publicTools.some(row => row.inputId === effectInput && record(row.data).kind === 'tool' && record(row.data).name === 'Agent' && record(row.data).toolRef === child.parentToolRef));
    const publicChildren = (latest.subagents as unknown[]).map(record).filter(row => record(row.data).childId === child.childId);
    assert.ok(publicChildren.length > 0);
    assert.ok(publicChildren.every(row => row.inputId === effectInput && record(row.data).parentToolRef === child.parentToolRef), 'public child facts retain the exact original input and parent tool');
    assert.ok(publicChildren.some(row => record(record(row.data).fact).text === 'TEST_CHILD_REPORT_COMPLETE'), 'snapshot retains the actual child report');
    const publicText = (latest.text as unknown[]).map(record);
    assert.equal(publicText.some(row => record(row.data).kind === 'text' && record(row.data).text === 'TEST_CHILD_REPORT_COMPLETE'), false, 'child text is not projected as parent text');
    proofs.provenance = { inputId: effectInput, operationRef: originalInput?.operationRef, childId: child.childId, parentToolRef: child.parentToolRef, phases: childRows.map(row => record(row.data).phase) };
    const userInbox = JSON.parse(await readFile(join(root, 'store/teams/test-subagent-a/inboxes/user.json'), 'utf8').catch(() => '[]')) as unknown[];
    assert.equal(userInbox.map(record).some(row => row.text === 'TEST_FORBIDDEN_CHILD_TEAM_MESSAGE'), false);
    const policyState = record(JSON.parse(await readFile(join(root, 'store/teams/test-subagent-a/.host-owner/state.json'), 'utf8')));
    assert.equal((policyState.members as unknown[]).length, 1);
    assert.deepEqual((policyState.grants as unknown[]).map(record).map(row => row.principalId).sort(), ['a-session', 'human']);
    proofs.teamAuthorityUnchanged = true;
    await send('a', 'NATIVE_SOLO_STOP', 'do');
    const markerDeadline = Date.now() + 45_000; while (await size() === 0 && Date.now() < markerDeadline) { assert.deepEqual(model.failures, []); await tick(); }
    assert.ok(await size() > 0, 'actual child native Bash effect began');
    parentStopRequested = true;
    const stop = await rpc('runtime.stop', 'a', 'TEST-parent-stop', { memberId: 'a-id' }); assert.equal(stop.ok, true); assert.equal(record(stop.value).custody, 'released');
    proofs.stop = stop.value;
    const stoppedSize = await size(); const quietDeadline = Date.now() + 1200; while (Date.now() < quietDeadline) { await tick(); assert.equal(await size(), stoppedSize, 'owned native child cannot continue effects after parent custody release'); }
    proofs.childEffectStoppedAtBytes = stoppedSize;
    await terminal('b', await send('b', 'NATIVE_SOLO_NEIGHBOR_TWO', 'do'));
    assert.equal(await readFile(join(root, 'workspace-b/neighbor-effect.txt'), 'utf8'), 'NATIVE_SOLO_NEIGHBOR_ONE\nNATIVE_SOLO_NEIGHBOR_TWO\n');
    assert.ok(model.ordinaryRequests.some(request => request.turn === 'TEST_CHILD_EFFECT' && request.previousToolError));
    passed = true;
  } catch (error) { originalFailure = error; throw error; } finally {
    let cleanup = false; let cleanupFailure: unknown;
    const failure = (error: unknown) => error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) };
    try { if (host) { await host.close(); cleanup = true; } } catch (error) { cleanupFailure = error; } finally {
      if (host) proofs.host = host.facts();
      // The child shell is finite. An uncertain native descendant is never killed via guessed PIDs.
      if (!passed && model.ordinaryRequests.some(request => request.turn === 'TEST_CHILD_STOP')) { const until = Date.now() + 20_000; while (Date.now() < until) await tick(); }
      try { await model.close(); } catch (error) { cleanupFailure ??= error; }
      await writeFile(join(root, 'receipt.json'), JSON.stringify({ status: passed && cleanup ? 'SCOPED_PASS' : 'INCOMPLETE', root, pins, proofs, cleanup, requests: model.ordinaryRequests, failures: model.failures,
        ...(originalFailure === undefined ? {} : { originalFailure: failure(originalFailure) }), ...(cleanupFailure === undefined ? {} : { cleanupFailure: failure(cleanupFailure) }),
        scope: 'Actual Host stdio -> SDK0.3.305 -> selected Claude native -> localhost inference; no SDK transcript fabrication', excluded: ['Desktop UI', 'real authentication', 'M13 child file evidence qualification', 'whole Stage1/P4'] }, null, 2), { mode: 0o600 });
    }
    if (originalFailure === undefined && cleanupFailure !== undefined) throw cleanupFailure;
  }
});
