import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import type { RuntimeInput } from '../../packages/legacy-agent-host/dist/runtime/contracts.js';

const source = join(import.meta.dirname, '../../tools/owned-process-broker/fixtures/legacyBootstrapPeer.mjs');
const prompt = 'TEST_CURRENT_LEGACY_SOLO_ONE';
const deferredPrompt = 'You are "team-lead", the team lead.\nYour team is "test-stopped-legacy".\nUser instructions:\n' + prompt;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

test('finite import factory keeps only the explicit fresh-launch template and refuses unrelated Runtime seeds',
  { skip: process.platform === 'win32', timeout: 20_000 }, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-finite-import-preparation-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const name of ['home', 'tmp', 'corepack/dist/lib'])
      await mkdir(join(root, name), { recursive: true, mode: 0o700 });
    await writeFile(join(root, 'corepack/package.json'), JSON.stringify({ name: 'corepack', version: 'TEST' }), { mode: 0o600 });
    for (const name of ['dist/pnpm.js', 'dist/lib/corepack.cjs'])
      await writeFile(join(root, 'corepack', name), 'throw new Error("TEST must never execute Corepack");\n', { mode: 0o600 });
    const repo = await realpath(join(import.meta.dirname, '../..'));
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [repo, pnpmEntry, temporary] = process.argv.slice(1);
const load = relative => import(pathToFileURL(join(repo, relative)).href);
const { prepareDesktopFiniteStoppedImportFixture } = await load('scripts/legacy-agent-host/desktop-finite-stopped-import-fixture.ts');
const { prepareDesktopEmulatedRuntimeFixture, verifyDesktopEmulatedRuntimeFixture } = await load('scripts/legacy-agent-host/desktop-emulated-runtime-fixture.ts');
const { prepareDesktopBackendFixture } = await load('scripts/legacy-agent-host/desktop-backend-fixture.ts');
const { publishDesktopEmulatedClaudeSettingsProfile } = await load('scripts/legacy-agent-host/desktop-emulated-claude-settings-fixture.ts');
const { readTeamHostProfile } = await load('packages/legacy-agent-host/dist/composition/readProfile.js');
const { teamHostProfileSchema } = await load('packages/legacy-agent-host/dist/composition/teamHostProfile.js');
const { resolveRuntimeRecipe } = await load('packages/legacy-agent-host/dist/composition/runtimeRecipe.js');
assert.deepEqual(await readdir(temporary), []);
for (const [provider, variant, candidate, selected] of [
  ['codex', undefined, undefined, true], ['claude', 'lifecycle', undefined, true],
  ['claude', undefined, {}, true], ['claude', undefined, undefined, false],
]) await assert.rejects(prepareDesktopEmulatedRuntimeFixture(repo, pnpmEntry, provider, variant, candidate, selected));
process.env.LEGACY_DESKTOP_PROOF_MODE = 'emulated-import-ui';
await assert.rejects(prepareDesktopEmulatedRuntimeFixture(repo, pnpmEntry, 'claude', undefined, undefined, true));
process.env.LEGACY_DESKTOP_PROOF_MODE = 'emulated-import-lifecycle-ui';
process.env.LEGACY_DESKTOP_EMULATED_ONLY = '0';
await assert.rejects(prepareDesktopEmulatedRuntimeFixture(repo, pnpmEntry, 'claude', undefined, undefined, true));
process.env.LEGACY_DESKTOP_EMULATED_ONLY = '1';
await assert.rejects(prepareDesktopBackendFixture(repo, { pnpmEntry, seedUiPreferences: true, creation: true,
  finiteStoppedImport: true, seedUiTask: true }));
assert.deepEqual(await readdir(temporary), [], 'out-of-scope selection creates no fixture');
const fixture = await prepareDesktopFiniteStoppedImportFixture(repo, pnpmEntry);
assert.equal(dirname(fixture.root), temporary);
const profile = readTeamHostProfile(fixture.profilePath, fixture.pins.profileSha256);
assert.deepEqual(profile.runtime.members, []); assert.equal(profile.runtime.providerTemplates.length, 1);
assert.equal(profile.management.length, 1);
const template = profile.runtime.providerTemplates[0];
const selected = resolveRuntimeRecipe(profile.runtime, 'TEST-fresh-import-team', 'team-lead', 'anthropic');
assert.deepEqual(selected, resolveRuntimeRecipe({ ...profile.runtime, members: [template] },
  'TEST-fresh-import-team', 'team-lead', 'anthropic'), 'unused seed removal cannot change the fresh captured recipe');
