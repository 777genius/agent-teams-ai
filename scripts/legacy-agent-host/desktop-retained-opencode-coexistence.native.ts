/** Genuine retained fork V1 and new Host V2 share one disposable original Electron profile. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { test } from 'node:test';
import { assertNativeV1Source, buildNativeV1Host } from '../../packages/legacy-agent-host/tests/opencode-v1-version-source.ts';
import { fileHash as fileDigest } from '../../packages/legacy-agent-host/tests/fixtures/native-host.ts';
import { waitFor } from '../e2e/release-updater/cdp.mts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import { startRetainedOpenCodeModel } from './desktop-retained-opencode-model.ts';
import { retainedOpenCodeLaunchExpression, RETAINED_OPENCODE_LAUNCH_TIMEOUT_MS } from './desktop-retained-opencode-launch.ts';
import {
  exerciseRetainedDonorHistory,
  originalLinuxProcessPresent,
  readRetainedNativeReply,
  selectedLinuxProcesses,
  snapshotLinuxProcesses,
  startRetainedOpenCodeApp,
  testNamespaceLinuxProcesses,
} from './desktop-retained-opencode-app.ts';

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
};
const json = async (path: string) => record(JSON.parse(await readFile(path, 'utf8')));
const literal = desktopJsLiteral;
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
  const processBaseline = await snapshotLinuxProcesses();
  const repo = resolve(import.meta.dirname, '../..');
  const head = process.env.OPENCODE_V2_TEST_SOURCE_HEAD!;
  const receiptPath = process.env.OPENCODE_V1_V2_COEXISTENCE_RECEIPT!;
  assert.ok(receiptPath && isAbsolute(receiptPath));
  const retainedSourceGuard: { verify?: () => void } = {};
  const source = () => {
    assertNativeV1Source(repo, head);
    for (const command of [['diff', '--name-only', 'HEAD'], ['ls-files', '--others', '--exclude-standard']])
      assert.equal(execFileSync('git', [...command, '--', 'src', 'electron.vite.config.ts',
        'agent-teams-controller/src', 'mcp-server/src', 'scripts/e2e/release-updater/cdp.mts'],
      { cwd: repo, encoding: 'utf8', timeout: 5000 }).trim(), '', 'original app inputs must be clean');
    retainedSourceGuard.verify?.();
  };
  source();
  const build = await buildNativeV1Host(repo, head);
  // Never retain a previously emitted graph/schema module across the fresh build.
  const { prepareDesktopBackendFixture } = await import('./desktop-backend-fixture.ts');
  execFileSync(process.execPath, ['agent-teams-controller/scripts/build.mjs'], { cwd: repo, timeout: 30_000 });
  execFileSync(process.execPath, ['node_modules/tsup/dist/cli-default.js'], { cwd: join(repo, 'mcp-server'), timeout: 60_000 });
  const node = await realpath(process.execPath);
  if (process.env.OPENCODE_V1_UI_SOURCE_SELECTION_GO === '1' ||
      process.env.OPENCODE_V2_UI_SOURCE_SELECTION_GO === '1') {
    const { runDesktopRuntimeSourceSelection } = await import('./desktop-runtime-source-selection.ts');
    await runDesktopRuntimeSourceSelection({ repo, sourceHead: head, build, node, receiptPath,
      processBaseline, assertSource: source });
    return;
  }
  const v1 = await realpath(process.env.OPENCODE_V1_V2_RETAINED_BINARY!);
  const fork = await realpath(process.env.OPENCODE_V1_V2_RETAINED_RUNTIME!);
  const bun = await realpath(process.env.OPENCODE_V2_EMBEDDED_BUN!);
  const retainedRoot = await realpath(process.env.OPENCODE_V1_V2_RETAINED_REPO!);
  assert.equal(retainedRoot, join(await realpath(repo), '.runtime-download/TEST-retained-release-158'));
  assert.equal(fork, join(retainedRoot, 'resources/runtime/claude-multimodel'));
  const appGit = (args: string[]) => execFileSync('git', args,
    { cwd: retainedRoot, encoding: 'utf8', timeout: 5000 }).trim();
  const verifyRetainedApp = () => {
    assert.equal(appGit(['rev-parse', '--show-toplevel']), retainedRoot);
    assert.equal(appGit(['rev-parse', 'HEAD']), '1d0f97f55de566036c970eab4f36b84620afdb3f');
    assert.equal(appGit(['rev-parse', 'HEAD^{tree}']), 'ec540290c86af9755c94e52ac795aeda8586a98f');
    assert.equal(appGit(['diff', '--name-only', 'HEAD']), '');
    assert.equal(appGit(['ls-files', '--others', '--exclude-standard']), '');
  };
  verifyRetainedApp();
  for (const path of [
    'runtime.lock.json', 'scripts/stage-runtime.mjs',
    'resources/runtime/COMMIT_SHA', 'resources/runtime/VERSION',
  ])
    assert.equal(await realpath(join(retainedRoot, path)), join(retainedRoot, path));
  const appSource = { root: retainedRoot, commit: appGit(['rev-parse', 'HEAD']),
    tree: appGit(['rev-parse', 'HEAD^{tree}']), lockSha256: await fileDigest(join(retainedRoot, 'runtime.lock.json')),
    stageScriptSha256: await fileDigest(join(retainedRoot, 'scripts/stage-runtime.mjs')) };
  assert.equal(appSource.lockSha256, '1311acf34215a47950dd071a23669a69ed866d4825bcde5d21db41302a71d29d');
  assert.equal(appSource.stageScriptSha256, '7ee8a9036562728a66d5a1dcd3ce7c97abf75cabeb97092eb9b87171ed2e29be');
  const lock = await json(join(retainedRoot, 'runtime.lock.json'));
  const archiveSha256 = record(record(lock.assets)['linux-x64']).sha256;
  assert.equal(archiveSha256, '4c106fcebab79de525aa7c9bb7636aa91fa43e76b4d567a00f98b2e6650ab29d');
  const retainedInputsPath = process.env.OPENCODE_V1_V2_INPUTS_RECEIPT!;
  assert.ok(retainedInputsPath && isAbsolute(retainedInputsPath));
  const retainedInputs = await json(retainedInputsPath);
  assert.equal(retainedInputs.kind, 'TEST_RETAINED_V1_HOST_V2_INPUTS');
  assert.equal(retainedInputs.status, 'READY'); assert.equal(retainedInputs.sourceHead, head);
  for (const [path, expected] of [[v1, process.env.OPENCODE_V1_V2_RETAINED_BINARY_SHA256],
    [fork, process.env.OPENCODE_V1_V2_RETAINED_RUNTIME_SHA256], [bun, process.env.OPENCODE_V2_EMBEDDED_BUN_SHA256]]) {
    assert.match(expected ?? '', /^[a-f0-9]{64}$/); assert.equal(await fileDigest(path!), expected);
  }
  // The published 0.0.158 Linux payload omitted this stock helper. Qualify the
  // exact release source's unchanged build separately; never label it a release asset.
  const retainedCommit = (await readFile(join(dirname(fork), 'COMMIT_SHA'), 'utf8')).trim();
  assert.match(retainedCommit, /^[a-f0-9]{40}$/);
  assert.equal(retainedCommit, record(record(lock.opencodeV2Delivery)['linux-x64']).sourceCommit);
  assert.equal(lock.version, '0.0.158');
  assert.equal((await readFile(join(dirname(fork), 'VERSION'), 'utf8')).trim(), '0.0.158');
  assert.equal(process.env.OPENCODE_V1_V2_RETAINED_RUNTIME_SHA256,
    'b9b4c9f786238922cad49f46e5ac147b4e361b182bd250e5fbb47571571059cd');
  assert.deepEqual(retainedInputs.retainedRuntime, { version: lock.version, path: fork,
    sha256: process.env.OPENCODE_V1_V2_RETAINED_RUNTIME_SHA256, sourceCommit: retainedCommit,
    appSource, archiveSha256 });
  const helperSource = await realpath(process.env.OPENCODE_V1_V2_RETAINED_CUSTODY_SOURCE!);
  const helperGit = (args: string[]) => execFileSync('git', args,
    { cwd: helperSource, encoding: 'utf8', timeout: 5000 }).trim();
  const verifyRetainedSource = () => {
    verifyRetainedApp();
    assert.equal(helperGit(['rev-parse', 'HEAD']), retainedCommit);
    assert.equal(helperGit(['diff', '--name-only', 'HEAD']), '');
    assert.equal(helperGit(['ls-files', '--others', '--exclude-standard']), '');
  };
  retainedSourceGuard.verify = verifyRetainedSource;
  verifyRetainedSource();
  execFileSync(bun, ['--no-env-file', '--no-install', 'scripts/stage-opencode-custody.mts'],
    { cwd: helperSource, env: { PATH: '/usr/bin:/bin' }, timeout: 60_000 });
  const helperManifest = record(JSON.parse(execFileSync(bun, ['--no-env-file', '--no-install', '-e',
    "import { verifyLinuxCustodyArtifact } from './scripts/lib/opencode-custody-artifact.js'; console.log(JSON.stringify(verifyLinuxCustodyArtifact('./dist/native','linux-x64','./native/opencode-custody/linux.c')))"],
  { cwd: helperSource, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 5000 })));
  const helper = await realpath(join(helperSource, 'dist/native/opencode-custody/linux-x64/custodian'));
  const helperSha256 = await fileDigest(helper);
  assert.equal(helperManifest.sha256, helperSha256); verifyRetainedSource();
  const sourceBuiltRetainedHelper = { kind: 'EXACT_RELEASE_SOURCE_BUILD', sourceCommit: retainedCommit,
    sourceRepository: lock.sourceRepository,
    sourceTree: helperGit(['rev-parse', 'HEAD^{tree}']), manifest: helperManifest,
    manifestSha256: await fileDigest(helper + '.json'),
    buildScriptSha256: await fileDigest(join(helperSource, 'scripts/stage-opencode-custody.mts')),
    validatorSha256: await fileDigest(join(helperSource, 'scripts/lib/opencode-custody-artifact.ts')),
    compiler: execFileSync('/usr/bin/cc', ['--version'], { encoding: 'utf8', timeout: 5000 }).split('\n')[0],
    publishedRuntimeComplete: false };
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
    processBaseline: processBaseline.map(({ pid, birth }) => ({ pid, birth })),
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
    const appConfigPath = join(root, 'claude', 'agent-teams-config.json');
    const appConfig = await json(appConfigPath);
    appConfig.httpServer = { enabled: false, port: await reservePort() };
    await writeFile(appConfigPath, JSON.stringify(appConfig), { mode: 0o600 });
    await mkdir(legacyProject, { mode: 0o700 });
    for (const folder of ['legacy-runtime-data', 'legacy-runtime-cache', 'state']) await mkdir(join(root, folder), { mode: 0o700 });
    const legacyConfig = { $schema: 'https://opencode.ai/config.json', plugin: [],
      model: 'test-legacy/TEST-model', small_model: 'test-legacy/TEST-model',
      enabled_providers: ['test-legacy'], provider: { 'test-legacy': { npm: '@ai-sdk/openai-compatible',
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
      CLAUDE_MULTIMODEL_OPENCODE_CUSTODY_HELPER: helper,
      OPENCODE_CLI_PATH: v1, OPENCODE_BIN_PATH: v1, CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: v1,
      CLAUDE_MULTIMODEL_DATA_HOME: join(root, 'legacy-runtime-data'),
      CLAUDE_MULTIMODEL_CACHE_HOME: join(root, 'legacy-runtime-cache'),
      // The retained owner needs the product's existing bound control/MCP
      // supervisor. The Host-only base fixture deliberately disables it.
      CLAUDE_TEAM_OPENCODE_MCP_HTTP: '1',
      CLAUDE_TEAM_OPENCODE_MCP_HTTP_PORT: String(await reservePort()),
      XDG_STATE_HOME: join(root, 'state'), OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1', NO_PROXY: '127.0.0.1,localhost',
    };
    assert.equal(execFileSync(v1, ['--version'], { cwd: legacyProject, env: environment, encoding: 'utf8', timeout: 15000 }).trim(), '1.19.4');
    const version = execFileSync(fork, ['--version'], { cwd: legacyProject, env: environment, encoding: 'utf8', timeout: 15000 }).trim();
    assert.ok(version.includes(String(lock.cliVersion)), 'retained runtime release matches existing lock');
    proof.inputs = { v1: { version: '1.19.4', sha256: await fileDigest(v1) },
      retainedRuntime: { version: lock.version, cliVersion: version, sourceCommit: retainedCommit,
        sha256: await fileDigest(fork), sourceBuiltRetainedHelper, appSource, archiveSha256 },
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
    const waitLegacyControl = () => waitFor(async () => {
      const info = await app!.call('window.electronAPI.externalAgentConnection.getConnectionInfo()');
      assert.notEqual(record(info.mcp).status, 'error', String(info.reason));
      return record(info.control).status === 'ready' && record(info.mcp).status === 'ready' || null;
    }, 'original Desktop control and MCP owner ready', 90_000);
    const recordAppChildren = async () => {
      for (const executable of [node, await realpath(join(repo, 'node_modules/electron/dist/electron'))])
        natives.push(...await app!.nativeChildren(executable));
      natives.push(...await app!.nativeImageChildren(helperSha256, root));
    };
    const legacyChildren = () => app!.nativeImageChildren(process.env.OPENCODE_V1_V2_RETAINED_BINARY_SHA256!, root);
    const waitLegacyRuntime = (runId: unknown) => waitFor(async () => {
      const state = await callTeams('getTeamAgentRuntime', [legacyTeam]);
      const spawn = await callTeams('getMemberSpawnStatuses', [legacyTeam]);
      const member = record(record(state.members).bob ?? {});
      const status = record(record(spawn.statuses).bob ?? {});
      proof.legacyReadiness = { runId: state.runId, spawnRunId: spawn.runId, alive: member.alive,
        bootstrapConfirmed: status.bootstrapConfirmed, historicalBootstrapConfirmed: member.historicalBootstrapConfirmed,
        nativeSessionPresent: typeof member.runtimeSessionId === 'string',
        status: status.status, hardFailureReason: status.hardFailureReason };
      if (spawn.runId !== runId) return null;
      assert.notEqual(status.hardFailure, true, String(status.hardFailureReason ?? status.error));
      assert.notEqual(status.status, 'error', String(status.error));
      if (state.runId !== runId) return null;
      return member.alive === true && status.bootstrapConfirmed === true &&
        member.historicalBootstrapConfirmed === true && member.runtimeModel === 'test-legacy/TEST-model' &&
        typeof member.runtimeSessionId === 'string' && member.runtimeSessionId.length > 0 ? state : null;
    }, 'actual retained V1 native session and original bootstrap ready', 180_000);
    const send = async (key: string, to: string, marker: string) => {
      await callTeams('sendMessage', [key, { member: to, text: marker }]);
      await waitFor(async () => { assert.deepEqual(model.failures, []); return model.markers.has(marker) || null; }, 'original owner receives ' + marker, 90_000);
    };
    const readLegacyReply = (member: Record<string, unknown>, expectedReply: string) =>
      readRetainedNativeReply({ app: app!, teamName: legacyTeam, memberName: 'bob', member,
        expectedReply, failures: model.failures, observe: value => { proof.legacyHistoryRead = value; } });
    await waitLegacyControl();
    await app.call(`window.electronAPI.config.addCustomProjectPath(${literal(legacyProject)})`);
    legacySubmitted = true;
    const created = await callTeams('createTeam', [{ teamName: legacyTeam, cwd: legacyProject,
      providerId: 'opencode', model: 'test-legacy/TEST-model', skipPermissions: true,
      runtimeSelectionVersion: 1, members: [{ name: 'bob', role: 'Developer', providerId: 'opencode', model: 'test-legacy/TEST-model', mcpPolicy: { mode: 'appOnly' } }] }], 240_000);
    assert.equal(typeof created.runId, 'string');
    const originalLegacyRuntime = await waitLegacyRuntime(created.runId);
    const legacyTask = await callTeams('createTask', [legacyTeam, { subject: 'TEST retained V1 sidebar record' }]);
    assert.equal(typeof legacyTask.id, 'string');
    const originalLegacyMember = record(record(originalLegacyRuntime.members).bob);
    const originalNativeSession = originalLegacyMember.runtimeSessionId;
    assert.equal(typeof originalNativeSession, 'string'); assert.ok(originalNativeSession);
    await send(legacyTeam, 'bob', 'TEST_RETAINED_V1_HISTORY');
    const historicalReply = await waitFor(
      () => readLegacyReply(originalLegacyMember, 'REPLY_TEST_RETAINED_V1_HISTORY'),
      'old owner exposes actual completed native history', 90_000);
    const seedProcesses = await legacyChildren();
    assert.ok(seedProcesses.length > 0, 'real old-owner V1 native process'); natives.push(...seedProcesses);
    await callTeams('stop', [legacyTeam]); legacyStopped = true;
    const savedLegacy = await callTeams('getData', [legacyTeam]);
    const callsBeforeUpgrade = model.observations.length;
    steps.push({ observed: 'actual_legacy_fork_V1_history_before_new_Host_selection', runId: created.runId,
      nativeSessionId: originalNativeSession, taskId: legacyTask.id,
      history: historicalReply, seedProcesses });
    await recordAppChildren();
    await app.close(); app = undefined; source();
    assert.equal(seedProcesses.some(originalLinuxProcessPresent), false);
    app = await start(1);
    await waitLegacyControl();
    const retainedData = await callTeams('getData', [legacyTeam]);
    assert.deepEqual(retainedData.tasks, savedLegacy.tasks);
    assert.deepEqual(retainedData.messages, savedLegacy.messages);
    assert.deepEqual(await readLegacyReply(originalLegacyMember, 'REPLY_TEST_RETAINED_V1_HISTORY'), historicalReply,
      JSON.stringify({ legacyHistoryRead: proof.legacyHistoryRead }).slice(0, 8000));
    assert.equal(await callTeams<boolean>('processAlive', [legacyTeam]), false);
    assert.equal(model.observations.length, callsBeforeUpgrade, 'Host selection never replays retained V1 input');
    legacyStopped = false;
    const retainedLaunch = await app.call(retainedOpenCodeLaunchExpression({ intentId: 'TEST-coexist-retained-original-once',
      request: { teamName: legacyTeam, cwd: legacyProject, providerId: 'opencode', model: 'test-legacy/TEST-model',
        skipPermissions: true, runtimeSelectionVersion: 1 } }), RETAINED_OPENCODE_LAUNCH_TIMEOUT_MS);
    assert.equal(typeof retainedLaunch.runId, 'string'); assert.notEqual(retainedLaunch.runId, created.runId);
    await waitLegacyRuntime(retainedLaunch.runId);
    const legacyProcesses = await legacyChildren();
    assert.ok(legacyProcesses.length > 0); natives.push(...legacyProcesses);
    steps.push({ observed: 'retained_legacy_fork_owner_before_new_Host_runtime', runId: retainedLaunch.runId, legacyProcesses });
    const selection = await host('team.launch.read', 'TEST-coexist-launch-read', {}); assert.equal(selection.ok, true);
    const launch = record(selection.value);
    const preparation = model.armHostPreparation('TEST-coexist-launch-once');
    try {
      const started = await host('team.launch.start', 'TEST-coexist-launch-once', {
        launchId: launch.launchId, rosterRevision: launch.rosterRevision,
        configuration: { members: [{ memberId: 'alice-id', model: 'test-local/TEST-model', permissions: 'bypass' }] },
      }); assert.equal(started.ok, true, JSON.stringify(started));
      assert.equal(preparation.consumed, 1, 'the original Main launch performs exactly one Host preparation');
    } finally { preparation.disarm(); }
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
    const relaunched = await app.call(retainedOpenCodeLaunchExpression({ intentId: 'TEST-coexist-retained-after-stop-once',
      request: { teamName: legacyTeam, cwd: legacyProject, providerId: 'opencode', model: 'test-legacy/TEST-model',
        skipPermissions: true, runtimeSelectionVersion: 1 } }), RETAINED_OPENCODE_LAUNCH_TIMEOUT_MS);
    assert.equal(typeof relaunched.runId, 'string'); assert.notEqual(relaunched.runId, retainedLaunch.runId);
    const relaunchedRuntime = await waitLegacyRuntime(relaunched.runId);
    const relaunchedMember = record(record(relaunchedRuntime.members).bob);
    const retainedAfterRelaunch = await legacyChildren(); assert.ok(retainedAfterRelaunch.length > 0); natives.push(...retainedAfterRelaunch);
    await ui.clickSidebar(fixture.uiSeed!.subject);
    await ui.click('button[aria-label="Stop"]', 'ordinary Host V2 Stop', 'Stop');
    await waitFor(async () => { const state = await host('runtime.read', 'TEST-coexist-stopped', { memberId: 'alice-id' });
      assert.equal(state.ok, true); return record(state.value).custody === 'released' && record(state.value).phase === 'closed' || null;
    }, 'Host V2 Stop confirms original custody', 90_000);
    assert.ok(retainedAfterRelaunch.every(originalLinuxProcessPresent), 'Host Stop preserves retained V1 native owner');
    await send(legacyTeam, 'bob', 'TEST_RETAINED_V1_AFTER_STOP');
    const finalLegacyReply = await waitFor(
      () => readLegacyReply(relaunchedMember, 'REPLY_TEST_RETAINED_V1_AFTER_STOP'),
      'retained owner completes native reply after Host Stop', 90_000);
    steps.push({ observed: 'both_original_Stop_controls_preserve_the_other_actual_owner', history: finalLegacyReply });
    const screenshot = await app.cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(root, 'coexistence-original-ui.png'), Buffer.from(screenshot.data, 'base64'), { mode: 0o600 });
    await callTeams('stop', [legacyTeam]);
    legacyStopped = true;
    const before = { legacy: await callTeams('getData', [legacyTeam]), host: await callTeams('getData', [hostKey]) };
    const callsBeforeCold = model.observations.length;
    await recordAppChildren();
    await app.close(); app = undefined; source();
    app = await start(2);
    await waitLegacyControl();
    const after = { legacy: await callTeams('getData', [legacyTeam]), host: await callTeams('getData', [hostKey]) };
    assert.deepEqual(record(after.legacy).tasks, record(before.legacy).tasks);
    assert.deepEqual(record(after.legacy).messages, record(before.legacy).messages);
    assert.deepEqual(record(after.host).tasks, record(before.host).tasks);
    assert.deepEqual(record(after.host).messages, record(before.host).messages);
    assert.equal(await callTeams<boolean>('processAlive', [legacyTeam]), false);
    assert.equal(await callTeams<boolean>('processAlive', [hostKey]), false);
    assert.deepEqual(await readLegacyReply(relaunchedMember, 'REPLY_TEST_RETAINED_V1_AFTER_STOP'), finalLegacyReply,
      JSON.stringify({ legacyHistoryRead: proof.legacyHistoryRead }).slice(0, 8000));
    await new Promise<void>(resolve => setTimeout(resolve, 500));
    assert.equal(model.observations.length, callsBeforeCold, 'cold startup never replays either owner business input');
    assert.deepEqual(model.failures, []);
    ui = createDesktopUiControls(app.cdp, { assertOwnedRenderer: app.assertCurrent, step: value => steps.push(value) });
    await ui.observeInput(); await ui.clickSidebar('TEST retained V1 sidebar record');
    await ui.clickSidebar(fixture.uiSeed!.subject);
    steps.push({ observed: 'same_profile_cold_original_UI_reads_both_histories_without_replay' });
    await recordAppChildren();
    await app.close(); app = undefined; source();
    assert.equal(natives.some(originalLinuxProcessPresent), false, 'all original native processes gone after ordinary Quit');
    const donorHistory: Record<string, unknown> = { kind: 'TEST_DONOR_4A_NATIVE_HISTORY', status: 'INCOMPLETE' };
    proof.donorHistory = donorHistory;
    await runDonorHistory({ repo, head, root: join(root, 'donor-history'), node,
      v1: { path: v1, sha256: await fileDigest(v1) }, source, processBaseline, proof: donorHistory, cleanupErrors });
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
        assert.deepEqual(await testNamespaceLinuxProcesses(fixture.root, processBaseline), [],
          'unreconciled TEST native namespace survives cleanup');
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

/** Separate producer profile and finite oracle; never seeds a Host owner or product history. */
async function runDonorHistory(input: {
  repo: string; head: string; root: string; node: string; v1: { path: string; sha256: string };
  source(): void; processBaseline: Awaited<ReturnType<typeof snapshotLinuxProcesses>>;
  proof: Record<string, unknown>; cleanupErrors: unknown[];
}) {
  const { repo, root, proof } = input;
  const inputsPath = process.env.OPENCODE_V1_V2_INPUTS_RECEIPT!;
  assert.ok(inputsPath && isAbsolute(inputsPath));
  const originalInputs = await json(inputsPath);
  assert.equal(originalInputs.kind, 'TEST_RETAINED_V1_HOST_V2_INPUTS');
  assert.equal(originalInputs.status, 'READY'); assert.equal(originalInputs.sourceHead, input.head);
  const donor = record(originalInputs.donor);
  assert.equal(donor.kind, 'TEST_DONOR_4A_RUNTIME_160_INPUTS');
  assert.equal(donor.commit, '4a0e06277fe216d9f82dbbede362668fe46622ee');
  assert.equal(donor.tree, '4bb456a5b35b6fca0e795bc8b19a13f5f1f6defd');
  const donorRoot = await realpath(String(donor.root));
  assert.equal(donorRoot, join(repo, '.runtime-download/TEST-donor-4a'));
  const node = record(donor.node), electron = record(donor.electron), runtime = record(donor.runtime);
  const custody = record(donor.custody);
  assert.equal(node.version, 'v24.21.0'); assert.equal(electron.version, '44.10.1');
  assert.equal(runtime.version, '0.0.160'); assert.equal(runtime.cliVersion, '2.777.777');
  assert.equal(runtime.archiveSha256, '09b174841e74c95337f8b1be986f1501a71582ce190671c548bf4c70ab814e10');
  assert.equal(runtime.sourceCommit, 'e13edcd3d4ffbecc0272ae30195cc6b15b710ee7');
  assert.equal(custody.sourceCommit, runtime.sourceCommit);
  assert.equal(custody.sourceTree, 'a5ed6ffc453a68a5454328bd79a9422ce1e4e3e9');
  assert.equal(custody.publishedRuntimeComplete, false);
  assert.ok(custody.kind === 'PUBLISHED_RUNTIME_ASSET' || custody.kind === 'EXACT_RELEASE_SOURCE_BUILD');
  const sourceDirectory = await realpath(String(custody.sourceDirectory));
  assert.equal(sourceDirectory, join(repo, '.runtime-download/TEST-donor-runtime-source'));
  const sourceFiles = [
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', '.node-version',
    'runtime.lock.json', 'electron.vite.config.ts', 'scripts/stage-runtime.mjs',
    'scripts/lib/github-release-download-error.mjs', 'scripts/lib/runtime-archive-checksum.mjs',
    'scripts/lib/runtime-payload-cache.mjs', 'scripts/lib/opencode-v2-base-inventory.mts',
    'scripts/ci/enforce-pnpm-install.mjs', 'scripts/ci/install-dependencies-with-retry.mjs',
    'scripts/ensure-electron-install.cjs', 'scripts/postinstall-electron.cjs',
    'scripts/prepare-cpu-features-rebuild.cjs', 'agent-teams-controller/package.json',
    'agent-teams-controller/scripts/build.mjs', 'mcp-server/package.json',
    'resources/runtime/COMMIT_SHA', 'resources/runtime/VERSION',
  ];
  assert.ok(Array.isArray(donor.files));
  const files = donor.files.map(record);
  assert.deepEqual(files.map(row => row.path), sourceFiles);
  const git = (directory: string, args: string[]) => execFileSync('/usr/bin/git', ['-C', directory, ...args],
    { encoding: 'utf8', timeout: 5000 }).trim();
  const verifyPin = async (row: Record<string, unknown>) => {
    assert.ok(typeof row.path === 'string' && isAbsolute(row.path));
    assert.match(String(row.sha256), /^[a-f0-9]{64}$/);
    assert.equal(await realpath(row.path), row.path);
    assert.equal(await fileDigest(row.path), row.sha256);
  };
  const assertInputs = async () => {
    input.source();
    for (const [directory, commit, tree] of [
      [donorRoot, donor.commit, donor.tree], [sourceDirectory, custody.sourceCommit, custody.sourceTree],
    ]) {
      assert.equal(git(String(directory), ['rev-parse', '--show-toplevel']), directory);
      assert.equal(git(String(directory), ['rev-parse', 'HEAD']), commit);
      assert.equal(git(String(directory), ['rev-parse', 'HEAD^{tree}']), tree);
      assert.equal(git(String(directory), ['diff', '--name-only', 'HEAD']), '');
      assert.equal(git(String(directory), ['ls-files', '--others', '--exclude-standard']), '');
    }
    for (const row of files) await verifyPin({ path: join(donorRoot, String(row.path)), sha256: row.sha256 });
    for (const row of [node, electron, runtime, custody, input.v1]) await verifyPin(row);
    assert.equal(await realpath(join(donorRoot, 'node_modules/electron/dist/electron')), electron.path);
    assert.equal(runtime.path, join(donorRoot, 'resources/runtime/claude-multimodel'));
    const helper = custody.kind === 'PUBLISHED_RUNTIME_ASSET'
      ? join(donorRoot, 'resources/runtime/native/opencode-custody/linux-x64/custodian')
      : join(sourceDirectory, 'dist/native/opencode-custody/linux-x64/custodian');
    assert.equal(custody.path, helper);
    for (const [path, sha256] of [
      [helper + '.json', custody.manifestSha256],
      [join(sourceDirectory, 'native/opencode-custody/linux.c'), custody.sourceSha256],
      [join(sourceDirectory, 'scripts/stage-opencode-custody.mts'), custody.buildScriptSha256],
      [join(sourceDirectory, 'scripts/lib/opencode-custody-artifact.ts'), custody.validatorSha256],
    ]) await verifyPin({ path, sha256 });
    assert.deepEqual(await json(helper + '.json'), custody.manifest);
    assert.equal(record(custody.manifest).sha256, custody.sha256);
    assert.equal((await json(join(donorRoot, 'package.json'))).packageManager, donor.packageManager);
    assert.equal((await readFile(join(donorRoot, 'resources/runtime/COMMIT_SHA'), 'utf8')).trim(), runtime.sourceCommit);
    assert.equal((await readFile(join(donorRoot, 'resources/runtime/VERSION'), 'utf8')).trim(), runtime.version);
  };
  await assertInputs();
  await mkdir(root, { mode: 0o700 });
  for (const directory of ['home', 'tmp', 'config/opencode', 'config/codex', 'data', 'cache', 'state',
    'userData', 'claude', 'claude/local/node_modules/.bin', 'bin', 'project', 'runtime-data', 'runtime-cache', 'evidence-corpus'])
    await mkdir(join(root, directory), { recursive: true, mode: 0o700 });
  proof.inputs = donor; proof.root = root;
  const { desktopAgentSentinelSource, desktopShellEnvironmentProbeSource } = await import('./desktop-backend-fixture.ts');
  const sentinelLog = join(root, 'sentinel-invocations.ndjson');
  const sentinel = desktopAgentSentinelSource(String(node.path), sentinelLog, String(runtime.cliVersion), 'metadata');
  for (const directory of ['bin', 'claude/local/node_modules/.bin'])
    for (const name of ['claude', 'codex', 'opencode', 'gemini', 'claude-multimodel', 'terminal-daemon'])
      await writeFile(join(root, directory, name), sentinel, { mode: 0o700, flag: 'wx' });
  await writeFile(join(root, 'bin/shell-env'), desktopShellEnvironmentProbeSource(String(node.path), sentinelLog), { mode: 0o700, flag: 'wx' });
  const environment: Record<string, string> = {
    HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), CFFIXED_USER_HOME: join(root, 'home'),
    MAC_CHROMIUM_TMPDIR: join(root, 'tmp'), XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
    PATH: `${join(root, 'bin')}:${dirname(String(node.path))}:/usr/bin:/bin`, SHELL: join(root, 'bin/shell-env'),
    NODE_ENV: 'development', NO_COLOR: '1', TERM: 'dumb', pnpm_config_verify_deps_before_run: 'warn',
    DISPLAY: process.env.LEGACY_DESKTOP_TEST_DISPLAY ?? '', XAUTHORITY: process.env.LEGACY_DESKTOP_TEST_XAUTHORITY ?? '',
    ...(process.env.LEGACY_DESKTOP_COREPACK_HOME ? { COREPACK_HOME: process.env.LEGACY_DESKTOP_COREPACK_HOME } : {}),
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: join(root, 'userData'), AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: join(root, 'claude'),
    CLAUDE_ROOT: join(root, 'claude'), CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'config/codex'), OPENCODE_CONFIG_DIR: join(root, 'config/opencode'),
    CLAUDE_CLI_PATH: join(root, 'bin/claude'), CODEX_CLI_PATH: join(root, 'bin/codex'),
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: String(runtime.path),
    CLAUDE_MULTIMODEL_OPENCODE_CUSTODY_HELPER: String(custody.path),
    OPENCODE_CLI_PATH: input.v1.path, OPENCODE_BIN_PATH: input.v1.path,
    CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: input.v1.path,
    CLAUDE_TERMINAL_DAEMON_BINARY: join(root, 'bin/terminal-daemon'),
    CLAUDE_DEV_RUNTIME_DISABLE_GH: '1', CLAUDE_DEV_RUNTIME_CACHE_ROOT: join(root, 'cache/runtime'),
    CLAUDE_MULTIMODEL_DATA_HOME: join(root, 'runtime-data'), CLAUDE_MULTIMODEL_CACHE_HOME: join(root, 'runtime-cache'),
    CLAUDE_TEAM_OPENCODE_MCP_HTTP: '1', CLAUDE_TEAM_OPENCODE_MCP_HTTP_PORT: String(await reservePort()),
    NODE_BINARY: String(node.path), DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', NO_PROXY: '127.0.0.1,localhost',
  };
  await writeFile(join(root, 'claude/agent-teams-config.json'), JSON.stringify({
    general: { appLocale: 'en', agentLanguage: 'en', theme: 'dark' },
    httpServer: { enabled: false, port: await reservePort() },
  }), { mode: 0o600, flag: 'wx' });
  const reviewFixture = await prepareDonorReviewFixture(root, environment);
  proof.reviewFixture = reviewFixture;
  const model = await startRetainedOpenCodeModel({ donorReview: reviewFixture });
  const errorsBefore = input.cleanupErrors.length;
  let failure: unknown, completed = false;
  const assertClosedInputs = async () => {
    await assertInputs();
    try {
      await lstat(join(root, 'userData/data/runtimes/codex/current.json'));
      assert.fail('fresh TEST profile must not publish a managed Codex binary');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  };
  try {
    const config = { $schema: 'https://opencode.ai/config.json', plugin: [],
      model: 'test-legacy/TEST-model', small_model: 'test-legacy/TEST-model', enabled_providers: ['test-legacy'],
      provider: { 'test-legacy': { npm: '@ai-sdk/openai-compatible', name: 'TEST donor V1 local only',
        options: { baseURL: `${model.url}/legacy/v1`, apiKey: 'TEST-LOCALHOST-ONLY' },
        models: { 'TEST-model': { name: 'TEST-model', tool_call: true, limit: { context: 200000, output: 2000 } } } } } };
    for (const path of ['project/opencode.json', 'config/opencode/opencode.json'])
      await writeFile(join(root, path), JSON.stringify(config), { mode: 0o600, flag: 'wx' });
    await exerciseRetainedDonorHistory({ repo, sourceHead: input.head, root, node: input.node,
      port: await reservePort(), donor: { root: donorRoot, commit: String(donor.commit), tree: String(donor.tree),
        node: { path: String(node.path) }, runtime: { path: String(runtime.path), sha256: String(runtime.sha256) },
        custody: { sha256: String(custody.sha256) } }, v1: input.v1, env: environment, model, proof,
      cleanupErrors: input.cleanupErrors, baseline: input.processBaseline, assertInputs: assertClosedInputs,
      reviewFixture, captureReview: identity => captureDonorReview(root, reviewFixture, identity, environment),
      preserveCorpus: (teamName, taskId) => preserveDonorCorpus(root, teamName, taskId, reviewFixture),
    });
    assert.deepEqual(model.failures, []);
    assert.deepEqual(model.observations.filter(row => row.donorStage).map(row => row.donorStage), ['read', 'edit', 'reply']);
    assert.equal(await readFile(reviewFixture.filePath, 'utf8'), reviewFixture.after);
    completed = true;
  } catch (error) { failure = error; }
  finally {
    try { await model.close(); } catch (error) { input.cleanupErrors.push(error); }
    if (completed) {
      try {
        assert.deepEqual(model.failures, []);
        assert.equal(model.observations.length, proof.inferenceAtDonorQuit, 'closed model has no upgrade or cold replay');
      } catch (error) { failure ??= error; completed = false; }
    }
    try { assert.deepEqual(await testNamespaceLinuxProcesses(root, input.processBaseline), []); }
    catch (error) { input.cleanupErrors.push(error); }
    proof.model = { observations: model.observations, failures: model.failures };
    proof.cleanup = input.cleanupErrors.length === errorsBefore;
    proof.status = completed && proof.cleanup ? 'PASS' : 'FAIL';
    proof.cleanupFailures = input.cleanupErrors.slice(errorsBefore).map(error => error instanceof Error ? error.message : String(error));
    if (failure) proof.failure = failure instanceof Error ? failure.message : String(failure);
  }
  if (failure) throw failure;
  assert.equal(proof.status, 'PASS', 'donor history and original cleanup are required before final PASS');
}

