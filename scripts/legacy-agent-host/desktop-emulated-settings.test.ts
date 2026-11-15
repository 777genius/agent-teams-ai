import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { FileManagementCommandStore } from '../../packages/legacy-agent-host/dist/adapters/providers/FileManagementCommandStore.js';
import { ClaudeAuthenticationCoordinator } from '../../packages/legacy-agent-host/dist/composition/ClaudeAuthenticationCoordinator.js';
import { ClaudeManagementCoordinator } from '../../packages/legacy-agent-host/dist/composition/ClaudeManagementCoordinator.js';
import { ClaudeAuthConversation } from '../../packages/legacy-agent-host/dist/adapters/providers/ClaudeAuthConversation.js';
import { teamModelProbeProfile } from '../../packages/legacy-agent-host/dist/composition/teamLaunchModelProbe.js';
import { runtimeMemberProfileSchema } from '../../packages/legacy-agent-host/dist/composition/runtimeProfile.js';
import { NativeExtensionCoordinator } from '../../packages/legacy-agent-host/dist/extensions/NativeExtensionCoordinator.js';
import { claudeManagementProfileSchema } from '../../packages/legacy-agent-host/dist/management/profile.js';
import { ManagementResourceFence } from '../../packages/legacy-agent-host/dist/management/ManagementResourceFence.js';
import { ModelProbeOwner } from '../../packages/legacy-agent-host/dist/management/ModelProbeOwner.js';
import { desktopNodeScriptHeader, digest, fileDigest } from './desktop-backend-fixture.ts';
import { projectDesktopMixedSettingsFailure } from './desktop-backend-failures.ts';
import { projectDesktopProofReceiptSummary } from './desktop-proof-evidence.ts';
import { assertDesktopEmulatedImportModelChecks } from './desktop-emulated-import-ui.ts';
import { desktopEmulatedClaudeSettingsWrapper } from './desktop-emulated-claude-settings-fixture.ts';
import { extensionMcpName, extensionMcpUrl, extensionPlugin } from './desktop-native-extensions-fixture.ts';
import type { ClaudeManagementProfile } from '../../packages/legacy-agent-host/dist/management/profile.js';
import type { TestContext } from 'node:test';