assert.equal(selected.memberId, 'team-lead'); assert.notEqual(selected.sessionId, template.sessionId);
const descriptor = JSON.parse(await readFile(fixture.descriptorPath, 'utf8'));
assert.equal(descriptor.creation.importAuthority.principalId, profile.principalId);
assert.equal(descriptor.owners[0].profile.env.LEGACY_AGENT_HOST_PROFILE_SHA256, fixture.pins.profileSha256);
assert.deepEqual(descriptor.handles[0].members, [{ memberId: 'alice-id', label: 'alice' }]);
assert.equal((await verifyDesktopEmulatedRuntimeFixture(fixture)).protocolRevision, 'sdk-0.3.305');
process.env.LEGACY_DESKTOP_PROOF_MODE = 'emulated-import-ui';
await assert.rejects(verifyDesktopEmulatedRuntimeFixture(fixture));
process.env.LEGACY_DESKTOP_PROOF_MODE = 'emulated-import-lifecycle-ui';
const peer = fixture.emulatedRuntime.peers[0], flag = peer.environment.TEST_DESKTOP_IMPORT_LIFECYCLE;
peer.environment.TEST_DESKTOP_IMPORT_LIFECYCLE = 'malformed';
await assert.rejects(verifyDesktopEmulatedRuntimeFixture(fixture));
peer.environment.TEST_DESKTOP_IMPORT_LIFECYCLE = flag;
const withSeed = structuredClone(profile); withSeed.runtime.members = [structuredClone(template)];
await publishDesktopEmulatedClaudeSettingsProfile(fixture, withSeed);
await assert.rejects(verifyDesktopEmulatedRuntimeFixture(fixture));
await publishDesktopEmulatedClaudeSettingsProfile(fixture, profile);
const malformed = structuredClone(profile);
malformed.runtime.providerTemplates[0].environment.TEST_DESKTOP_IMPORT_LIFECYCLE = 'malformed';
await publishDesktopEmulatedClaudeSettingsProfile(fixture, malformed);
await assert.rejects(verifyDesktopEmulatedRuntimeFixture(fixture));
await publishDesktopEmulatedClaudeSettingsProfile(fixture, profile,
  descriptor => { descriptor.creation.importAuthority = { principalId: 'TEST-foreign-principal' }; });
await assert.rejects(verifyDesktopEmulatedRuntimeFixture(fixture));
await publishDesktopEmulatedClaudeSettingsProfile(fixture, profile,
  descriptor => { descriptor.creation.importAuthority = { principalId: profile.principalId }; });
assert.equal(teamHostProfileSchema.safeParse({ ...profile, runtime: { members: [], providerTemplates: [] } }).success, false);
await verifyDesktopEmulatedRuntimeFixture(fixture);
for (const path of [join(fixture.root, 'hoststore/runtime-sessions'), join(fixture.root, 'claude/teams/test-stopped-legacy'),
  fixture.sentinelLog, ...fixture.emulatedRuntime.peers.map(peer => join(peer.root, 'effects.ndjson'))])
  await assert.rejects(lstat(path), { code: 'ENOENT' });
