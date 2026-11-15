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
import { NativeExtensionCoordinator } from '../../packages/legacy-agent-host/dist/extensions/NativeExtensionCoordinator.js';
import { claudeManagementProfileSchema } from '../../packages/legacy-agent-host/dist/management/profile.js';
import { ManagementResourceFence } from '../../packages/legacy-agent-host/dist/management/ManagementResourceFence.js';
import { ModelProbeOwner } from '../../packages/legacy-agent-host/dist/management/ModelProbeOwner.js';
import { desktopNodeScriptHeader, digest, fileDigest } from './desktop-backend-fixture.ts';
import { assertDesktopEmulatedImportModelChecks } from './desktop-emulated-import-ui.ts';
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
  const wrapper = `${desktopNodeScriptHeader(node)}import assert from 'node:assert/strict';
import{createHash}from'node:crypto';import{readFileSync,realpathSync}from'node:fs';
assert.equal(realpathSync(${JSON.stringify(source)}),${JSON.stringify(source)});
assert.equal(createHash('sha256').update(readFileSync(${JSON.stringify(source)})).digest('hex'),${JSON.stringify(sourceSha256)});
await import(${JSON.stringify(pathToFileURL(source).href)});
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
      TEST_DESKTOP_PEER_WORKSPACE: join(root, 'workspace'), TEST_PEER_EFFECTS: effectsPath },
  });
  const effects = async (): Promise<Row[]> => (await readFile(effectsPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const store = new FileManagementCommandStore(join(root, 'hoststore'));
  const management = new ClaudeManagementCoordinator([profile], () => {});
  t.after(() => management.close());
  return { root, peerRoot, profile, store, management, effects };
}

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
  const probes = new ModelProbeOwner({ store: f.store, fence: new ManagementResourceFence(f.store.list()),
    assertWriter: () => {}, select: (id, revision) => f.management.target(id, revision),
    prepare: (input, current) => f.management.prepareProbe(input, current) });
  t.after(() => probes.close());
  const input = { ...identity, commandId: 'TEST-original-import-probe', providerId: 'anthropic', modelId: 'claude-sonnet-4-6', effort: 'low' };
  probes.start(input);
  const deadline = performance.now() + 7000;
  while (probes.read({ ...identity, commandId: input.commandId })?.phase === 'running' && performance.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 20));
  const original = probes.read({ ...identity, commandId: input.commandId });
  assert.equal(original?.phase, 'completed', JSON.stringify({ original, effects: await f.effects() }));
  assert.equal(original.ok, true, JSON.stringify({ original, effects: await f.effects() }));
  assert.deepEqual(probes.start(input), original);
  const records = [...f.store.list()] as unknown as Row[];
  const effects = await f.effects();
  const observed = assertDesktopEmulatedImportModelChecks(records, effects, { model: input.modelId, effort: input.effort });
  assert.equal(observed.length, 1);
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
    env: f.profile.environment, input, timeout: 5000 });
  assert.equal(result.status, 78);
  const effects = await f.effects();
  assert.equal(effects.filter(row => row.event === 'failure').length, 1);
  assert.equal(effects.filter(row => row.event === 'input' || row.event === 'terminal').length, 0);
  assert.deepEqual([...f.store.list()], []);
});
