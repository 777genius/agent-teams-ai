import { createMixedTaskNoticeReader } from '../../packages/legacy-agent-host/tests/fixtures/native-mixed-task-notifications.ts';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, lstatSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile, open } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { startNativeTeamModel } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';
import {
  startCodexModel,
  CONTEXT_MARKER as codexContext,
} from '../../packages/legacy-agent-host/tests/fixtures/native-codex-team/model.ts';
import {
  startOpenCodeModel,
  CONTEXT_MARKER as openCodeContext,
  type SettingsModelProbe,
  type LiveMembershipModelPhase,
} from '../../packages/legacy-agent-host/tests/fixtures/native-opencode-team/model.ts';
import { runtimeDigest, normalizeBinding } from '../../packages/legacy-agent-host/dist/runtime/identity.js';
import { effectId } from '../../packages/legacy-agent-host/dist/team/identity.js';
import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import { desktopBackendEnvironment, digest, fileDigest } from './desktop-backend-fixture.ts';
import { desktopOpenCodeV2ManagementProfile, prepareDesktopOpenCodeV2Recipe } from './desktop-opencode-v2-fixture.ts';
import type { DesktopOpenCodeV2Selection } from './desktop-opencode-v2-fixture.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
export const mixedDesktopTeamName = 'test-created-native-mixed';
const codeXHash = '8238273076041e55beded03ba1d51e034f997b7d100b0642d36daf036620fe57';
const openCodeHash = '417af53923f3d529759ab85ce3e8dd09116f742efcd332de591d2da6ebae696b';

/** Identity is read from the original capture AND its live registered grant. */
export function readMixedCapturedPrincipal(
  root: string,
  provider: 'claude' | 'codex' | 'opencode'
) {
  assert.match(basename(root), /^TEST-desktop-backend-/);
  const state = record(
    JSON.parse(
      readFileSync(
        join(root, 'hoststore/teams', mixedDesktopTeamName, '.host-owner/state.json'),
        'utf8'
      )
    )
  );
  assert.ok(Array.isArray(state.runtimeCaptures) && state.runtimeCaptures.length === 1);
  assert.ok(Array.isArray(state.members) && state.members.length === 3);
  assert.ok(Array.isArray(state.grants));
  const members = state.members
    .map(record)
    .filter((member) =>
      provider === 'claude'
        ? member.role === 'lead' && record(state.savedSettings).providerId === 'anthropic'
        : member.role === 'member' && record(member.settings).providerId === provider
    );
  assert.equal(members.length, 1, 'one canonical member for this TEST provider');
  const capture = record(state.runtimeCaptures[0]);
  assert.ok(Array.isArray(capture.members) && capture.members.length === 3);
  const bindings = capture.members
    .map(record)
    .filter((member) => member.memberId === members[0]!.memberId);
  assert.equal(bindings.length, 1);
  const binding = bindings[0]!;
  assert.equal(typeof binding.principalId, 'string');
  assert.equal(record(binding.delivery).runId, capture.launchId);
  assert.equal(record(binding.delivery).memberId, members[0]!.memberId);
  const grants = state.grants
    .map(record)
    .filter((grant) => grant.principalId === binding.principalId && grant.revoked !== true);
  assert.equal(grants.length, 1);
  assert.equal(grants[0]!.memberName, members[0]!.name);
  assert.ok(Array.isArray(grants[0]!.permissions));
  for (const permission of ['read', 'task.write', 'message.write', 'process.write'])
    assert.ok(grants[0]!.permissions.includes(permission));
  return String(grants[0]!.principalId);
}

export interface DesktopLiveMemberSelection { commandId: string; memberId: string }

