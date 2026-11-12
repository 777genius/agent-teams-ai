/** Genuine retained fork V1 and new Host V2 share one disposable original Electron profile. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { test } from 'node:test';
import { assertNativeV1Source, buildNativeV1Host } from '../../packages/legacy-agent-host/tests/opencode-v1-version-source.ts';
import { fileHash as fileDigest } from '../../packages/legacy-agent-host/tests/fixtures/native-host.ts';
import { waitFor } from '../e2e/release-updater/cdp.mts';
import { createDesktopUiControls } from './desktop-ui-controls.ts';
import { startRetainedOpenCodeModel } from './desktop-retained-opencode-model.ts';
import { originalLinuxProcessPresent, selectedLinuxProcesses, startRetainedOpenCodeApp } from './desktop-retained-opencode-app.ts';

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
};
const json = async (path: string) => record(JSON.parse(await readFile(path, 'utf8')));
const literal = (value: unknown) => JSON.stringify(value);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

test('original Electron retains legacy fork V1 while routing new Host V2 and isolating both Stop controls', {
  skip: process.env.OPENCODE_V1_V2_COEXISTENCE_GO !== '1', timeout: 900_000,
}, async () => {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  assert.equal(process.version, 'v24.21.0');
  const repo = resolve(import.meta.dirname, '../..');
  const head = process.env.OPENCODE_V2_TEST_SOURCE_HEAD!;
  const receiptPath = process.env.OPENCODE_V1_V2_COEXISTENCE_RECEIPT!;
  assert.ok(receiptPath && isAbsolute(receiptPath));
  const source = () => {
    assertNativeV1Source(repo, head);
    for (const command of [['diff', '--name-only', 'HEAD'], ['ls-files', '--others', '--exclude-standard']])
      assert.equal(execFileSync('git', [...command, '--', 'src', 'electron.vite.config.ts',
        'agent-teams-controller/src', 'mcp-server/src', 'scripts/e2e/release-updater/cdp.mts'],
      { cwd: repo, encoding: 'utf8', timeout: 5000 }).trim(), '', 'original app inputs must be clean');
  };
  source();
  const build = await buildNativeV1Host(repo, head);
  // Never retain a previously emitted graph/schema module across the fresh build.
  const { prepareDesktopBackendFixture } = await import('./desktop-backend-fixture.ts');
  execFileSync(process.execPath, ['agent-teams-controller/scripts/build.mjs'], { cwd: repo, timeout: 30_000 });
  execFileSync(process.execPath, ['node_modules/tsup/dist/cli-default.js'], { cwd: join(repo, 'mcp-server'), timeout: 60_000 });
  const node = await realpath(process.execPath);
  const v1 = await realpath(process.env.OPENCODE_V1_V2_RETAINED_BINARY!);
  const fork = await realpath(process.env.OPENCODE_V1_V2_RETAINED_RUNTIME!);
  const bun = await realpath(process.env.OPENCODE_V2_EMBEDDED_BUN!);
  for (const [path, expected] of [[v1, process.env.OPENCODE_V1_V2_RETAINED_BINARY_SHA256],
    [fork, process.env.OPENCODE_V1_V2_RETAINED_RUNTIME_SHA256], [bun, process.env.OPENCODE_V2_EMBEDDED_BUN_SHA256]]) {
    assert.match(expected ?? '', /^[a-f0-9]{64}$/); assert.equal(await fileDigest(path!), expected);
  }
  const model = await startRetainedOpenCodeModel();
  let fixture: Awaited<ReturnType<typeof prepareDesktopBackendFixture>> | undefined;
  let app: Awaited<ReturnType<typeof startRetainedOpenCodeApp>> | undefined;
  let passed = false, cleanup = false, failure: unknown;
  const legacyTeam = 'test-retained-opencode-v1';
  let legacySubmitted = false, legacyStopped = false;
  const cleanupErrors: unknown[] = [], steps: Record<string, unknown>[] = [];
  const natives: Awaited<ReturnType<typeof selectedLinuxProcesses>> = [];
  const proof: Record<string, unknown> = { kind: 'TEST_NATIVE_RETAINED_V1_HOST_V2_DESKTOP', sourceHead: head,
    status: 'INCOMPLETE', platform: 'linux-x64', build, steps,
    vendorAuthQualified: false, releaseQualified: false };
  const save = () => writeFile(receiptPath, JSON.stringify({ ...proof, cleanup,
    modelObservations: model.observations, modelFailures: model.failures }, null, 2), { mode: 0o600 });
  try {
    fixture = await prepareDesktopBackendFixture(repo, {
      pnpmEntry: process.env.OPENCODE_V1_V2_COREPACK_ENTRY!, seedUiTask: true,
      seedUiPreferences: true, launchDialog: true,
      nativeOpenCodeV2: { bunPath: bun, bunSha256: await fileDigest(bun),
        engineDirectory: await realpath(process.env.OPENCODE_V2_EMBEDDED_GRAPH!), modelUrl: model.url,
        endpoint: `http://127.0.0.1:${await reservePort()}`,
        managementEndpoint: `http://127.0.0.1:${await reservePort()}` },
    });
    const root = fixture.root, legacyProject = join(root, 'legacy-workspace');
    proof.root = root;
    await mkdir(legacyProject, { mode: 0o700 });
    for (const folder of ['legacy-runtime-data', 'legacy-runtime-cache', 'state']) await mkdir(join(root, folder), { mode: 0o700 });
    const legacyConfig = { $schema: 'https://opencode.ai/config.json', plugin: [],
      model: 'TEST-legacy/TEST-model', small_model: 'TEST-legacy/TEST-model',
      enabled_providers: ['TEST-legacy'], provider: { 'TEST-legacy': { npm: '@ai-sdk/openai-compatible',
        name: 'TEST retained V1 local only', options: { baseURL: `${model.url}/legacy/v1`, apiKey: 'TEST-LOCALHOST-ONLY' },
        models: { 'TEST-model': { name: 'TEST-model', tool_call: true,
          limit: { context: 200000, output: 2000 } } } } } };
    await writeFile(join(legacyProject, 'opencode.json'), JSON.stringify(legacyConfig), { mode: 0o600, flag: 'wx' });
    const profile = await json(fixture.profilePath);
    const runtime = record(profile.runtime), member = record((runtime.members as unknown[])[0]);
    record(record(member.embedded).providerConfiguration).settings = { baseURL: `${model.url}/host/v1`, apiKey: 'TEST-LOCALHOST-ONLY' };
    const profileBytes = JSON.stringify(profile);
    await writeFile(fixture.profilePath, profileBytes, { mode: 0o600 });
    const descriptor = await json(fixture.descriptorPath);
    record(record(record((descriptor.owners as unknown[])[0]).profile).env).LEGACY_AGENT_HOST_PROFILE_SHA256 = digest(profileBytes);
    const descriptorBytes = JSON.stringify(descriptor);
    await writeFile(fixture.descriptorPath, descriptorBytes, { mode: 0o600 });
    fixture.pins.profileSha256 = digest(profileBytes); fixture.pins.descriptorSha256 = digest(descriptorBytes);
    const environment = { ...fixture.appEnvironment,
      AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256: digest(descriptorBytes),
      CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: fork,
      OPENCODE_CLI_PATH: v1, OPENCODE_BIN_PATH: v1, CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: v1,
      CLAUDE_MULTIMODEL_DATA_HOME: join(root, 'legacy-runtime-data'),
      CLAUDE_MULTIMODEL_CACHE_HOME: join(root, 'legacy-runtime-cache'),
      XDG_STATE_HOME: join(root, 'state'), OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1', NO_PROXY: '127.0.0.1,localhost',
    };
    assert.equal(execFileSync(v1, ['--version'], { cwd: legacyProject, env: environment, encoding: 'utf8', timeout: 15000 }).trim(), '1.19.4');
    const version = execFileSync(fork, ['--version'], { cwd: legacyProject, env: environment, encoding: 'utf8', timeout: 15000 }).trim();
    const lock = await json(join(repo, 'runtime.lock.json'));
    assert.ok(version.includes(String(lock.cliVersion)), 'retained runtime release matches existing lock');
    proof.inputs = { v1: { version: '1.19.4', sha256: await fileDigest(v1) },
      retainedRuntime: { version: lock.version, cliVersion: version, sha256: await fileDigest(fork) },
      v2: { version: '2.1.4', bunSha256: await fileDigest(bun) }, profileSha256: digest(profileBytes),
      descriptorSha256: digest(descriptorBytes), nodeSha256: await fileDigest(node) };
    await save(); source();
    const start = (epoch: number, env: Record<string, string> = environment) =>
      startRetainedOpenCodeApp({ repo, root, node, env, port: 9222, epoch });
    // Reserve and release the exact CDP port before launch; discovery subsequently requires original custody.
    const checkPort = createServer();
    await new Promise<void>((resolve, reject) => { checkPort.once('error', reject); checkPort.listen(9222, '127.0.0.1', resolve); });
    await new Promise<void>((resolve, reject) => checkPort.close(error => error ? reject(error) : resolve()));
    // Reproduce a genuine saved old-owner team before enabling the new Host.
    // Main correctly refuses creating a new legacy team once Host is selected.
    const legacyEnvironment: Record<string, string> = { ...environment };
    delete legacyEnvironment.AGENT_TEAMS_BACKEND_DESCRIPTOR_PATH;
    delete legacyEnvironment.AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256;
    app = await start(0, legacyEnvironment);
    const hostKey = 'host-team:' + encodeURIComponent(fixture.handleId);
    const api = 'window.__TEST_retainedApi.teams';
    const callTeams = <T = Record<string, unknown>>(method: string, args: unknown[], timeout?: number) =>
      app!.call<T>(`${api}[${literal(method)}](...${literal(args)})`, timeout);
    const host = (operation: string, commandId: string, payload: unknown) => app!.call(
      `window.__TEST_retainedApi.agentBackend.invoke(${literal({ handle: { handleId: fixture!.handleId }, operation, commandId, payload })})`);
    const send = async (key: string, to: string, marker: string) => {
      await callTeams('sendMessage', [key, { to, text: marker }]);
      await waitFor(async () => { assert.deepEqual(model.failures, []); return model.markers.has(marker) || null; }, 'original owner receives ' + marker, 90_000);
    };
    await app.call(`window.electronAPI.config.addCustomProjectPath(${literal(legacyProject)})`);
    legacySubmitted = true;
    const created = await callTeams('createTeam', [{ teamName: legacyTeam, cwd: legacyProject,
      providerId: 'opencode', model: 'TEST-legacy/TEST-model', skipPermissions: true,
      runtimeSelectionVersion: 1, members: [{ name: 'bob', role: 'Developer', providerId: 'opencode', model: 'TEST-legacy/TEST-model', mcpPolicy: { mode: 'appOnly' } }] }], 240_000);
    assert.equal(typeof created.runId, 'string');
    const originalLegacyRuntime = await waitFor(async () => {
      const state = await callTeams('getTeamAgentRuntime', [legacyTeam]);
      return record(state.members).bob && record(record(state.members).bob).alive === true ? state : null;
    }, 'actual retained V1 app runtime ready', 180_000);
    const legacyTask = await callTeams('createTask', [legacyTeam, { subject: 'TEST retained V1 sidebar record' }]);
    assert.equal(typeof legacyTask.id, 'string');
    const originalNativeSession = record(record(originalLegacyRuntime.members).bob).runtimeSessionId;
    assert.equal(typeof originalNativeSession, 'string'); assert.ok(originalNativeSession);
    await send(legacyTeam, 'bob', 'TEST_RETAINED_V1_HISTORY');
    const historicalLog = await waitFor(async () => {
      const logs = await callTeams<unknown[]>('getMemberLogs', [legacyTeam, 'bob']);
      return logs.map(record).find(log => typeof log.lastOutputPreview === 'string' &&
        log.lastOutputPreview.includes('REPLY_TEST_RETAINED_V1_HISTORY')) ?? null;
    }, 'old owner exposes actual completed native history', 90_000);
    assert.equal(typeof historicalLog.projectId, 'string');
    assert.equal(typeof historicalLog.sessionId, 'string');
    const historicalDetail = () => app!.call(`window.__TEST_retainedApi.getSessionDetail(
      ${literal(historicalLog.projectId)},${literal(historicalLog.sessionId)},{bypassCache:true})`);
    assert.ok(JSON.stringify(await historicalDetail()).includes('REPLY_TEST_RETAINED_V1_HISTORY'));
    const seedProcesses = await app.nativeChildren(v1);
    assert.ok(seedProcesses.length > 0, 'real old-owner V1 native process'); natives.push(...seedProcesses);
    await callTeams('stop', [legacyTeam]); legacyStopped = true;
    const savedLegacy = await callTeams('getData', [legacyTeam]);
    const callsBeforeUpgrade = model.observations.length;
    steps.push({ observed: 'actual_legacy_fork_V1_history_before_new_Host_selection', runId: created.runId,
      nativeSessionId: originalNativeSession, taskId: legacyTask.id,
      logSessionId: historicalLog.sessionId, logProjectId: historicalLog.projectId, seedProcesses });
    await app.close(); app = undefined; source();
    assert.equal(seedProcesses.some(originalLinuxProcessPresent), false);
    app = await start(1);
    const retainedData = await callTeams('getData', [legacyTeam]);
    assert.deepEqual(retainedData.tasks, savedLegacy.tasks);
    assert.deepEqual(retainedData.messages, savedLegacy.messages);
    assert.ok(JSON.stringify(await historicalDetail()).includes('REPLY_TEST_RETAINED_V1_HISTORY'));
    assert.equal(await callTeams<boolean>('processAlive', [legacyTeam]), false);
    assert.equal(model.observations.length, callsBeforeUpgrade, 'Host selection never replays retained V1 input');
    legacyStopped = false;
    const retainedLaunch = await callTeams('launchTeam', [{ teamName: legacyTeam, cwd: legacyProject,
      providerId: 'opencode', model: 'TEST-legacy/TEST-model', skipPermissions: true, runtimeSelectionVersion: 1 }], 240_000);
    assert.equal(typeof retainedLaunch.runId, 'string'); assert.notEqual(retainedLaunch.runId, created.runId);
    await waitFor(async () => {
      const state = await callTeams('getTeamAgentRuntime', [legacyTeam]);
      return record(state.members).bob && record(record(state.members).bob).alive === true ? state : null;
    }, 'retained legacy owner launches under same TEST profile with Host selected', 180_000);
    const legacyProcesses = await app.nativeChildren(v1);
    assert.ok(legacyProcesses.length > 0); natives.push(...legacyProcesses);
    steps.push({ observed: 'retained_legacy_fork_owner_before_new_Host_runtime', runId: retainedLaunch.runId, legacyProcesses });
    const selection = await host('team.launch.read', 'TEST-coexist-launch-read', {}); assert.equal(selection.ok, true);
    const launch = record(selection.value);
    const started = await host('team.launch.start', 'TEST-coexist-launch-once', {
      launchId: launch.launchId, rosterRevision: launch.rosterRevision,
      configuration: { members: [{ memberId: 'alice-id', model: 'TEST-local/TEST-model', permissions: 'bypass' }] },
    }); assert.equal(started.ok, true, JSON.stringify(started));
    await waitFor(async () => { const value = await host('runtime.read', 'TEST-coexist-native-read', { memberId: 'alice-id' });
      assert.equal(value.ok, true); return record(value.value).nativeReady === true ? value : null;
    }, 'new actual Host V2 runtime ready', 90_000);
    const hostProcesses = await app.nativeChildren(bun); assert.ok(hostProcesses.length > 0); natives.push(...hostProcesses);
    assert.ok(legacyProcesses.every(originalLinuxProcessPresent));
    const both = await callTeams<unknown[]>('list', []);
    assert.ok(both.some(value => record(value).teamName === legacyTeam));
    assert.ok(both.some(value => record(value).teamName === hostKey));
    await send(legacyTeam, 'bob', 'TEST_RETAINED_V1_FIRST');
    await send(hostKey, 'alice', 'TEST_OWNED_V2_FIRST');
    await waitFor(async () => { const state = await host('runtime.read', 'TEST-coexist-terminal', { memberId: 'alice-id' });
      return (record(state.value).inputs as unknown[]).some(value => record(value).phase === 'terminal') || null;
    }, 'new Host native input settles');
    steps.push({ observed: 'both_actual_owner_inputs_through_original_renderer_routing', hostProcesses });
    let ui = createDesktopUiControls(app.cdp, { assertOwnedRenderer: app.assertCurrent, step: value => steps.push(value) });
    await ui.observeInput();
    await ui.clickSidebar('TEST retained V1 sidebar record');
    await ui.click('button[aria-label="Stop"]', 'ordinary retained V1 Stop', 'Stop');
    await waitFor(async () => await callTeams<boolean>('processAlive', [legacyTeam]) === false || null, 'retained V1 Stop settles', 120_000);
    assert.ok(hostProcesses.every(originalLinuxProcessPresent), 'legacy Stop preserves all original V2 native children');
    await send(hostKey, 'alice', 'TEST_OWNED_V2_AFTER_STOP');
    const relaunched = await callTeams('launchTeam', [{ teamName: legacyTeam, cwd: legacyProject,
      providerId: 'opencode', model: 'TEST-legacy/TEST-model', skipPermissions: true, runtimeSelectionVersion: 1 }], 240_000);
    assert.equal(typeof relaunched.runId, 'string'); assert.notEqual(relaunched.runId, retainedLaunch.runId);
    await waitFor(async () => await callTeams<boolean>('processAlive', [legacyTeam]) || null, 'explicit retained V1 relaunch ready', 180_000);
    const retainedAfterRelaunch = await app.nativeChildren(v1); assert.ok(retainedAfterRelaunch.length > 0); natives.push(...retainedAfterRelaunch);
    await ui.clickSidebar(fixture.uiSeed!.subject);
    await ui.click('button[aria-label="Stop"]', 'ordinary Host V2 Stop', 'Stop');
    await waitFor(async () => { const state = await host('runtime.read', 'TEST-coexist-stopped', { memberId: 'alice-id' });
      assert.equal(state.ok, true); return record(state.value).custody === 'released' && record(state.value).phase === 'closed' || null;
    }, 'Host V2 Stop confirms original custody', 90_000);
    assert.ok(retainedAfterRelaunch.every(originalLinuxProcessPresent), 'Host Stop preserves retained V1 native owner');
    await send(legacyTeam, 'bob', 'TEST_RETAINED_V1_AFTER_STOP');
    steps.push({ observed: 'both_original_Stop_controls_preserve_the_other_actual_owner' });
    const screenshot = await app.cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(root, 'coexistence-original-ui.png'), Buffer.from(screenshot.data, 'base64'), { mode: 0o600 });
    await callTeams('stop', [legacyTeam]);
    legacyStopped = true;
    const before = { legacy: await callTeams('getData', [legacyTeam]), host: await callTeams('getData', [hostKey]) };
    const callsBeforeCold = model.observations.length;
    await app.close(); app = undefined; source();
    app = await start(2);
    const after = { legacy: await callTeams('getData', [legacyTeam]), host: await callTeams('getData', [hostKey]) };
    assert.deepEqual(record(after.legacy).tasks, record(before.legacy).tasks);
    assert.deepEqual(record(after.legacy).messages, record(before.legacy).messages);
    assert.deepEqual(record(after.host).tasks, record(before.host).tasks);
    assert.deepEqual(record(after.host).messages, record(before.host).messages);
    assert.equal(await callTeams<boolean>('processAlive', [legacyTeam]), false);
    assert.equal(await callTeams<boolean>('processAlive', [hostKey]), false);
    await new Promise<void>(resolve => setTimeout(resolve, 500));
    assert.equal(model.observations.length, callsBeforeCold, 'cold startup never replays either owner business input');
    assert.deepEqual(model.failures, []);
    ui = createDesktopUiControls(app.cdp, { assertOwnedRenderer: app.assertCurrent, step: value => steps.push(value) });
    await ui.observeInput(); await ui.clickSidebar('TEST retained V1 sidebar record');
    await ui.clickSidebar(fixture.uiSeed!.subject);
    steps.push({ observed: 'same_profile_cold_original_UI_reads_both_histories_without_replay' });
    await app.close(); app = undefined; source();
    assert.equal(natives.some(originalLinuxProcessPresent), false, 'all original native processes gone after ordinary Quit');
    passed = true;
  } catch (error) {
    failure = error;
    if (error instanceof AggregateError && error.errors.some(value =>
      value instanceof Error && value.message === 'original app cleanup unknown')) cleanupErrors.push(error);
  }
  finally {
    if (app && legacySubmitted && !legacyStopped) {
      try { await app.call(`window.__TEST_retainedApi.teams.stop(${literal(legacyTeam)})`); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (app) { try { assert.equal(await app.cleanup(), true); } catch (error) { cleanupErrors.push(error); } }
    try { await model.close(); } catch (error) { cleanupErrors.push(error); }
    try { assert.equal(natives.some(originalLinuxProcessPresent), false, 'no surviving original native process'); }
    catch (error) { cleanupErrors.push(error); }
    if (fixture) {
      try {
        // Absence check only: an early detached child never becomes a new signal target.
        for (const executable of [v1, bun]) for (const process of await selectedLinuxProcesses(executable)) {
          try {
            const environment = await readFile(`/proc/${process.pid}/environ`, 'utf8');
            assert.equal(environment.includes(fixture.root), false, 'unreconciled TEST native namespace survives cleanup');
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupErrors.push(error); }
        }
      } catch (error) { cleanupErrors.push(error); }
    }
    cleanup = cleanupErrors.length === 0;
    proof.status = passed && cleanup ? 'PASS' : 'FAIL';
    if (failure) proof.failure = failure instanceof Error ? failure.message : String(failure);
    proof.cleanupFailures = cleanupErrors.map(error => error instanceof Error ? error.message : String(error));
    await save();
  }
  if (failure && cleanupErrors.length) throw new AggregateError([failure, ...cleanupErrors], 'coexistence and cleanup failed');
  if (failure) throw failure;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'coexistence cleanup failed');
});