/** Fresh CI-only Git input; the model cannot fabricate product history or Review events. */
async function prepareDonorReviewFixture(root: string, environment: Record<string, string>) {
  const project = join(root, 'project'), relativePath = 'TEST-donor-review.txt';
  const before = 'TEST donor native review before\n', after = 'TEST donor native review after\n';
  const filePath = join(project, relativePath);
  await writeFile(filePath, before, { mode: 0o600, flag: 'wx' });
  const git = (args: string[]) => execFileSync('/usr/bin/git', ['-C', project,
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', timeout: 5000,
    env: { ...environment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'TEST donor', GIT_AUTHOR_EMAIL: 'test-donor@example.invalid',
      GIT_COMMITTER_NAME: 'TEST donor', GIT_COMMITTER_EMAIL: 'test-donor@example.invalid',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' } }).trim();
  git(['init', '--template=', '--initial-branch=TEST-donor']);
  await mkdir(join(project, '.git/info'), { recursive: true, mode: 0o700 });
  await writeFile(join(project, '.git/info/exclude'), '/opencode.json\n', { mode: 0o600 });
  git(['add', '--', relativePath]); git(['commit', '-m', 'TEST donor native Review input']);
  assert.equal(git(['ls-files']), relativePath); assert.equal(git(['status', '--porcelain']), '');
  const commit = git(['rev-parse', 'HEAD']), tree = git(['rev-parse', 'HEAD^{tree}']);
  assert.match(commit, /^[a-f0-9]{40}$/); assert.match(tree, /^[a-f0-9]{40}$/);
  const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII=', 'base64');
  const png = { path: join(root, 'TEST-donor-task.png'), name: 'TEST-donor-task.png',
    bytes: pngBytes.length, sha256: createHash('sha256').update(pngBytes).digest('hex') };
  await writeFile(png.path, pngBytes, { mode: 0o600, flag: 'wx' });
  return { filePath, relativePath, before, after, beforeSha256: digest(before), afterSha256: digest(after), commit, tree, png };
}

/** Read the old frontend's persisted strict-delivery join after its own Task Changes opened. */
async function captureDonorReview(root: string, fixture: Awaited<ReturnType<typeof prepareDonorReviewFixture>>,
  identity: Record<string, unknown>, environment: Record<string, string>) {
  const value = (key: string) => { const item = identity[key]; assert.ok(typeof item === 'string' && item.length > 0); return item; };
  const binding = Object.fromEntries(['teamName', 'runId', 'memberName', 'laneId', 'nativeSessionId',
    'taskId', 'displayId', 'messageId'].map(key => [key, value(key)]));
  assert.equal(binding.teamName, 'test-donor-4a-opencode-history'); assert.match(value('taskId'), /^[A-Za-z0-9_-]+$/);
  const read = async (path: string) => {
    assert.ok(path.startsWith(root + '/')); assert.equal(await realpath(path), path);
    const before = await lstat(path, { bigint: true });
    assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.uid === BigInt(process.getuid!()));
    assert.ok(before.size <= 8n * 1024n * 1024n, 'finite selected provenance file');
    const bytes = await readFile(path), after = await lstat(path, { bigint: true });
    assert.ok(before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
      before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs, 'same file throughout provenance read');
    return { bytes, pin: { path: path.slice(root.length + 1), sha256: createHash('sha256').update(bytes).digest('hex') } };
  };
  const { file: deliveryFile, row: deliveryRow } = await waitFor(async () => {
    const file = await read(join(root, 'claude/teams', value('teamName'), '.opencode-runtime/lanes',
      encodeURIComponent(value('laneId')), 'opencode-prompt-delivery-ledger.json'));
    const envelope = record(JSON.parse(file.bytes.toString('utf8')));
    assert.equal(envelope.schemaVersion, 1); assert.ok(Array.isArray(envelope.data) && envelope.data.length <= 200);
    const matches = envelope.data.map(record).filter(row => row.inboxMessageId === value('messageId'));
    assert.equal(matches.length, 1); const row = matches[0]!;
    for (const key of ['teamName', 'runId', 'memberName', 'laneId']) assert.equal(row[key], binding[key]);
    assert.equal(row.runtimeSessionId, binding.nativeSessionId);
    assert.ok(row.source === 'ui-send' || row.source === 'watcher');
    assert.deepEqual(row.taskRefs, [{ taskId: value('taskId'), displayId: value('displayId'), teamName: value('teamName') }]);
    assert.ok(['pending', 'accepted', 'responded'].includes(String(row.status)));
    if (row.status !== 'responded') return null;
    assert.ok(typeof row.deliveredUserMessageId === 'string' && row.deliveredUserMessageId.length > 0);
    return { file, row };
  }, 'original donor reply settles its exact delivery ledger', 30_000);
  const projects = join(root, 'claude/projects'), names = await readdir(projects);
  assert.ok(names.length <= 128); const journals: string[] = [];
  for (const name of names) {
    const path = join(projects, name, '.board-task-changes/events', value('taskId') + '.jsonl');
    try { await lstat(path); journals.push(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error; }
  }
  assert.equal(journals.length, 1, 'one original donor task ledger');
  const journal = await read(journals[0]!);
  const events = journal.bytes.toString('utf8').trim().split('\n').filter(Boolean).map(line => record(JSON.parse(line)));
  assert.ok(events.length > 0 && events.length <= 128);
  for (const event of events) {
    assert.ok(typeof event.eventId === 'string' && event.eventId.length > 0);
    assert.equal(event.taskId, binding.taskId); assert.equal(event.toolUseId, 'TEST_DONOR_REVIEW_EDIT');
    assert.equal(event.filePath, fixture.filePath); assert.equal(event.sourceRuntime, 'opencode');
  }
  assert.equal(new Set(events.map(row => row.eventId)).size, events.length);
  const superseded = new Set<unknown>(events.map(row => row.supersedesEventId).filter(item => typeof item === 'string'));
  for (const id of superseded) assert.ok(events.some(row => row.eventId === id));
  const active = events.filter(row => row.suppressed !== true && !superseded.has(row.eventId));
  assert.equal(active.length, 1); const selected = active[0]!;
  for (const [key, expected] of Object.entries({ taskRef: value('taskId'), taskRefKind: 'canonical', phase: 'work',
    sessionId: value('nativeSessionId'), memberName: value('memberName'), relativePath: fixture.relativePath,
    source: 'opencode_toolpart_edit', sourceProvider: 'opencode', sourceSessionId: value('nativeSessionId'),
    parentUserMessageId: deliveryRow.deliveredUserMessageId, attributionMethod: 'delivery-ledger-taskrefs',
    toolStatus: 'succeeded', operation: 'modify', snapshotSource: 'opencode', confidence: 'high' })) assert.equal(selected[key], expected);
  assert.ok(['opencode-snapshot', 'inverse-edit-chain'].includes(String(selected.evidenceProof)));
  for (const key of ['eventId', 'sourcePartId', 'sourceMessageId', 'sourceImportKey', 'snapshotId'])
    assert.ok(typeof selected[key] === 'string' && selected[key].length > 0);
  const sides: Record<string, { sha256: string; bytes: number }> = {};
  for (const [side, expected] of [['before', fixture.before], ['after', fixture.after]] as const) {
    const ref = record(selected[side]); assert.equal(ref.sha256, digest(expected));
    assert.equal(ref.sizeBytes, Buffer.byteLength(expected)); assert.equal(ref.blobRef, `sha256/${digest(expected)}`);
    const blob = await read(join(dirname(dirname(journals[0]!)), 'blobs', String(ref.blobRef)));
    assert.equal(blob.bytes.toString('utf8'), expected); sides[side] = { sha256: digest(expected), bytes: blob.bytes.length };
  }
  assert.equal(await readFile(fixture.filePath, 'utf8'), fixture.after);
  const project = join(root, 'project');
  const gitEnvironment = { ...environment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  assert.equal(execFileSync('/usr/bin/git', ['-C', project, 'rev-parse', 'HEAD'],
    { encoding: 'utf8', timeout: 5000, env: gitEnvironment }).trim(), fixture.commit);
  assert.equal(execFileSync('/usr/bin/git', ['-C', project, 'rev-parse', 'HEAD^{tree}'],
    { encoding: 'utf8', timeout: 5000, env: gitEnvironment }).trim(), fixture.tree);
  const fields = (row: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map(key => [key, row[key]]));
  return { binding, delivery: fields(deliveryRow, ['id', 'source', 'status', 'inboxMessageId', 'deliveredUserMessageId',
    'runtimeSessionId', 'runId', 'laneId', 'memberName', 'taskRefs']),
    event: fields(selected, ['eventId', 'toolUseId', 'taskId', 'sessionId', 'memberName', 'filePath', 'relativePath',
      'source', 'sourceRuntime', 'sourceProvider', 'sourceSessionId', 'sourcePartId', 'sourceMessageId',
      'parentUserMessageId', 'attributionMethod', 'sourceImportKey', 'evidenceProof', 'snapshotId', 'snapshotSource',
      'toolStatus', 'operation', 'confidence']),
    before: sides.before!, after: sides.after!, sources: { delivery: deliveryFile.pin, journal: journal.pin } };
}

/** Preserve raw stopped product/history bytes; exclude executables and unrelated Electron caches. */
async function preserveDonorCorpus(root: string, teamName: string, taskId: string,
  fixture: Awaited<ReturnType<typeof prepareDonorReviewFixture>>) {
  const directory = join(root, 'evidence-corpus');
  const files: { path: string; copy: string; bytes: number; sha256: string }[] = [];
  let totalBytes = 0;
  const visit = async (relative: string): Promise<void> => {
    if (relative === 'claude/local' || /\/host-authority\/[a-f0-9]{64}\/images$/.test(relative)) return;
    // The stock profile links dependencies to its shared cache and owns a separate temp directory.
    if (/^runtime-data\/opencode\/profiles\/[^/]+\/(?:config\/opencode\/node_modules|tmp)$/.test(relative)) return;
    const path = join(root, relative), before = await lstat(path, { bigint: true });
    assert.equal(before.isSymbolicLink(), false, 'raw corpus never follows a link');
    if (before.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) await visit(relative + '/' + entry);
      return;
    }
    assert.ok(before.isFile() && before.nlink === 1n && before.uid === BigInt(process.getuid!()));
    assert.ok(files.length < 4096 && before.size <= 64n * 1024n * 1024n, 'finite raw corpus file budget');
    const bytes = await readFile(path), after = await lstat(path, { bigint: true });
    assert.ok(before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
      before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs, 'stopped corpus stays current during capture');
    totalBytes += bytes.length; assert.ok(totalBytes <= 256 * 1024 * 1024, 'finite raw corpus byte budget');
    const copy = `file-${String(files.length).padStart(5, '0')}.bin`;
    await writeFile(join(directory, copy), bytes, { mode: 0o600, flag: 'wx' });
    files.push({ path: relative, copy, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  };
  assert.match(taskId, /^[A-Za-z0-9_-]+$/);
  for (const path of ['claude', 'runtime-data', 'data', 'state', 'config/opencode', 'project/opencode.json',
    `project/${fixture.relativePath}`, `userData/data/task-attachments/${teamName}/${taskId}`]) await visit(path);
  assert.ok(files.some(row => row.path.startsWith(`claude/teams/${teamName}/`)), 'real donor team corpus');
  assert.ok(files.some(row => row.path.startsWith(`claude/tasks/${teamName}/`)), 'real donor task corpus');
  assert.ok(files.some(row => /^runtime-data\/opencode\/profiles\/[^/]+\/data\/opencode\//.test(row.path)),
    'real native OpenCode managed-profile history corpus');
  assert.ok(files.some(row => /^runtime-data\/opencode\/profiles\/[^/]+\/data\/opencode\/snapshot\/[^/]+\/[a-f0-9]{40}\//.test(row.path)),
    'original managed-profile native Git snapshots remain in the raw stopped corpus');
  assert.ok(files.some(row => row.path === `project/${fixture.relativePath}` && row.sha256 === fixture.afterSha256));
  assert.ok(files.some(row => row.path.startsWith(`userData/data/task-attachments/${teamName}/${taskId}/`) &&
    row.sha256 === fixture.png.sha256 && row.bytes === fixture.png.bytes), 'actual original Task PNG corpus');
  assert.ok(files.some(row => row.path.includes('/.board-task-changes/events/') && row.path.endsWith(`/${taskId}.jsonl`)),
    'old frontend persisted its actual native Task Changes before Quit');
  const manifest = { directory, files, bytes: totalBytes };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
  return manifest;
}