// Exercise only generated UNIT sentinels after proving preparation itself has no effects.
const invokeSentinel = (name, argument, status) => {
  const result = spawnSync(fixture.node, [join(fixture.root, 'bin', name), argument], {
    env: {}, encoding: 'utf8', timeout: 1500, maxBuffer: 4096,
  });
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, status);
  return result;
};
const version = invokeSentinel('codex', '--version', 78);
assert.equal(version.stdout, ''); assert.equal(version.stderr, '');
const refused = invokeSentinel('codex', 'app-server', 78);
assert.equal(refused.stdout, ''); assert.equal(refused.stderr, 'TEST sentinel refuses native agent invocation\\n');
const claudeVersion = invokeSentinel('claude-multimodel', '--version', 0);
assert.match(claudeVersion.stdout, /\\(TEST sentinel\\)/u); assert.equal(claudeVersion.stderr, '');
assert.deepEqual((await readFile(fixture.sentinelLog, 'utf8')).trim().split('\\n').map(JSON.parse), [
  { executable: 'codex', allowed: true, argc: 1, command: null, flags: ['--version'] },
  { executable: 'codex', allowed: false, argc: 1, command: 'app-server', flags: [] },
  { executable: 'claude-multimodel', allowed: true, argc: 1, command: null, flags: ['--version'] },
]);
process.stdout.write(JSON.stringify({ templateOnly: true, nativeEffects: 0, unselectedCodexUnavailable: true }));
`, repo, join(root, 'corepack/dist/pnpm.js'), join(root, 'tmp')], {
      cwd: repo, encoding: 'utf8', timeout: 15_000, maxBuffer: 128 * 1024,
      env: { HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), PATH: dirname(process.execPath) + ':/usr/bin:/bin',
        LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', LEGACY_DESKTOP_EMULATED_ONLY: '1',
        LEGACY_DESKTOP_PROOF_MODE: 'emulated-import-lifecycle-ui' },
    });
    assert.equal(result.error, undefined, result.stderr); assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { templateOnly: true, nativeEffects: 0, unselectedCodexUnavailable: true });
  });

test('finite import conversation readback binds the complete public reply to its original Runtime generation', async () => {
  const { assertFiniteImportConversationReadback } = await import('./desktop-finite-stopped-import-fixture.ts');
  const { runtimeDigest, normalizeBinding } = await import('../../packages/legacy-agent-host/dist/runtime/identity.js');
  const f = await inputCorrelationFixture(), correlation = f.assertFiniteImportInputCorrelation(f.options);
  const reply = { from: 'team-lead', to: 'user', text: 'TEST boot ready', timestamp: '2026-11-19T12:00:00.000Z',
    read: true, source: 'lead_session', messageId: 'host-reply-' + sha('TEST-original-message'),
    leadSessionId: 'host-lead-' + runtimeDigest(normalizeBinding(f.binding)) };
  const page = { teamName: 'test-stopped-legacy', revision: sha('TEST-original-page'),
    conversation: { revision: sha('TEST-original-conversation'), gaps: [] as string[] },
    messages: [{ from: 'user', to: 'team-lead', text: 'TEST original product message',
      timestamp: reply.timestamp, read: true, source: 'inbox', messageId: randomUUID() }, reply],
    hasMore: false, nextCursor: null as string | null };
  assert.deepEqual(assertFiniteImportConversationReadback(page, correlation), page);
  const cases: Array<[string, (value: typeof page) => void]> = [
    ['product snapshot is not the conversation port', value => { Object.assign(value, { conversation: undefined }); }],
    ['foreign Team', value => { value.teamName = 'TEST-foreign-team'; }],
    ['foreign Runtime generation', value => { Object.assign(value.messages[1]!, { leadSessionId: 'host-lead-' + sha('TEST-successor') }); }],
    ['matching product text cannot substitute for native reply', value => { value.messages[1]!.source = 'inbox'; }],
    ['wrong reply bytes', value => { value.messages[1]!.text = 'TEST different reply'; }],
    ['duplicate native reply', value => { value.messages.push(structuredClone(value.messages[1]!)); }],
    ['incomplete page', value => { value.hasMore = true; value.nextCursor = '1.' + sha('TEST-cursor'); }],
    ['conversation gap', value => { value.conversation.gaps.push('storage'); }],
    ['fragmented reply', value => { Object.assign(value, { messageTotal: 1, messageParts: [{ index: 0, part: 0, total: 2 }] }); }],
    ['oversized product row', value => { value.messages[0]!.text = 'x'.repeat(384 * 1024); }],
  ];
  for (const [label, change] of cases) {
    const invalid = structuredClone(page); change(invalid);
    assert.throws(() => assertFiniteImportConversationReadback(invalid, correlation), label);
  }
  const successor = structuredClone(correlation);
  (successor.binding as Record<string, unknown>).generation = 'TEST-successor';
  assert.throws(() => assertFiniteImportConversationReadback(page, successor), 'same text cannot cross the original generation');
});

async function inputCorrelationFixture(prefix = '') {
  const { assertFiniteImportInputCorrelation } = await import('./desktop-finite-stopped-import-fixture.ts');
  const { deliveryFingerprint } = await import('../../packages/legacy-agent-host/dist/runtime/identity.js');
  const { prepareRuntimeInput } = await import('../../packages/legacy-agent-host/dist/runtime/inputPreparation.js');
  const binding = { backendId: 'TEST-backend', teamId: randomUUID(), runId: randomUUID(),
    memberId: 'team-lead', generation: 'TEST-original-generation' };
  const logicalId = randomUUID(), operationRef = randomUUID(), nativeId = randomUUID(), nativeSessionId = randomUUID();
  const intent = { binding: structuredClone(binding), deliveryId: logicalId, inputId: logicalId,
    messageId: randomUUID(), content: 'TEST_UI_BOOT' };
  const fingerprint = deliveryFingerprint(intent);
  const input: RuntimeInput = { intent, fingerprint, operationRef, phase: 'terminal', terminal: 'succeeded' };
  if (prefix) input.preparation = prepareRuntimeInput(binding, input,
    { epochIds: [sha('TEST-context-epoch')], teamProof: sha('TEST-context-proof'), prefix }, 65536);
  const capture = { launchId: binding.runId, members: [{ memberId: 'team-lead', principalId: 'TEST-new-principal',
    delivery: { ...binding, teamName: 'test-stopped-legacy' } }] };
  const session = { binding: structuredClone(binding), inputs: [input], phase: 'allocated', custody: 'owned' };
  const peer = { provider: 'claude', role: 'runtime', event: 'input', pid: 202,
    inputId: nativeId, sessionId: nativeSessionId, marker: 'TEST_UI_BOOT', nativePayloadHash: sha(prefix + intent.content) };
  const launch = { provider: 'claude', role: 'runtime', event: 'launch', pid: peer.pid, parentPid: 101,
    sessionId: nativeSessionId, restored: false };
  const initialized = { provider: 'claude', role: 'runtime', event: 'initialized', pid: peer.pid,
    sessionId: nativeSessionId, restored: false };
  const terminal = { provider: 'claude', role: 'runtime', event: 'terminal', pid: peer.pid,
    inputId: nativeId, marker: 'TEST_UI_BOOT', outcome: 'succeeded', text: 'TEST boot ready' };
  const options = { capture, session, effects: [launch, initialized, peer, terminal],
    host: { pid: 101, observedBeforeShutdown: true }, sourceSessionId: randomUUID() };
  return { assertFiniteImportInputCorrelation, options, binding, capture, session, input, peer, launch, initialized, terminal };
}

test('finite import correlation binds distinct logical and wire IDs through exact content and the original owner', async () => {
  for (const prefix of ['', 'TEST native context π\n']) {
    const f = await inputCorrelationFixture(prefix);
    assert.notEqual(f.input.intent.inputId, f.peer.inputId);
    const before = f.assertFiniteImportInputCorrelation(f.options);
    assert.equal(before.inputId, f.input.intent.inputId); assert.equal(before.nativeInputId, f.peer.inputId);
    assert.equal(before.operationRef, f.input.operationRef); assert.equal(before.nativePayloadHash, sha(prefix + f.input.intent.content));
    const stopped = structuredClone(f.options); stopped.session.phase = 'closed'; stopped.session.custody = 'released';
    assert.deepEqual(f.assertFiniteImportInputCorrelation(stopped), before, 'same frozen input survives Stop');
    stopped.session.inputs[0]!.operationRef = randomUUID();
    assert.throws(() => assert.deepEqual(f.assertFiniteImportInputCorrelation(stopped), before),
      'a different logical operation cannot inherit the original frozen correlation');
  }
});

test('finite import correlation rejects forged payload, logical input, binding, session and owner observations', async () => {
  type Fixture = Awaited<ReturnType<typeof inputCorrelationFixture>>;
  const cases: Array<[string, (f: Fixture) => void]> = [
    ['missing payload witness', f => { Object.assign(f.peer, { nativePayloadHash: undefined }); }],
    ['different exact bytes with same visible marker', f => { f.peer.nativePayloadHash = sha('different prefix\nTEST_UI_BOOT'); }],
    ['changed logical identity with old fingerprint', f => {
      f.input.intent.inputId = randomUUID(); f.input.intent.deliveryId = f.input.intent.inputId;
    }],
    ['changed logical content with old fingerprint', f => { f.input.intent.content = 'TEST_UI_HOLD'; }],
    ['changed logical delivery', f => { f.input.intent.deliveryId = randomUUID(); }],
    ['foreign binding generation', f => { f.input.intent.binding.generation = 'TEST-successor'; }],
    ['foreign session binding', f => { f.session.binding.runId = randomUUID(); }],
    ['foreign captured member', f => { f.capture.members[0]!.delivery.memberId = 'other-member'; }],
    ['attachments outside finite text input', f => { Object.assign(f.input.intent, { attachments: [] }); }],
    ['duplicate logical input', f => { f.session.inputs.push(structuredClone(f.input)); }],
    ['duplicate native input', f => { f.options.effects.push(structuredClone(f.peer)); }],
    ['wrong peer role', f => { f.peer.role = 'management'; }],
    ['foreign native session', f => { f.peer.sessionId = randomUUID(); }],
    ['old original source session', f => { f.options.sourceSessionId = f.peer.sessionId; }],
    ['foreign peer process', f => { f.peer.pid += 1; }],
    ['foreign Host owner', f => { f.options.host.pid += 1; }],
    ['Host never physically observed', f => { f.options.host.observedBeforeShutdown = false; }],
    ['native restored instead of fresh', f => { f.launch.restored = true; }],
    ['native terminal from another input', f => { f.terminal.inputId = randomUUID(); }],
    ['native terminal failure', f => { f.terminal.outcome = 'failed'; }],
    ['different native reply', f => { f.terminal.text = 'other reply'; }],
    ['logical terminal failure', f => { f.input.terminal = 'failed'; }],
  ];
  for (const [label, mutate] of cases) {
    const f = await inputCorrelationFixture(); mutate(f);
    assert.throws(() => f.assertFiniteImportInputCorrelation(f.options), label);
  }
  for (const key of ['inputId', 'operationRef', 'intentFingerprint', 'bindingFingerprint', 'prefixHash', 'nativePayloadHash'] as const) {
    const f = await inputCorrelationFixture('TEST original prefix\n');
    f.input.preparation![key] = key.endsWith('Hash') || key.endsWith('Fingerprint') ? '0'.repeat(64) : randomUUID();
    assert.throws(() => f.assertFiniteImportInputCorrelation(f.options), 'forged preparation ' + key);
  }
  for (const malformed of ['missing-epochs', 'missing-team-proof', 'empty-prefix'] as const) {
    const f = await inputCorrelationFixture('TEST original prefix\n');
    if (malformed === 'missing-epochs') Object.assign(f.input.preparation!, { epochIds: undefined });
    if (malformed === 'missing-team-proof') Object.assign(f.input.preparation!, { teamProof: undefined });
    if (malformed === 'empty-prefix') Object.assign(f.input.preparation!, { prefix: '', prefixHash: sha(''),
      nativePayloadHash: sha(f.input.intent.content) });
    assert.throws(() => f.assertFiniteImportInputCorrelation(f.options), malformed);
  }
});

test('finite import peer payload witness hashes the actual parsed SDK bytes without changing ordinary peer records', async () => {
  const peer = await readFile(new URL('../../tools/owned-process-broker/fixtures/claudeProviderPeer.mjs', import.meta.url), 'utf8');
  const start = "  effect({ event: 'input', inputId: selected.id, marker:";
  const end = '\n  if (collaboration?.collaborationMarkers.includes(text))';
  assert.equal(peer.split(start).length, 2); assert.equal(peer.split(end).length, 2);
  const emitOriginalInput = peer.slice(peer.indexOf(start), peer.indexOf(end));
  const raw = 'TEST original SDK context π\nTEST_UI_BOOT', text = 'TEST_UI_BOOT';
  for (const importLifecycle of [false, true]) {
    const observed: Record<string, unknown>[] = [];
    runInNewContext(emitOriginalInput, { importLifecycle, selected: { id: 'TEST-native-uuid' },
      text, raw, probe: 'TEST-probe', session: 'TEST-native-session', createHash,
      effect: (value: Record<string, unknown>) => observed.push(value) });
    assert.equal(observed.length, 1);
    const expected = { event: 'input', inputId: 'TEST-native-uuid', marker: text,
      sessionId: 'TEST-native-session', wrapped: true,
      ...(importLifecycle ? { nativePayloadHash: sha(raw) } : {}) };
    assert.deepEqual(JSON.parse(JSON.stringify(observed[0])), expected);
    if (importLifecycle) assert.notEqual(observed[0]!.nativePayloadHash, sha(text), 'stripped marker is not the payload witness');
  }
});

/** Synthetic protocol inputs only; these unit fixtures never claim an original Main release. */
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-desktop-backend-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['home', 'tmp', 'workspace', 'userData', 'claude', 'claude/teams/test-stopped-legacy', 'claude/tasks/test-stopped-legacy'])
    await mkdir(join(root, name), { recursive: true, mode: 0o700 });
  const prefix = 'agent-teams-bootstrap-' + sha(join(root, 'userData')).slice(0, 16) + '-';
  const specDirectory = await mkdtemp(join(root, 'tmp', prefix)); await chmod(specDirectory, 0o700);
  const promptDirectory = await mkdtemp(join(root, 'tmp/agent-teams-bootstrap-prompt-')); await chmod(promptDirectory, 0o700);
  const team = join(root, 'claude/teams/test-stopped-legacy'), specPath = join(specDirectory, 'bootstrap.json');
  const markerPath = join(specDirectory, '.agent-teams-bootstrap-owner.json'), promptPath = join(promptDirectory, randomUUID() + '.txt');
  const runId = randomUUID();
  const spec = { version: 1, runId, mode: 'create', initiator: { kind: 'app', source: 'claude_team_agent_teams_orchestrator' },
    team: { name: 'test-stopped-legacy', cwd: join(root, 'workspace') }, lead: {}, members: [], ui: { emitStructuredEvents: true } };
  const meta = { version: 1, cwd: join(root, 'workspace'), model: 'claude-sonnet-4-6', providerId: 'anthropic', skipPermissions: false, prompt };
  for (const [path, value, mode] of [
    [specPath, spec, 0o600],
    [markerPath, { version: 1, kind: 'agent-teams-bootstrap', ownerPid: process.pid, specFile: 'bootstrap.json' }, 0o600],
    [join(team, 'team.meta.json'), meta, 0o644], [join(team, 'members.meta.json'), { version: 1, members: [] }, 0o644],
    [join(root, 'userData/mcp.json'), { mcpServers: {} }, 0o644],
  ] as const) await writeFile(path, JSON.stringify(value), { mode, flag: 'wx' });
  await writeFile(promptPath, deferredPrompt, { mode: 0o600, flag: 'wx' });
  const env = { HOME: join(root, 'home'), CLAUDE_ROOT: join(root, 'claude'), CLAUDE_CONFIG_DIR: join(root, 'claude'),
    TMPDIR: join(root, 'tmp'), PATH: dirname(process.execPath) + ':/usr/bin:/bin',
    TEST_LEGACY_BOOTSTRAP: 'current-solo-v1', TEST_LEGACY_BOOTSTRAP_ROOT: root, TEST_LEGACY_BOOTSTRAP_VERSION: '0.0.158',
    TEST_LEGACY_BOOTSTRAP_REPO: root };
  const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--setting-sources', 'user,project,local', '--mcp-config', join(root, 'userData/mcp.json'), '--team-bootstrap-spec', specPath,
    '--team-bootstrap-user-prompt-file', promptPath, '--disallowedTools', 'Agent', '--permission-mode', 'default',
    '--permission-prompt-tool', 'stdio', '--model', 'claude-sonnet-4-6'];
  const run = (selectedArgs = args, selectedEnv: NodeJS.ProcessEnv = env, cwd = join(root, 'workspace')) =>
    spawnSync(process.execPath, [source, ...selectedArgs], { env: selectedEnv, cwd, encoding: 'utf8', timeout: 3000, maxBuffer: 128 * 1024 });
  return { root, team, specPath, markerPath, promptPath, runId, spec, meta, env, args, run };
}

test('finite legacy bootstrap consumes original-format private input and never writes Main lifecycle authority', { timeout: 10000 }, async t => {
  const f = await fixture(t), metaBefore = await readFile(join(f.team, 'team.meta.json'), 'utf8');
  const child = spawn(process.execPath, [source, ...f.args], { cwd: join(f.root, 'workspace'), env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let output = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { stderr += data; });
  const until = Date.now() + 3000;
  while (!output.includes('"subtype":"success"') && child.exitCode === null && Date.now() < until)
    await new Promise<void>(done => setTimeout(done, 20));
  assert.ok(output.includes('"subtype":"success"'), stderr); assert.equal(child.exitCode, null, 'runtime is alive until owner Stop');
  const frames = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(frames.filter(frame => frame.type === 'result').length, 1);
  assert.equal(frames.at(-1).result, 'REPLY_TEST_CURRENT_LEGACY_SOLO_ONE');
  const bootstrap = frames.filter(frame => frame.subtype === 'team_bootstrap');
  assert.deepEqual(bootstrap.map(frame => frame.event), ['started', 'team_created', 'completed']);
  assert.ok(bootstrap.every(frame => frame.run_id === f.runId && frame.team_name === 'test-stopped-legacy'));
  const config = JSON.parse(await readFile(join(f.team, 'config.json'), 'utf8'));
  assert.equal(config.leadSessionId, frames.at(-1).session_id); assert.equal(config.members.length, 1);
  assert.equal(await readFile(join(f.team, 'team.meta.json'), 'utf8'), metaBefore);
  assert.equal(JSON.parse(await readFile(f.markerPath, 'utf8')).consumerPid, child.pid);
  await assert.rejects(lstat(f.specPath), { code: 'ENOENT' }); await assert.rejects(lstat(f.promptPath), { code: 'ENOENT' });
  for (const name of ['launch-state.json', 'launch-freshness.json', 'launch-stopped.json', 'nativeRelease.json'])
    await assert.rejects(lstat(join(f.team, name)), { code: 'ENOENT' });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => child.once('exit', (code, signal) => done({ code, signal })));
  child.kill('SIGTERM'); assert.deepEqual(await exit, { code: 0, signal: null });
});

test('closed finite version, runtime/model metadata and exact PONG checks never create a source config', async t => {
  const f = await fixture(t);
  for (const args of [['--version'], ['runtime', 'status', '--json', '--summary', '--provider', 'anthropic'],
    ['runtime', 'status', '--json', '--provider', 'anthropic', '--summary'],
    ['runtime', 'status', '--json', '--provider', 'anthropic'],
    ['model', 'list', '--json', '--provider', 'anthropic'], ['auth', 'status', '--json', '--provider', 'anthropic'],
    ['-p', 'Output only the single word PONG.', '--output-format', 'text', '--model', 'haiku', '--max-turns', '1', '--no-session-persistence']]) {
    const result = f.run(args); assert.equal(result.status, 0, result.stderr);
    if (args[0] === 'runtime') assert.equal(JSON.parse(result.stdout).providers.anthropic.statusCheckOutcome, 'authoritative');
  }
  const journal = join(f.root, 'finite-legacy-peer.ndjson'), before = await readFile(journal, 'utf8');
  assert.deepEqual(before.trim().split('\n').map(line => JSON.parse(line)).filter(value => value.operation === 'runtime')
    .map(value => value.args), [['--json', '--summary', '--provider', 'anthropic'],
      ['--json', '--provider', 'anthropic', '--summary'], ['--json', '--provider', 'anthropic']]);
  for (const args of [
    ['runtime', 'status', '--json', '--summary', '--provider', 'anthropic', '--summary'],
    ['runtime', 'status', '--json', '--summary', '--summary', '--provider', 'anthropic'],
    ['runtime', 'status', '--json', '--provider', 'anthropic', '--summary', '--summary'],
    ['runtime', 'status', '--json', '--provider', 'anthropic', '--summary', '--unexpected'],
    ['runtime', 'status', '--json', '--provider', 'codex', '--summary'],
    ['runtime', 'status', '--json', '--provider', 'opencode', '--summary'],
    ['runtime', 'status', '--json', '--provider', '--summary'],
    ['runtime', 'status', '--json', '--provider', 'anthropic', '--summary', 'anthropic'],
    ['runtime', 'status', '--summary', '--json', '--provider', 'anthropic'],
    ['runtime', 'status', '--json', '--provider', 'anthropic', '--provider', 'anthropic', '--summary'],
    ['runtime', 'status', '--json', '--provider', 'anthropic', '--summary=true'],
    ...(['model', 'auth'] as const).flatMap(kind => [
      [kind, kind === 'model' ? 'list' : 'status', '--json', '--summary', '--provider', 'anthropic'],
      [kind, kind === 'model' ? 'list' : 'status', '--json', '--provider', 'anthropic', '--summary'],
    ]),
  ]) {
    const result = f.run(args); assert.equal(result.status, 1, JSON.stringify(args));
    assert.equal(result.signal, null); assert.equal(result.error, undefined);
    assert.equal(result.stdout, ''); assert.match(result.stderr, /AssertionError/);
  }
  assert.equal(await readFile(journal, 'utf8'), before, 'rejected metadata flags emit no peer effects');
  await assert.rejects(lstat(join(f.team, 'config.json')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(f.markerPath, 'utf8')).consumerPid, undefined);
});

test('original Main provider-scoped summary argv is admitted without finite bootstrap authority', async t => {
  const f = await fixture(t);
  const main = await readFile(new URL('../../src/main/services/runtime/ClaudeMultimodelBridgeService.ts', import.meta.url), 'utf8');
  const begin = "    const args = ['runtime', 'status', '--json', '--provider', providerId];";
  const end = '    const timeout = this.getProviderStatusRuntimeTimeout';
  assert.equal(main.split(begin).length, 2); assert.equal(main.split(end).length, 2);
  const block = main.slice(main.indexOf(begin), main.indexOf(end));
  const expectedArgs: string[][] = [];
  for (const summary of [true, false]) {
    // Execute only the actual Main argument builder, with no service/process/IO methods available.
    const args = Array.from(runInNewContext('(() => {' + block + 'return args;})()', {
      providerId: 'anthropic', options: { summary }, context: { projectArgs: [] },
    }) as string[]);
    assert.deepEqual(args, ['runtime', 'status', '--json', '--provider', 'anthropic', ...(summary ? ['--summary'] : [])]);
    expectedArgs.push(args.slice(2));
    const result = f.run(args); assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(response.providers), ['anthropic']);
    assert.equal(response.providers.anthropic.supported, true);
    assert.equal(response.providers.anthropic.statusCheckOutcome, 'authoritative');
  }
  const effects = (await readFile(join(f.root, 'finite-legacy-peer.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(effects.map(row => [row.event, row.operation, row.args]),
    expectedArgs.map(args => ['metadata-control', 'runtime', args]));
  assert.equal(JSON.parse(await readFile(f.markerPath, 'utf8')).consumerPid, undefined);
  assert.equal(await readFile(f.promptPath, 'utf8'), deferredPrompt);
  assert.deepEqual(JSON.parse(await readFile(f.specPath, 'utf8')), f.spec);
  for (const name of ['config.json', 'launch-state.json', 'launch-freshness.json', 'launch-stopped.json', 'nativeRelease.json'])
    await assert.rejects(lstat(join(f.team, name)), { code: 'ENOENT' });
});

for (const scenario of ['extra-cli', 'wrong-provider', 'host-descriptor', 'outside-cwd', 'mixed-roster', 'wrong-prompt', 'wrong-profile-prefix', 'symlink-meta', 'source-config-present', 'world-writable-meta'] as const) {
  test('finite legacy source refuses ' + scenario + ' before runtime publication', async t => {
    const f = await fixture(t); let args = f.args, env: NodeJS.ProcessEnv = f.env, cwd = join(f.root, 'workspace');
    if (scenario === 'extra-cli') args = [...args, '--dangerously-skip-permissions'];
    if (scenario === 'wrong-provider') args = ['runtime', 'status', '--json', '--provider', 'codex'];
    if (scenario === 'host-descriptor') env = { ...env, AGENT_TEAMS_BACKEND_DESCRIPTOR_PATH: join(f.root, 'host.json') };
    if (scenario === 'outside-cwd') cwd = f.root;
    if (scenario === 'mixed-roster') await writeFile(f.specPath, JSON.stringify({ ...f.spec, members: [{ name: 'alice', provider: 'codex' }] }));
    if (scenario === 'wrong-prompt') await writeFile(f.promptPath, deferredPrompt + '\nexecute something else');
    if (scenario === 'wrong-profile-prefix') {
      const bad = join(f.root, 'tmp/agent-teams-bootstrap-0000000000000000-bad'); await mkdir(bad, { mode: 0o700 });
      args = args.map(value => value === f.specPath ? join(bad, 'bootstrap.json') : value);
    }
    if (scenario === 'symlink-meta') {
      const path = join(f.team, 'team.meta.json'), target = join(f.root, 'meta.json');
      await writeFile(target, JSON.stringify(f.meta), { mode: 0o600 }); await rm(path); await symlink(target, path);
    }
    if (scenario === 'source-config-present') await writeFile(join(f.team, 'config.json'), 'TEST existing source bytes', { mode: 0o600 });
    if (scenario === 'world-writable-meta') await chmod(join(f.team, 'team.meta.json'), 0o666);
    const result = f.run(args, env, cwd); assert.notEqual(result.status, 0); assert.notEqual(result.signal, 'SIGTERM', 'refusal cannot be a timeout');
    if (scenario === 'source-config-present') assert.equal(await readFile(join(f.team, 'config.json'), 'utf8'), 'TEST existing source bytes');
    else await assert.rejects(lstat(join(f.team, 'config.json')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(f.team, 'launch-stopped.json')), { code: 'ENOENT' });
  });
}