type Row = Record<string, unknown>;
async function fixture(t: TestContext, kind: 'extensions' | 'saved-import') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-desktop-backend-settings-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const peerRoot = join(root, 'TEST-peer-claude-scope');
  for (const directory of [peerRoot, join(root, 'workspace'), join(root, 'hoststore'),
    ...['home', 'config', 'tmp'].map(name => join(peerRoot, name))]) await mkdir(directory, { mode: 0o700 });
  const node = await realpath(process.execPath);
  const source = await realpath(join(import.meta.dirname, '../../tools/owned-process-broker/fixtures',
    kind === 'extensions' ? 'claudeExtensionsPeer.mjs' : 'claudeSavedImportPeer.mjs'));
  const sourceSha256 = await fileDigest(source);
  const authSource = await realpath(join(import.meta.dirname, '../../tools/owned-process-broker/fixtures/claudeSettingsAuthPeer.ts'));
  const authSha256 = await fileDigest(authSource);
  const wrapper = kind === 'saved-import' ? desktopEmulatedClaudeSettingsWrapper(node, kind,
    [{ path: source, sha256: sourceSha256 }, { path: authSource, sha256: authSha256 }])
    : `${desktopNodeScriptHeader(node)}import assert from 'node:assert/strict';
import{createHash}from'node:crypto';import{readFileSync,realpathSync}from'node:fs';
assert.equal(realpathSync(${JSON.stringify(source)}),${JSON.stringify(source)});
assert.equal(createHash('sha256').update(readFileSync(${JSON.stringify(source)})).digest('hex'),${JSON.stringify(sourceSha256)});
assert.equal(realpathSync(${JSON.stringify(authSource)}),${JSON.stringify(authSource)});
assert.equal(createHash('sha256').update(readFileSync(${JSON.stringify(authSource)})).digest('hex'),${JSON.stringify(authSha256)});
await import(process.argv[2]==='auth'?${JSON.stringify(pathToFileURL(authSource).href)}:${JSON.stringify(pathToFileURL(source).href)});
`;
  const executable = { path: join(root, 'TEST-selected-cli'), sha256: digest(wrapper) };
  await writeFile(executable.path, wrapper, { mode: 0o700, flag: 'wx' });
  const effectsPath = join(peerRoot, 'effects.ndjson');
  const profile: ClaudeManagementProfile = claudeManagementProfileSchema.parse({
    provider: 'claude', profileId: 'TEST-selected-settings', configRevision: 'TEST-selected-settings-v1',
    sdkRevision: '0.3.305', configNamespace: 'custom-directory', accountBinding: 'TEST-no-vendor-account',
    executable, cwd: join(root, 'workspace'), settingSources: ['user', 'project', 'local'],
    timeoutMs: 5000, modelProbeTimeoutMs: 5000,
    environment: { HOME: join(peerRoot, 'home'), CLAUDE_CONFIG_DIR: join(peerRoot, 'config'),
      TMPDIR: join(peerRoot, 'tmp'), PATH: `${dirname(node)}:/usr/bin:/bin`, SHELL: '/bin/sh',
      TEST_EMULATED_DESKTOP_PROVIDER: '1', TEST_PEER_SCENARIO: 'desktop-ui-v1', TEST_PEER_PROVIDER: 'claude',
      TEST_PEER_ROLE: 'management', TEST_DESKTOP_SETTINGS: kind, TEST_DESKTOP_PEER_ROOT: peerRoot,
      TEST_DESKTOP_PEER_WORKSPACE: join(root, 'workspace'), TEST_PEER_EFFECTS: effectsPath,
      ANTHROPIC_API_KEY: 'TEST-LOCALHOST-ONLY', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' },
  });
  const effects = async (): Promise<Row[]> => (await readFile(effectsPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const store = new FileManagementCommandStore(join(root, 'hoststore'));
  const management = new ClaudeManagementCoordinator([profile], () => {});
  t.after(() => management.close());
  return { root, peerRoot, profile, store, management, effects };
}

for (const kind of ['extensions', 'saved-import'] as const)
test(`${kind} Settings peer exposes only isolated auth status through original custody`, { timeout: 10000 }, async t => {
  const f = await fixture(t, kind);
  const auth = new ClaudeAuthConversation(f.profile, () => true); t.after(() => auth.close());
  assert.deepEqual(await auth.read(new AbortController().signal), {
    loggedIn: true, authMethod: 'api_key', forcedLoginMethod: null,
  });
  assert.equal((await f.effects()).filter(row => row.event === 'auth-status').length, 1);
  for (const args of [['auth', 'logout'], ['auth', 'status'], ['auth', 'status', '--json', '--other']]) {
    const result = spawnSync(f.profile.executable.path, args, { cwd: f.profile.cwd,
      env: f.profile.environment, timeout: 3000 });
    assert.notEqual(result.status, 0);
  }
  assert.equal((await f.effects()).filter(row => row.event === 'auth-status').length, 1);
  assert.deepEqual([...f.store.list()], [], 'status never creates a management mutation receipt');
});

test('finite extension status uses the original Host auth command and retains its exact private namespace', { timeout: 15000 }, async t => {
  const f = await fixture(t, 'extensions');
  const identity = { profileId: f.profile.profileId, configRevision: f.profile.configRevision };
  const auth = new ClaudeAuthenticationCoordinator([f.profile], (id, revision) => f.management.target(id, revision), () => {});
  t.after(() => auth.close());
  const status = await auth.read(identity);
  assert.deepEqual(status, { ...identity, loggedIn: true, authMethod: 'api_key', canLogin: false, canLogout: false });
  const effects = await f.effects();
  assert.deepEqual(effects.filter(row => row.event === 'launch').map(row => row.command), [['auth', 'status', '--json']]);
  assert.equal(effects.filter(row => row.event === 'auth-status').length, 1);
  assert.equal(effects.some(row => row.event === 'extension-command' || row.event === 'failure'), false);
  assert.deepEqual([...f.store.list()], []);
  await assert.rejects(readFile(join(f.peerRoot, 'config/settings.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(f.peerRoot, 'config/.claude.json')), { code: 'ENOENT' });
});

test('finite extensions run through original Host ownership, persist four commands and survive inventory reload without replay', { timeout: 15000 }, async t => {
  const f = await fixture(t, 'extensions');
  const nativeConfig = join(f.peerRoot, 'config/.claude.json');
  const settings = join(f.peerRoot, 'config/settings.json');
  await writeFile(nativeConfig, JSON.stringify({ TEST_neighbor: { exact: true }, mcpServers: {} }), { mode: 0o600 });
  await writeFile(settings, JSON.stringify({ TEST_neighbor: 'unchanged', enabledPlugins: {} }), { mode: 0o600 });
  const create = (store = f.store) => new NativeExtensionCoordinator([f.profile], {
    store, fence: new ManagementResourceFence(store.list()), assertCurrent: () => {},
    managementTarget: (id, revision) => f.management.target(id, revision),
  });
  const owner = create(); t.after(() => owner.close());
  const identity = { profileId: f.profile.profileId, configRevision: f.profile.configRevision };
  const plugin = owner.capture({ ...identity, panel: 'plugins', scope: 'user' });
  const install = { ...plugin, commandId: 'TEST-plugin-install', command: {
    action: 'plugin.install', qualifiedName: extensionPlugin, scope: 'user' } };
  const installedReceipt = await owner.mutations.execute(install);
  assert.equal(installedReceipt.phase, 'completed', JSON.stringify({ receipt: installedReceipt,
    records: [...f.store.list()], effects: await f.effects().catch(() => []) }));
  const installed = owner.read(plugin).entries;
  assert.equal(installed.length, 1); assert.ok('pluginId' in installed[0]!);
  assert.equal(installed[0]!.pluginId, extensionPlugin);
  assert.deepEqual(await owner.mutations.execute(install), owner.mutations.lookup({ ...plugin, commandId: install.commandId }));
  assert.equal((await f.effects()).filter(row => row.event === 'extension-command').length, 1, 'same command lookup/replay cannot spawn another CLI');
  const reloaded = create(new FileManagementCommandStore(join(f.root, 'hoststore')));
  t.after(() => reloaded.close());
  assert.deepEqual(reloaded.read(plugin).entries, installed, 'fresh coordinator reads actual selected config');
  assert.equal((await owner.mutations.execute({ ...plugin, commandId: 'TEST-plugin-uninstall', command: {
    action: 'plugin.uninstall', qualifiedName: extensionPlugin, scope: 'user' } })).phase, 'completed');
  assert.deepEqual(reloaded.read(plugin).entries, []);
  const mcp = owner.capture({ ...identity, panel: 'mcp', scope: 'global' });
  assert.equal((await owner.mutations.execute({ ...mcp, commandId: 'TEST-mcp-install', command: {
    action: 'mcp.install', scope: 'global', serverName: extensionMcpName,
    installSpec: { type: 'http', transportType: 'http', url: extensionMcpUrl }, envValues: {}, headers: [] } })).phase, 'completed');
  const inventory = reloaded.read(mcp).entries;
  assert.equal(inventory.length, 1); assert.ok('name' in inventory[0]!);
  assert.equal(inventory[0]!.name, extensionMcpName);
  const diagnostics = (await owner.diagnose({ ...mcp, panel: 'mcp' })).entries;
  assert.equal(diagnostics.length, 1); assert.equal(diagnostics[0]!.name, extensionMcpName);
  assert.equal(diagnostics[0]!.status, 'failed', 'finite disconnected TEST target never claims connected');
  assert.equal((await owner.mutations.execute({ ...mcp, commandId: 'TEST-mcp-uninstall', command: {
    action: 'mcp.uninstall', scope: 'global', serverName: extensionMcpName } })).phase, 'completed');
  assert.deepEqual(reloaded.read(mcp).entries, []);
  const records = [...f.store.list()];
  assert.equal(records.length, 4); assert.equal(new Set(records.map(row => row.commandId)).size, 4);
  assert.ok(records.every(row => row.kind === 'extension.mutation' && row.phase === 'completed' && !row.resourceHeld));
  assert.deepEqual(JSON.parse(await readFile(nativeConfig, 'utf8')), { TEST_neighbor: { exact: true }, mcpServers: {} });
  assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')), { TEST_neighbor: 'unchanged', enabledPlugins: {} });
  assert.equal((await f.effects()).filter(row => row.event === 'extension-command').length, 4);
});

test('finite extension CLI refuses changed names/scopes and does not overwrite selected config', async t => {
  const f = await fixture(t, 'extensions'), path = join(f.peerRoot, 'config/.claude.json');
  const original = JSON.stringify({ TEST_unchanged: true }); await writeFile(path, original, { mode: 0o600 });
  for (const args of [['mcp', 'add', '-s', 'user', '-t', 'http', 'unselected', extensionMcpUrl],
    ['plugin', 'install', '-s', 'project', extensionPlugin], ['plugin', 'marketplace', 'add', 'https://example.com'],
    ['auth', 'login', '--claudeai'], ['auth', 'logout'], ['auth', 'status', '--json', '--extra']]) {
    const result = spawnSync(f.profile.executable.path, args, { cwd: f.profile.cwd, env: f.profile.environment, timeout: 5000 });
    assert.equal(result.status, 78); assert.equal(await readFile(path, 'utf8'), original);
  }
  assert.equal([...f.store.list()].length, 0);
  assert.equal((await f.effects()).filter(row => row.event === 'extension-command').length, 0);
});

test('saved-import finite metadata and actual original probe receipt preserve model/effort with no extra input on lookup', { timeout: 15000 }, async t => {
  const f = await fixture(t, 'saved-import');
  const identity = { profileId: f.profile.profileId, configRevision: f.profile.configRevision };
  const metadata = await f.management.read(identity);
  assert.equal(metadata.models.length, 1); assert.equal(metadata.models[0]!.modelId, 'claude-sonnet-4-6');
  assert.equal(metadata.models[0]!.displayName, 'Sonnet 4.6');
  const auth = new ClaudeAuthenticationCoordinator([f.profile], (id, revision) => f.management.target(id, revision), () => {});
  t.after(() => auth.close());
  assert.deepEqual(await auth.read(identity), {
    ...identity, loggedIn: true, authMethod: 'api_key', canLogin: false, canLogout: false,
  });
  const probeProfile = teamModelProbeProfile(runtimeMemberProfileSchema.parse({
    provider: 'claude', teamId: 'TEST-team', memberId: 'TEST-member', principalId: 'TEST-principal',
    sessionId: 'TEST-session', generation: 1, configRevision: 'TEST-runtime-selection',
    executable: f.profile.executable, cwd: f.profile.cwd, accountBinding: f.profile.accountBinding,
    environment: { ...f.profile.environment, TEST_PEER_ROLE: 'runtime' },
    model: 'claude-sonnet-4-6', configNamespace: 'custom-directory', nativeTools: [], autoAllowedTools: [],
    nativeOptions: { settingSources: [...f.profile.settingSources!], effort: 'low' },
    limits: { queuedInputs: 1, inputBytes: 65536, outputBytes: 65536, outputEvents: 32,
      pendingInteractions: 1, timeoutMs: 5000 },
  }));
  assert.equal(probeProfile.provider, 'claude');
  if (probeProfile.provider !== 'claude') throw new Error('Original Claude probe required');
  assert.equal(probeProfile.environment.TEST_PEER_ROLE, 'runtime');
  assert.deepEqual(probeProfile.settingSources, f.profile.settingSources);
  assert.deepEqual(probeProfile.executable, f.profile.executable);
  f.management.admitProbeProfile(probeProfile);
  const probes = new ModelProbeOwner({ store: f.store, fence: new ManagementResourceFence(f.store.list()),
    assertWriter: () => {}, select: (id, revision) => f.management.target(id, revision),
    prepare: (input, current) => f.management.prepareProbe(input, current) });
  t.after(() => probes.close());
  const input = { profileId: probeProfile.profileId, configRevision: probeProfile.configRevision,
    commandId: 'TEST-original-import-probe', providerId: 'anthropic', modelId: 'claude-sonnet-4-6', effort: 'low',
    modelContext: 'model-default' as const };
  probes.start(input);
  const deadline = performance.now() + 7000;
  const probeIdentity = { profileId: input.profileId, configRevision: input.configRevision, commandId: input.commandId };
  while (probes.read(probeIdentity)?.phase === 'running' && performance.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 20));
  const original = probes.read(probeIdentity);
  assert.equal(original?.phase, 'completed', JSON.stringify({ original, effects: await f.effects() }));
  assert.equal(original.ok, true, JSON.stringify({ original, effects: await f.effects() }));
  assert.deepEqual(probes.start(input), original);
  const records = [...f.store.list()] as unknown as Row[];
  const effects = await f.effects();
  const observed = assertDesktopEmulatedImportModelChecks(records, effects, { model: input.modelId, effort: input.effort });
  assert.equal(observed.length, 1); assert.equal(observed[0]!.role, 'runtime');
  assert.equal(original.profileId, probeProfile.profileId);
  assert.throws(() => assertDesktopEmulatedImportModelChecks(records,
    effects.map(row => row.role === 'runtime' ? { ...row, role: 'management' } : row),
    { model: input.modelId, effort: input.effort }));
  assert.throws(() => assertDesktopEmulatedImportModelChecks(records, [...effects, observed[0]!], { model: input.modelId, effort: input.effort }));
  assert.throws(() => assertDesktopEmulatedImportModelChecks(records, effects.map(row => row.event === 'input' ? { ...row, requestedEffort: 'high' } : row), { model: input.modelId, effort: input.effort }));
  assert.throws(() => assertDesktopEmulatedImportModelChecks(records, effects.filter(row => row.event !== 'terminal'), { model: input.modelId, effort: input.effort }));
});

test('saved-import peer refuses a business input without producing a probe or touching Host receipts', async t => {
  const f = await fixture(t, 'saved-import');
  const session = '11111111-1111-4111-8111-111111111111';
  const args = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
    '--effort=low', '--max-turns=1', '--model=claude-sonnet-4-6', '--permission-prompt-tool=stdio',
    '--tools=', '--setting-sources=user,project,local', '--strict-mcp-config', '--permission-mode=dontAsk',
    `--session-id=${session}`, '--no-session-persistence', '--settings', '{"disableAllHooks":true}'];
  const input = [
    { type: 'control_request', request_id: 'TEST-initialize', request: { subtype: 'initialize' } },
    { type: 'user', uuid: '22222222-2222-4222-8222-222222222222', session_id: session,
      parent_tool_use_id: null, message: { role: 'user', content: 'TEST launch an unrelated Team' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n';
  const result = spawnSync(f.profile.executable.path, args, { cwd: f.profile.cwd,
    env: { ...f.profile.environment, TEST_PEER_ROLE: 'runtime' }, input, timeout: 5000 });
  assert.equal(result.status, 78);
  const effects = await f.effects();
  assert.equal(effects.filter(row => row.event === 'failure').length, 1);
  assert.equal(effects.filter(row => row.event === 'input' || row.event === 'terminal').length, 0);
  assert.deepEqual([...f.store.list()], []);
  for (const [role, command, status] of [
    ['runtime', ['auth', 'status', '--json'], 1],
    ['management', ['auth', 'login', '--claudeai'], 78],
    ['management', ['auth', 'logout'], 78],
    ['management', args, 1],
    ['runtime', args.filter(arg => !/^--(?:model|effort|permission-prompt-tool|session-id)=/u.test(arg)), 1],
    ['runtime', args.map(arg => arg === '--tools=' ? '--tools=Read' : arg), 1],
    ['runtime', [...args, '--mcp-config={}'], 1],
  ] as const) {
    const refused = spawnSync(f.profile.executable.path, [...command], { cwd: f.profile.cwd,
      env: { ...f.profile.environment, TEST_PEER_ROLE: role }, input, timeout: 5000 });
    assert.equal(refused.status, status, JSON.stringify({ role, command }));
  }
  assert.equal((await f.effects()).some(row =>
    row.event === 'auth-status' || row.event === 'input' || row.event === 'terminal'), false);
  for (const name of ['settings.json', '.claude.json'])
    await assert.rejects(readFile(join(f.peerRoot, 'config', name)), { code: 'ENOENT' });
  assert.deepEqual([...f.store.list()], []);
});

test('receipt summaries retain only the original nested mixed Settings owner', () => {
  const secret = 'TEST-private-settings-URL-path-credential';
  const settings = { status: 'INCOMPLETE', secret,
    steps: [{ step: 'project-default', phase: 'completed', resourceHeld: false }],
    projectOverride: { secret }, originalSettingsOwnersReleased: true, sameSettingsAfterCold: false };
  const evidence = { status: 'INCOMPLETE', providerSettings: { status: 'PASS', secret, steps: [] },
    mixedCreateLaunchProof: { status: 'INCOMPLETE', openCodeGeneration: 'v2', steps: [], providerSettings: settings },
    coldSettingsBoundary: { status: 'INCOMPLETE', firstQuit: { attempted: true } },
    cleanup: { remaining: [], appExitCode: 0, capturedHostAbsent: true, writerLockReleased: true } };
  const before = structuredClone(evidence);
  const options = { receiptPath: 'TEST-receipt', mode: 'mixed-create-launch-ui', mixedMode: true };
  const summary = projectDesktopProofReceiptSummary(evidence, options);
  const projection = projectDesktopMixedSettingsFailure(evidence);
  assert.ok('settingsRecorded' in projection);
  assert.equal(projection.settingsRecorded, true);
  assert.equal(projection.settingsStatus, 'INCOMPLETE');
  assert.deepEqual(projection.settingsSteps, settings.steps);
  assert.notEqual(projection.settingsSteps, settings.steps);
  assert.notEqual(projection.settingsSteps?.[0], settings.steps[0]);
  assert.equal(projection.milestones.projectOverrideRecorded, true);
  assert.equal(projection.originalSettingsOwnersReleased, true);
  assert.equal(projection.sameSettingsAfterCold, false);
  assert.equal(projection.quitAttempted, true);
  assert.deepEqual(summary.mixedSettingsFailure, projection, 'the final receipt uses the same original owner');
  assert.equal(JSON.stringify(summary).includes(secret), false);
  assert.deepEqual(evidence, before, 'the original retained proof is not rewritten or aliased');

  const missing = { ...evidence, mixedCreateLaunchProof: { steps: [] } };
  const missingProjection = projectDesktopMixedSettingsFailure(missing);
  assert.ok('settingsRecorded' in missingProjection);
  assert.equal(missingProjection.settingsRecorded, false);
  assert.equal(missingProjection.settingsStatus, null);
  assert.deepEqual(projectDesktopProofReceiptSummary(missing, options).mixedSettingsFailure, missingProjection,
    'a foreign root Settings record cannot substitute for the missing nested owner');
  let getterReads = 0;
  const malformed = { ...evidence, mixedCreateLaunchProof: Object.defineProperty(
    { ...evidence.mixedCreateLaunchProof }, 'providerSettings',
    { get() { getterReads++; throw new Error(secret); } }) };
  const malformedProjection = projectDesktopMixedSettingsFailure(malformed);
  assert.ok('settingsRecorded' in malformedProjection);
  assert.equal(malformedProjection.settingsRecorded, null);
  assert.deepEqual(projectDesktopProofReceiptSummary(malformed, options).mixedSettingsFailure, malformedProjection);
  assert.equal(getterReads, 0, 'summary extraction does not invoke retained accessors');
  assert.equal('mixedSettingsFailure' in projectDesktopProofReceiptSummary(
    { ...evidence, status: 'PASS' }, options), false);
  assert.equal('mixedSettingsFailure' in projectDesktopProofReceiptSummary(
    evidence, { ...options, mixedMode: false }), false);
});
