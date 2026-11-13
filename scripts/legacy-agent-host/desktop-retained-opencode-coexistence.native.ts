/** Genuine retained fork V1 and new Host V2 share one disposable original Electron profile. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { test } from 'node:test';
import { assertNativeV1Source, buildNativeV1Host } from '../../packages/legacy-agent-host/tests/opencode-v1-version-source.ts';
import { fileHash as fileDigest } from '../../packages/legacy-agent-host/tests/fixtures/native-host.ts';
import { waitFor } from '../e2e/release-updater/cdp.mts';
import { createDesktopUiControls, desktopJsLiteral } from './desktop-ui-controls.ts';
import { startRetainedOpenCodeModel } from './desktop-retained-opencode-model.ts';
import { originalLinuxProcessPresent, selectedLinuxProcesses, snapshotLinuxProcesses, startRetainedOpenCodeApp, testNamespaceLinuxProcesses } from './desktop-retained-opencode-app.ts';

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
  if (process.env.OPENCODE_V1_UI_SOURCE_SELECTION_GO === '1') {
    const { runDesktopRuntimeSourceSelection } = await import('./desktop-runtime-source-selection.ts');
    await runDesktopRuntimeSourceSelection({ repo, sourceHead: head, build, node, receiptPath,
      processBaseline, assertSource: source });
    return;
  }
  const v1 = await realpath(process.env.OPENCODE_V1_V2_RETAINED_BINARY!);
  const fork = await realpath(process.env.OPENCODE_V1_V2_RETAINED_RUNTIME!);
  const bun = await realpath(process.env.OPENCODE_V2_EMBEDDED_BUN!);
  const lock = await json(join(repo, 'runtime.lock.json'));
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
  const helperSource = await realpath(process.env.OPENCODE_V1_V2_RETAINED_CUSTODY_SOURCE!);
  const helperGit = (args: string[]) => execFileSync('git', args,
    { cwd: helperSource, encoding: 'utf8', timeout: 5000 }).trim();
  const verifyRetainedSource = () => {
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
        sha256: await fileDigest(fork), sourceBuiltRetainedHelper },
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
    const readLegacyReply = async (member: Record<string, unknown>, expectedReply: string): Promise<Record<string, unknown> | null> => {
      assert.equal(member.memberName, 'bob'); assert.equal(member.providerId, 'opencode');
      const laneId = member.laneId, nativeSessionId = member.runtimeSessionId;
      assert.ok(typeof laneId === 'string' && laneId.length > 0);
      assert.ok(typeof nativeSessionId === 'string' && nativeSessionId.length > 0);
      assert.deepEqual(model.failures, []);
      // This is the original member UI's native reader; generic JSONL logs are its fallback.
      const stream: Record<string, unknown> = await app!.call(`window.__TEST_retainedApi.memberLogStream.getMemberLogStream(
        ${literal(legacyTeam)},'bob',${literal({ laneId, limitSegments: 30, forceRefresh: true })})`);
      assert.ok(Array.isArray(stream.segments));
      const responseShapes: Record<string, unknown>[] = [];
      proof.legacyHistoryRead = { laneId, nativeSessionId, coverage: stream.coverage,
        warnings: stream.warnings, sources: stream.segments.map(value => record(value).source),
        actors: stream.segments.slice(0, 4).map(value => record(value).actor), responses: responseShapes };
      const segments = stream.segments.map(record).filter(segment => {
        const source = record(segment.source), actor = record(segment.actor);
        return source.provider === 'opencode_runtime' && source.label === 'OpenCode runtime' &&
          source.sessionId === nativeSessionId && source.laneId === laneId &&
          actor.memberName === 'bob' && actor.sessionId === nativeSessionId;
      });
      assert.ok(segments.length <= 1, 'native history binding is unambiguous');
      const replies: Record<string, unknown>[] = [];
      for (const segment of segments) {
        assert.ok(Array.isArray(segment.chunks));
        for (const value of segment.chunks) {
          const chunk = record(value);
          if (chunk.chunkType !== 'ai') continue;
          assert.ok(Array.isArray(chunk.responses));
          for (const responseValue of chunk.responses) {
            const response = record(responseValue);
            const shape: Record<string, unknown> = { type: response.type, role: response.role,
              sessionId: response.sessionId, uuid: response.uuid, expectedTextMatched: null };
            if (responseShapes.length < 16) responseShapes.push(shape);
            if (response.type !== 'assistant' || response.role !== 'assistant' ||
              response.sessionId !== nativeSessionId) continue;
            const text = typeof response.content === 'string' ? response.content :
              Array.isArray(response.content) ? response.content.map(record)
                .filter(block => block.type === 'text' && typeof block.text === 'string')
                .map(block => block.text).join('') : '';
            shape.expectedTextMatched = text === expectedReply;
            if (text !== expectedReply) continue;
            assert.ok(typeof response.uuid === 'string' && response.uuid.length > 0);
            replies.push({ provider: 'opencode_runtime', laneId, nativeSessionId,
              replyUuid: response.uuid, replyContentSha256: digest(JSON.stringify(response.content)) });
          }
        }
      }
      assert.ok(replies.length <= 1, 'one actual native assistant reply');
      assert.deepEqual(model.failures, []);
      return replies[0] ?? null;
    };
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
    const retainedLaunch = await callTeams('launchTeam', [{ teamName: legacyTeam, cwd: legacyProject,
      providerId: 'opencode', model: 'test-legacy/TEST-model', skipPermissions: true, runtimeSelectionVersion: 1 }], 240_000);
    assert.equal(typeof retainedLaunch.runId, 'string'); assert.notEqual(retainedLaunch.runId, created.runId);
    await waitLegacyRuntime(retainedLaunch.runId);
    const legacyProcesses = await legacyChildren();
    assert.ok(legacyProcesses.length > 0); natives.push(...legacyProcesses);
    steps.push({ observed: 'retained_legacy_fork_owner_before_new_Host_runtime', runId: retainedLaunch.runId, legacyProcesses });
    const selection = await host('team.launch.read', 'TEST-coexist-launch-read', {}); assert.equal(selection.ok, true);
    const launch = record(selection.value);
    const started = await host('team.launch.start', 'TEST-coexist-launch-once', {
      launchId: launch.launchId, rosterRevision: launch.rosterRevision,
      configuration: { members: [{ memberId: 'alice-id', model: 'test-local/TEST-model', permissions: 'bypass' }] },
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
      providerId: 'opencode', model: 'test-legacy/TEST-model', skipPermissions: true, runtimeSelectionVersion: 1 }], 240_000);
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