/** One explicit case reads original owner files; it does not admit work or select a latest result. */
export function readMixedLiveMembershipIdentity(root: string, provider: 'claude' | 'codex' | 'opencode',
  target?: DesktopLiveMemberSelection) {
  assert.match(basename(root), /^TEST-desktop-backend-/);
  const directory = join(root, 'hoststore/teams', mixedDesktopTeamName, '.host-owner');
  const read = (name: string) => {
    const path = join(directory, name), before = lstatSync(path);
    assert.ok(before.isFile() && !before.isSymbolicLink() && before.size <= 1024 * 1024);
    const bytes = readFileSync(path), after = lstatSync(path);
    assert.equal(bytes.length, before.size);
    assert.deepEqual([after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs],
      [before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs]);
    return record(JSON.parse(bytes.toString('utf8')));
  };
  const rows = (value: unknown, maximum: number) => {
    assert.ok(Array.isArray(value) && value.length <= maximum); return value.map(record);
  };
  const state = read('state.json'), captures = rows(state.runtimeCaptures, 1);
  assert.equal(captures.length, 1);
  const capture = captures[0]!, original = rows(capture.members, 2), members = rows(state.members, 3);
  assert.equal(original.length, 2, 'the original capture contains only the two non-OpenCode peers');
  assert.equal(record(state.savedSettings).providerId, 'anthropic');
  const launch = read(`launches/${runtimeDigest(capture.launchId)}.json`), definition = record(launch.definition);
  assert.equal(definition.launchId, capture.launchId);
  const selectedMembers = rows(definition.members, 3), source = record(definition.capture);
  assert.equal(source.commandId, capture.commandId);
  assert.equal(source.configurationRevision, capture.configurationRevision);
  assert.equal(rows(source.members, 2).length, 2);
  const name = provider === 'claude' ? 'team-lead' : provider === 'codex' ? 'bob' : 'carol';
  const found = members.filter(row => row.name === name);
  assert.equal(found.length, 1); const member = found[0]!;
  assert.equal(member.role, provider === 'claude' ? 'lead' : 'member');
  if (provider !== 'claude') assert.equal(record(member.settings).providerId, provider);
  const selection = selectedMembers.filter(row => row.memberId === member.memberId);
  assert.equal(selection.length, 1); const selected = selection[0]!;
  const currentDelivery = record(member.delivery);
  for (const key of ['backendId', 'teamId', 'runId', 'memberId', 'generation'])
    assert.ok(typeof currentDelivery[key] === 'string' && currentDelivery[key]);
  const binding = normalizeBinding({ backendId: String(currentDelivery.backendId), teamId: String(currentDelivery.teamId),
    runId: String(currentDelivery.runId), memberId: String(currentDelivery.memberId), generation: String(currentDelivery.generation) });
  assert.deepEqual(selected.binding, binding);
  assert.equal(binding.backendId, record(state.binding).backendId);
  assert.equal(binding.teamId, record(state.binding).teamId);
  assert.equal(binding.runId, capture.launchId); assert.equal(binding.memberId, member.memberId);
  let principalId: string, commandId: string | undefined, captured: Record<string, unknown> | undefined;
  if (provider !== 'opencode') {
    assert.equal(target, undefined);
    const peers = original.filter(row => row.memberId === member.memberId); assert.equal(peers.length, 1);
    assert.deepEqual(peers[0]!.delivery, currentDelivery);
    assert.equal(typeof peers[0]!.principalId, 'string'); principalId = String(peers[0]!.principalId);
  } else {
    assert.ok(target); assert.equal(target.memberId, member.memberId);
    assert.equal(members.length, 3); assert.ok(!original.some(row => row.memberId === target.memberId));
    const commands = rows(state.rosterCommands, 1024).filter(row => row.commandId === target.commandId);
    assert.equal(commands.length, 1); const command = commands[0]!, decision = record(command.liveMembership);
    assert.equal(decision.phase, 'completed'); assert.ok(['add', 'restore'].includes(String(record(decision.delta).kind)));
    assert.equal(record(decision.delta).targetId, target.memberId); assert.equal(decision.launchId, capture.launchId);
    assert.equal(decision.sourceCaptureDigest, runtimeDigest(source));
    const view = record(decision.capture), privateTarget = record(view.target), published = record(decision.selection);
    assert.equal(view.commandId, target.commandId); assert.equal(view.teamId, record(state.binding).teamId);
    assert.equal(view.requestDigest, decision.requestDigest); assert.equal(view.sourceCaptureDigest, decision.sourceCaptureDigest);
    assert.equal(privateTarget.memberId, target.memberId);
    assert.equal(privateTarget.provider, 'opencode'); assert.equal(privateTarget.name, name);
    assert.deepEqual(published.delivery, currentDelivery);
    assert.equal(published.configurationDigest, selected.configurationDigest);
    assert.equal(privateTarget.configurationDigest, selected.configurationDigest);
    const history = rows(launch.liveMembership, 3).filter(row => record(row.intent).commandId === target.commandId);
    assert.equal(history.length, 1); const row = history[0]!, intent = record(row.intent);
    assert.equal(row.phase, 'selected'); assert.equal(intent.memberId, target.memberId);
    for (const key of ['requestDigest', 'sourceCaptureDigest', 'expectedRevision', 'launchId'])
      assert.equal(intent[key], key === 'expectedRevision' ? record(decision.input).expectedRevision : decision[key]);
    assert.equal(intent.originalFingerprint, command.fingerprint); assert.equal(row.rosterRevision, command.revision);
    assert.deepEqual(row.selected, selected); captured = record(row.capture);
    assert.equal(runtimeDigest(captured), row.captureDigest); assert.equal(row.captureDigest, view.captureDigest);
    assert.equal(captured.configurationDigest, selected.configurationDigest);
    assert.equal(captured.runtimeGeneration, selected.runtimeGeneration);
    assert.equal(captured.workspace, privateTarget.workspace);
    assert.equal(record(captured.member).memberId, target.memberId);
    assert.deepEqual(record(captured.member).settings, member.settings);
    const fresh = effectId('live-roster-agent', String(record(state.binding).teamId), target.commandId,
      target.memberId, String(decision.requestDigest));
    principalId = `agent:${fresh}`; commandId = target.commandId;
    assert.equal(published.principalId, principalId);
    const { configurationDigest: _digest, runtimeGeneration: _generation, ...origin } = captured;
    assert.equal(selected.configRevision, `live-${runtimeDigest(origin)}`);
  }
  const grants = rows(state.grants, 1024).filter(row => row.principalId === principalId && row.revoked !== true);
  assert.equal(grants.length, 1); assert.equal(grants[0]!.memberName, name);
  assert.ok(Array.isArray(grants[0]!.permissions));
  for (const permission of ['read', 'task.write', 'message.write', 'process.write'])
    assert.ok(grants[0]!.permissions.includes(permission));
  return { principalId, memberId: String(member.memberId), binding, launchId: String(capture.launchId),
    selected, ...(commandId ? { commandId, captured,
      sessionId: effectId('live-roster-session', principalId.slice('agent:'.length)) } : {}) };
}

/** Called only inside the explicitly authorized desktop proof; no agent starts here. */
export async function startDesktopMixedModels(root: () => string, options: { nativeGeneration?: 'v2'; liveMembership?: true } = {}) {
  assert.equal(process.env.LEGACY_DESKTOP_BACKEND_GO, '1');
  if (options.liveMembership) assert.equal(process.env.LEGACY_DESKTOP_MIXED_MEMBERSHIP_UI, '1');
  let membershipPhase: LiveMembershipModelPhase = 'idle', membershipTarget: DesktopLiveMemberSelection | undefined;
  const principal = (provider: 'claude' | 'codex' | 'opencode') => options.liveMembership
    ? readMixedLiveMembershipIdentity(root(), provider, provider === 'opencode' ? membershipTarget : undefined).principalId
    : readMixedCapturedPrincipal(root(), provider);
  let claudeProbePhase: 'native' | 'cold-readback' = 'native';
  let settingsProbe: SettingsModelProbe | 'idle' | undefined = 'idle';
  const settingsExpected: SettingsModelProbe[] = [
    { step: 'global-default', model: 'TEST-model' },
    { step: 'project-default', model: 'TEST-project-model' },
    { step: 'project-test', model: 'TEST-project-model' },
    ...(!options.nativeGeneration
      ? [{ step: 'local-limits' as const, model: 'TEST-model' as const, outputTokens: 1536 }] : []),
  ];
  const settingsCompleted: SettingsModelProbe['step'][] = [];
  const claude = await startNativeTeamModel({
      mixedTaskNotifications: createMixedTaskNoticeReader(root, 'team-lead'),
    allowModelProbes: true,
    nativeModelProbeLimit: 9,
    modelProbePhase: () => claudeProbePhase,
    mixedGroups: true,
    uiGeneratedMessageIds: true,
    memberName: 'team-lead',
    principalId: () => principal('claude'),
  });
  let codex: Awaited<ReturnType<typeof startCodexModel>> | undefined;
  let opencode: Awaited<ReturnType<typeof startOpenCodeModel>> | undefined;
  try {
    codex = await startCodexModel({
      mixedTaskNotifications: createMixedTaskNoticeReader(root, 'bob'),
      allowModelProbes: true,
      modelProbeWorkspace: () => join(root(), 'workspace'),
      mixedGroups: true,
      principalId: () => principal('codex'),
    });
    opencode = await startOpenCodeModel({
      ...(options.nativeGeneration ? { nativeGeneration: options.nativeGeneration } : {}),
      ...(!options.liveMembership ? { mixedTaskNotifications: createMixedTaskNoticeReader(root, 'carol'),
        mixedGroups: true, settingsProbe: () => settingsProbe,
        ...(!options.nativeGeneration ? { selectedBusinessOutputTokens: 1536 } : {}) } : {
        uiGeneratedMessageIds: true, liveMembershipPhase: () => membershipPhase }),
      allowModelProbes: true,
      principalId: () => principal('opencode'),
      selectedModel: { id: 'TEST-model' },
    });
    const selected = { claude, codex, opencode };
    let evidenceRoot: string | undefined;
    return {
      ...selected,
      openCodeGeneration: options.nativeGeneration ?? 'v1' as const,
      openCodeProviderId: options.nativeGeneration ? 'test-local' as const : 'local' as const,
      ...(options.liveMembership ? { membership: {
        get phase() { return membershipPhase; },
        advance(next: Exclude<LiveMembershipModelPhase, 'idle'>, target?: DesktopLiveMemberSelection) {
          const phases: LiveMembershipModelPhase[] = ['idle', 'add', 'add-ready', 'remove', 'restore', 'restore-ready', 'stopped'];
          const index = phases.indexOf(membershipPhase);
          assert.equal(next, phases[index + 1], 'one finite original membership phase');
          const counts = [[0, 0], [1, 0], [1, 2], [1, 2], [2, 2], [2, 4]][index]!;
          assert.deepEqual([selected.opencode.probes.length, selected.opencode.observations.length], counts);
          for (const model of Object.values(selected)) assert.deepEqual(model.failures, []);
          for (const model of [selected.claude, selected.codex]) {
            assert.equal(model.observations.length, 0); assert.equal(model.notificationObservations?.length ?? 0, 0);
          }
          if (next === 'add-ready' || next === 'restore-ready') {
            assert.ok(target); readMixedLiveMembershipIdentity(root(), 'opencode', target);
            membershipTarget = Object.freeze({ ...target });
          } else assert.equal(target, undefined);
          membershipPhase = next;
        },
      } } : {}),
      settingsProbes: {
        expectedCount: settingsExpected.length,
        begin(step: SettingsModelProbe['step']) {
          const expected = settingsExpected[settingsCompleted.length];
          assert.equal(expected?.step, step, 'one ordered original Settings intent');
          assert.equal(settingsProbe, step === 'local-limits' ? undefined : 'idle');
          settingsProbe = Object.freeze({ ...expected! });
        },
        finish(step: SettingsModelProbe['step']) {
          assert.ok(settingsProbe && settingsProbe !== 'idle');
          assert.equal(settingsProbe.step, step);
          assert.deepEqual(selected.opencode.failures, []);
          assert.equal(selected.opencode.probes.filter(probe => probe.settingsStep === step).length, 1);
          settingsCompleted.push(step);
          settingsProbe = step === 'local-limits' ? undefined : 'idle';
        },
        beginConfiguration() {
          assert.deepEqual(settingsCompleted, ['global-default', 'project-default', 'project-test']);
          assert.equal(settingsProbe, 'idle');
          settingsProbe = undefined;
        },
        assertComplete() {
          assert.equal(settingsProbe, undefined);
          assert.deepEqual(settingsCompleted, settingsExpected.map(probe => probe.step));
          assert.equal(selected.opencode.probes.filter(probe => probe.settingsStep !== undefined).length,
            settingsExpected.length);
        },
      },
      beginColdReadbackProbes: () => {
        assert.equal(claudeProbePhase, 'native', 'one original cold readback phase');
        const nativeProbeCount = claude.probes.length;
        assert.ok(nativeProbeCount >= 8 && nativeProbeCount <= 9,
          'seven configuration probes and one or two original Launch probes');
        assert.deepEqual(claude.failures, []);
        claudeProbePhase = 'cold-readback';
        return nativeProbeCount;
      },
      retainEvidenceAt: async (root: string) => {
        assert.equal(evidenceRoot, undefined, 'one original TEST mixed model evidence root');
        assert.match(basename(root), /^TEST-desktop-backend-/);
        assert.equal(await realpath(root), root);
        evidenceRoot = root;
      },
      close: async () => {
        try {
          if (evidenceRoot)
            await writeFile(
              join(evidenceRoot, 'mixed-models.json'),
              JSON.stringify(
                {
                  schemaVersion: 1,
                  phase: 'before-model-close',
                  root: evidenceRoot,
                  providers: Object.fromEntries(
                    Object.entries(selected).map(([provider, model]) => [
                      provider,
                      {
                        observations: model.observations,
                        notificationObservations: model.notificationObservations,
                        probes: model.probes,
                        failures: model.failures,
                        ...('unexpectedNoToolsRequests' in model
                          ? { unexpectedNoToolsRequests: model.unexpectedNoToolsRequests }
                          : {}),
                      },
                    ])
                  ),
                },
                null,
                2
              ),
              { mode: 0o600, flag: 'wx' }
            );
        } finally {
          await Promise.all(Object.values(selected).map((model) => model.close()));
        }
      },
    };
  } catch (error) {
    await Promise.all([claude.close(), codex?.close(), opencode?.close()]);
    throw error;
  }
}
export type DesktopMixedModels = Awaited<ReturnType<typeof startDesktopMixedModels>>;

/** Private TEST files only, before an app/Host/capture exists. All source identities come from the selected base fixture. */
export async function prepareDesktopMixedNativeFixture(
  base: Awaited<ReturnType<typeof prepareDesktopBackendFixture>>,
  options: {
    codexPath: string;
    openCodePath: string;
    openCodeEndpoint: string;
    openCodeManagementEndpoint: string;
    openCodeV2?: Pick<DesktopOpenCodeV2Selection,
      'bunPath' | 'bunSha256' | 'engineDirectory' | 'processCustody'>;
    models: DesktopMixedModels;
  }
) {
  assert.match(basename(base.root), /^TEST-desktop-backend-/);
  assert.equal(await fileDigest(base.profilePath), base.pins.profileSha256);
  assert.equal(await fileDigest(base.descriptorPath), base.pins.descriptorSha256);
  const profile = JSON.parse(await readFile(base.profilePath, 'utf8')) as TeamHostProfile;
  assert.equal(profile.owner.storageRoot, join(base.root, 'hoststore'));
  assert.ok(profile.creation?.contextIds.includes('local'));
  const claude = profile.runtime?.providerTemplates?.find((item) => item.provider === 'claude');
  assert.ok(claude?.provider === 'claude');
  assert.equal(options.models.openCodeGeneration, options.openCodeV2 ? 'v2' : 'v1',
    'the native oracle and selected engine must use the same protocol');
  assert.equal(profile.runtime!.providerTemplates!.length, 1);
  // Metadata-only TEST rows feed the ordinary project picker before any app exists.
  // These are neither native history nor an imported product corpus.
  for (const name of ['workspace', 'workspace-other']) {
    const cwd = join(base.root, name);
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const discovery = join(base.root, 'claude/projects', cwd.replace(/[/\\]/g, '-'));
    await mkdir(discovery, { recursive: true, mode: 0o700 });
    await writeFile(join(discovery, 'TEST-project-discovery-only.jsonl'),
      JSON.stringify({ type: 'TEST-project-discovery-only', cwd }) + '\n',
      { mode: 0o600, flag: 'wx' });
    await mkdir(join(base.root, 'preferences', name), { recursive: true, mode: 0o700 });
  }
  await mkdir(join(base.root, 'preferences/global'), { recursive: true, mode: 0o700 });
  claude.nativeOptions = { ...claude.nativeOptions, settingSources: [] };
  assert.notEqual(options.openCodeManagementEndpoint, options.openCodeEndpoint);
  for (const value of [options.openCodeEndpoint, options.openCodeManagementEndpoint]) {
    const endpoint = new URL(value);
    assert.equal(endpoint.protocol, 'http:');
    assert.equal(endpoint.hostname, '127.0.0.1');
    assert.equal(endpoint.origin, value);
    assert.ok(endpoint.port);
  }
  for (const [path, sha] of [
    [options.codexPath, codeXHash],
    ...(!options.openCodeV2 ? [[options.openCodePath, openCodeHash]] : []),
  ]) {
    assert.ok(path && sha);
    assert.equal(await realpath(path), path);
    assert.equal(await fileDigest(path), sha);
  }
  const environment = async (provider: string) => {
    const folder = join(base.root, 'providers', provider);
    for (const name of ['home', 'config', 'data', 'cache', 'tmp'])
      await mkdir(join(folder, name), { recursive: true, mode: 0o700 });
    return {
      HOME: join(folder, 'home'),
      TMPDIR: join(folder, 'tmp'),
      XDG_CONFIG_HOME: join(folder, 'config'),
      XDG_DATA_HOME: join(folder, 'data'),
      XDG_CACHE_HOME: join(folder, 'cache'),
      PATH: dirname(base.node) + ':/usr/bin:/bin',
      SHELL: '/bin/sh',
    };
  };
  const codexEnvironment = {
    ...(await environment('codex')),
    CODEX_HOME: join(base.root, 'providers/codex/config'),
    TEST_CODEX_FIXTURE_KEY: 'TEST-LOCALHOST-ONLY',
  };
  await writeFile(
    join(codexEnvironment.CODEX_HOME, 'config.toml'),
    `model = "mock-model"
model_provider = "TEST_fixture"
approval_policy = "never"
sandbox_mode = "workspace-write"
web_search = "disabled"
check_for_update_on_startup = false
cli_auth_credentials_store = "file"
project_doc_max_bytes = 0
[analytics]
enabled = false
[otel]
exporter = "none"
metrics_exporter = "none"
[features]
code_mode = false
apps = false
plugins = false
remote_models = false
shell_snapshot = false
skip_host_skill_discovery = true
enable_request_compression = false
multi_agent = false
[shell_environment_policy]
inherit = "none"
set = { HOME = ${JSON.stringify(codexEnvironment.HOME)}, TMPDIR = ${JSON.stringify(codexEnvironment.TMPDIR)}, PATH = "/usr/bin:/bin" }
[model_providers.TEST_fixture]
name = "TEST fixture"
base_url = ${JSON.stringify(options.models.codex.url + '/v1')}
env_key = "TEST_CODEX_FIXTURE_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`,
    { mode: 0o600 }
  );
  const common = (provider: string) => ({
    teamId: 'TEST-template',
    memberId: `TEST-${provider}-template`,
    principalId: `TEST-${provider}-template`,
    sessionId: `TEST-${provider}-template`,
    generation: 0,
    configRevision: `TEST-${provider}-config`,
    cwd: join(base.root, 'workspace'),
    accountBinding: `TEST-${provider}-localhost-only`,
    limits: { ...claude.limits },
  });
  const codex = {
    ...common('codex'),
    provider: 'codex' as const,
    protocolRevision: '0.162.0' as const,
    model: 'mock-model',
    environment: codexEnvironment,
    executable: { path: options.codexPath, sha256: codeXHash },
    nativeOptions: {
      approvalPolicy: 'never' as const,
      sandbox: 'workspace-write' as const,
      modelProvider: 'TEST_fixture',
      developerInstructions: codexContext,
    },
  };
  const opencode = options.openCodeV2 ? await prepareDesktopOpenCodeV2Recipe({
    repo: join(import.meta.dirname, '../..'), root: base.root, node: base.node,
    selection: { ...options.openCodeV2, endpoint: options.openCodeEndpoint,
      managementEndpoint: options.openCodeManagementEndpoint,
      modelUrl: options.models.opencode.url, settingsProjectModel: true },
    identity: common('opencode'),
  }) : {
    ...common('opencode'),
    provider: 'opencode' as const,
    protocolRevision: '1.19.4' as const,
    endpoint: options.openCodeEndpoint,
    model: 'TEST-model',
    executable: { path: options.openCodePath, sha256: openCodeHash },
    environment: {
      ...(await environment('opencode')),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        autoupdate: false,
        share: 'disabled',
        enabled_providers: ['local'],
        model: 'local/TEST-model',
        small_model: 'local/TEST-model',
        permission: { '*': 'deny', bash: 'allow' },
        agent: {
          title: { disable: true },
          summary: { disable: true },
          'TEST-member': { mode: 'primary' },
        },
        compaction: { auto: false },
        provider: {
          local: {
            npm: '@ai-sdk/openai-compatible',
            name: 'TEST fixture',
            options: {
              baseURL: options.models.opencode.url + '/v1',
              apiKey: 'TEST-LOCALHOST-ONLY',
            },
            models: {
              'TEST-model': { name: 'TEST-model', limit: { context: 200000, output: 2000 } },
              'TEST-project-model': { name: 'TEST-project-model', limit: { context: 98304, output: 1024 } },
            },
          },
        },
      }),
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_TELEMETRY: '1',
      OPENCODE_DISABLE_SHARE: '1',
      NO_COLOR: '1',
    },
    nativeOptions: {
      providerId: 'local',
      agent: 'TEST-member',
      instructions: openCodeContext,
    },
  };
  if (options.openCodeV2?.processCustody) {
    if (profile.processCustody)
      assert.deepEqual(profile.processCustody, options.openCodeV2.processCustody);
    profile.processCustody = options.openCodeV2.processCustody;
  }
  let membershipProject: { path: string; sha256: string; dev: number; ino: number } | undefined;
  if (options.models.membership) {
    assert.equal(process.env.LEGACY_DESKTOP_MIXED_MEMBERSHIP_UI, '1');
    const providerId = options.models.openCodeProviderId;
    assert.equal(opencode.nativeOptions.providerId, providerId);
    assert.equal(opencode.cwd, join(base.root, 'workspace')); assert.equal(await realpath(opencode.cwd), opencode.cwd);
    const original = options.openCodeV2
      ? record(record('embedded' in opencode ? opencode.embedded : undefined).providerConfiguration) : undefined;
    if (original) assert.equal(original.package, 'aisdk:@ai-sdk/openai-compatible');
    const provider = original ? { npm: '@ai-sdk/openai-compatible', options: original.settings, models: original.models }
      : record(record(record(JSON.parse(opencode.environment.OPENCODE_CONFIG_CONTENT!)).provider)[providerId]);
    assert.equal(provider.npm, '@ai-sdk/openai-compatible');
    assert.equal(record(provider.options).baseURL, options.models.opencode.url + '/v1');
    assert.equal(record(provider.options).apiKey, 'TEST-LOCALHOST-ONLY');
    assert.ok(record(provider.models)['TEST-model']);
    const bytes = Buffer.from(JSON.stringify({ provider: { [providerId]: provider } }) + '\n');
    assert.ok(bytes.length <= 64 * 1024);
    const path = join(opencode.cwd, 'opencode.json'), file = await open(path, 'wx+', 0o600);
    try {
      await file.writeFile(bytes); const stat = await file.stat();
      assert.ok(stat.isFile() && stat.nlink === 1 && stat.size === bytes.length && (stat.mode & 0o777) === 0o600);
      const actual = Buffer.alloc(bytes.length + 1); let offset = 0;
      while (offset < actual.length) {
        const { bytesRead } = await file.read(actual, offset, actual.length - offset, offset);
        if (!bytesRead) break; offset += bytesRead;
      }
      assert.ok(offset === bytes.length && actual.subarray(0, offset).equals(bytes));
      const after = lstatSync(path);
      assert.ok(after.isFile() && !after.isSymbolicLink() && after.dev === stat.dev && after.ino === stat.ino);
      assert.equal(await realpath(path), path);
      membershipProject = { path, sha256: digest(bytes), dev: stat.dev, ino: stat.ino };
    } finally { await file.close(); }
  }
  profile.runtime!.providerTemplates!.push(codex, opencode);
  const descriptor = record(JSON.parse(await readFile(base.descriptorPath, 'utf8')));
  assert.ok(Array.isArray(descriptor.management) && descriptor.management.length === 1);
  const selected = record(descriptor.management[0]);
  const management: NonNullable<TeamHostProfile['management']> = [
    {
      provider: 'codex',
      protocolRevision: '0.162.0',
      profileId: `${profile.owner.profileId}:codex`,
      accountBinding: codex.accountBinding,
      configRevision: 'TEST-codex-management',
      cwd: codex.cwd,
      environment: codex.environment,
      executable: codex.executable,
      modelProvider: codex.nativeOptions.modelProvider,
      timeoutMs: 15000,
      modelProbeTimeoutMs: 30000,
    },
    ...(options.openCodeV2 ? [desktopOpenCodeV2ManagementProfile(opencode,
      options.openCodeManagementEndpoint, `${profile.owner.profileId}:opencode`)] : [{
      provider: 'opencode',
      profileId: `${profile.owner.profileId}:opencode`,
      accountBinding: opencode.accountBinding,
      configRevision: 'TEST-opencode-management',
      cwd: opencode.cwd,
      environment: opencode.environment,
      executable: opencode.executable,
      endpoint: options.openCodeManagementEndpoint,
      timeoutMs: 15000,
      modelProbeTimeoutMs: 30000,
    } as const]),
  ];
  for (const item of management) {
    profile.management!.push(item);
    for (const projectPath of item.provider === 'opencode'
      ? [null, join(base.root, 'workspace'), join(base.root, 'workspace-other')] : [null]) {
      descriptor.management.push({
        ...selected,
        runtimeId: item.provider,
        profileId: item.profileId,
        configRevision: item.configRevision,
        projectPath,
        ...(item.provider === 'opencode' ? {
          preferences: {
            globalRoot: join(base.root, 'preferences/global'),
            projectRoot: projectPath === null ? null : join(base.root, 'preferences', basename(projectPath)),
          },
        } : {}),
      });
    }
  }
  const profileBytes = JSON.stringify(profile);
  await writeFile(base.profilePath, profileBytes, { mode: 0o600 });
  readTeamHostProfile(base.profilePath, digest(profileBytes));
  assert.ok(Array.isArray(descriptor.owners) && descriptor.owners.length === 1);
  const ownerProfile = record(record(descriptor.owners[0]).profile);
  ownerProfile.env = {
    ...record(ownerProfile.env),
    LEGACY_AGENT_HOST_PROFILE_SHA256: digest(profileBytes),
  };
  const descriptorBytes = JSON.stringify(descriptor);
  await writeFile(base.descriptorPath, descriptorBytes, { mode: 0o600 });
  return {
    ...base,
    ...(membershipProject ? { membershipProject } : {}),
    pins: {
      ...base.pins,
      profileSha256: digest(profileBytes),
      descriptorSha256: digest(descriptorBytes),
    },
    appEnvironment: desktopBackendEnvironment(
      base.root,
      base.node,
      base.descriptorPath,
      digest(descriptorBytes)
    ),
  };
}

/** Reserve an owned ephemeral listener, then let only the captured native server claim it. */
export async function reserveMixedOpenCodeEndpoint() {
  const reservation = createServer();
  await new Promise<void>((done, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', done);
  });
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  await new Promise<void>((done, reject) =>
    reservation.close((error) => (error ? reject(error) : done()))
  );
  return endpoint;
}
