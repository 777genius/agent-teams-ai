import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireProfileWriterLease } from '../../packages/legacy-agent-host/dist/adapters/profile/ProfileWriterLease.js';
import { createFilesystemTeamOwner } from '../../packages/legacy-agent-host/dist/adapters/team/createFilesystemTeamOwner.js';
import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import { runtimeMemberProfileSchema } from '../../packages/legacy-agent-host/dist/composition/runtimeProfile.js';
import { providerManagementProfileSchema } from '../../packages/legacy-agent-host/dist/management/profile.js';
import { desktopNodeScriptHeader, digest, fileDigest, prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import { assertOwnedCdpListener, command, processTable } from './desktop-backend-observations.ts';
import { prepareDesktopOpenCodeVersionSentinel } from './desktop-emulated-management-fixture.ts';
import { reserveMixedOpenCodeEndpoint } from './desktop-mixed-native-fixture.ts';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Row;
};
export const collaborationPeerSources = [
  'tools/owned-process-broker/fixtures/claudeProviderPeer.mjs',
  'tools/owned-process-broker/fixtures/providerPeer.mjs',
  'tools/owned-process-broker/fixtures/providerDesktopPeer.mjs',
  'tools/owned-process-broker/fixtures/providerCollaboration.mjs',
  'packages/legacy-agent-host/dist/adapters/providers/OpenCodeMcpPolicyPlugin.js',
] as const;
const providers = ['claude', 'codex', 'opencode'] as const;

/** Saved TEST roster only. Every later allocation, membership change and message comes from the UI/Host. */
export async function prepareDesktopEmulatedCollaborationFixture(repo: string, pnpmEntry: string) {
  const fixture = await prepareDesktopBackendFixture(repo, { pnpmEntry, seedUiPreferences: true, creation: true });
  const sources = await Promise.all(collaborationPeerSources.map(async source => {
    const path = join(repo, source); assert.equal(await realpath(path), path);
    return { path, sha256: await fileDigest(path) };
  }));
  const endpoints = { runtime: await reserveMixedOpenCodeEndpoint(), management: await reserveMixedOpenCodeEndpoint() };
  assert.notEqual(endpoints.runtime, endpoints.management);
  const selections = await Promise.all(providers.map(async (provider, index) => {
    const root = join(fixture.root, `TEST-peer-${provider}-scope`), memberName = ['alice', 'bob', 'carol'][index]!;
    for (const name of ['', 'home', 'tmp', 'config', 'data', 'cache']) await mkdir(join(root, name), { mode: 0o700 });
    const wrapper = `${desktopNodeScriptHeader(fixture.node)}import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {readFileSync,realpathSync} from 'node:fs';
for(const source of ${JSON.stringify(sources)}){assert.equal(realpathSync(source.path),source.path);assert.equal(createHash('sha256').update(readFileSync(source.path)).digest('hex'),source.sha256)}
${provider === 'codex' ? "if(process.argv.length===3&&process.argv[2]==='--version')process.stdout.write('codex-cli 0.162.0\\n');else " : ''}await import(${JSON.stringify(pathToFileURL(sources[provider === 'claude' ? 0 : 1]!.path).href)});
`;
    const path = join(fixture.root, 'bin', `TEST-${provider}-collaboration${provider === 'claude' ? '' : '.mjs'}`);
    await writeFile(path, wrapper, { mode: 0o700, flag: 'wx' });
    const executable = { path, sha256: digest(wrapper) };
    const peers = (['runtime', 'management'] as const).map(role => ({ provider, root, role,
      environment: {
        HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'),
        XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'),
        PATH: `${dirname(fixture.node)}:/usr/bin:/bin`, SHELL: '/bin/sh',
        TEST_EMULATED_DESKTOP_PROVIDER: '1', TEST_PEER_SCENARIO: 'desktop-ui-v1', TEST_PEER_PROVIDER: provider,
        TEST_PEER_ROLE: role, TEST_DESKTOP_PEER_ROOT: root, TEST_PEER_EFFECTS: join(root, 'effects.ndjson'),
        TEST_DESKTOP_PEER_WORKSPACE: join(fixture.root, 'workspace'),
        TEST_DESKTOP_COLLABORATION: 'mixed-v1', TEST_DESKTOP_COLLABORATION_MEMBER: memberName,
        TEST_PEER_COLLABORATION_SHA256: sources[3]!.sha256,
        ...(provider === 'claude' ? { CLAUDE_CONFIG_DIR: join(root, 'config') }
          : { TEST_PEER_HELPER_SHA256: sources[2]!.sha256 }),
        ...(provider === 'codex' ? { CODEX_HOME: join(root, 'config') } : {}),
        ...(provider === 'opencode' ? { TEST_PEER_MCP_POLICY_SHA256: sources[4]!.sha256,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, share: 'disabled',
          model: 'test-provider/TEST-model', small_model: 'test-provider/TEST-model', provider: { 'test-provider': {
            npm: '@ai-sdk/openai-compatible', name: 'TEST provider', options: {
              baseURL: 'http://127.0.0.1:19999/TEST-no-network', apiKey: 'TEST-LOCALHOST-ONLY' },
            models: { 'TEST-model': { name: 'TEST model', limit: { context: 4096, output: 1024 } } } } },
          agent: { build: { mode: 'primary' } }, compaction: { auto: false } }),
          OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_TELEMETRY: '1', OPENCODE_DISABLE_SHARE: '1' } : {}),
      } as Record<string, string> }));
    return { provider, memberName, executable, peers };
  }));
  fixture.appEnvironment.CODEX_CLI_PATH = selections[1]!.executable.path;
  const openCodeConfig = record(JSON.parse(selections[2]!.peers[0]!.environment.OPENCODE_CONFIG_CONTENT!));
  const projectPath = join(fixture.root, 'workspace/opencode.json'), projectBytes = JSON.stringify({ provider: openCodeConfig.provider });
  await writeFile(projectPath, projectBytes, { mode: 0o600, flag: 'wx' });
  const project = { path: projectPath, sha256: digest(projectBytes) };
  const versionSentinel = await prepareDesktopOpenCodeVersionSentinel(fixture);
  const profile = JSON.parse(await readFile(fixture.profilePath, 'utf8')) as TeamHostProfile;
  assert.equal(profile.runtime, undefined); assert.equal(profile.management, undefined);
  const team = profile.teams[0]!;
  team.members = [{ memberId: 'alice-id', name: 'alice', role: 'lead' },
    { memberId: 'bob-id', name: 'bob', role: 'member', settings: { providerId: 'codex', model: 'TEST-model' } }];
  team.savedSettings = { cwd: join(fixture.root, 'workspace'), providerId: 'anthropic', model: 'sonnet', effort: 'low',
    fastMode: 'off', prompt: '', skipPermissions: false, syncModelsWithLead: false };
  const templates = selections.map(({ provider, memberName, executable, peers }) => {
    const memberId = `${memberName}-id`, principalId = `${memberName}-session`, environment = peers[0]!.environment;
    if (provider !== 'opencode') {
      team.members.find(row => row.memberId === memberId)!.delivery = { ...team.binding, runId: team.scope.runId, memberId, generation: '1' };
      team.grants.push({ principalId, memberName, permissions: ['read', 'task.write', 'message.write'] });
    }
    return runtimeMemberProfileSchema.parse({ provider, teamId: team.binding.teamId, memberId, principalId,
      sessionId: `TEST-collaboration-${provider}-session`, generation: 1, configRevision: `TEST-collaboration-${provider}-runtime`,
      cwd: team.savedSettings!.cwd, model: provider === 'claude' ? 'sonnet' : 'TEST-model',
      accountBinding: 'TEST-no-vendor-account', executable, environment,
      ...(provider === 'claude' ? { configNamespace: 'custom-directory', nativeTools: ['Read', 'Write', 'AskUserQuestion'],
        autoAllowedTools: [], nativeOptions: { permissionMode: 'default', settingSources: [], effort: 'low', fastMode: false } }
        : provider === 'codex' ? { protocolRevision: '0.162.0', nativeOptions: { approvalPolicy: 'on-request', sandbox: 'read-only' } }
          : { protocolRevision: '1.19.4', endpoint: endpoints.runtime, nativeOptions: { providerId: 'test-provider', agent: 'build', toolApprovalMode: 'manual' } }),
      limits: { queuedInputs: 2, inputBytes: 65536, outputBytes: 1_000_000, outputEvents: 1500, pendingInteractions: 4, timeoutMs: 90_000 },
    });
  });
  profile.runtime = { members: templates.slice(0, 2), providerTemplates: templates };
  profile.management = selections.map(({ provider, executable, peers }) => providerManagementProfileSchema.parse({ provider,
    profileId: `TEST-collaboration-${provider}-management`, configRevision: `TEST-collaboration-${provider}-management`,
    accountBinding: 'TEST-no-vendor-account', cwd: team.savedSettings!.cwd, executable, environment: peers[1]!.environment,
    ...(provider === 'claude' ? { sdkRevision: '0.3.305', configNamespace: 'custom-directory', settingSources: [] }
      : provider === 'codex' ? { protocolRevision: '0.162.0' } : { endpoint: endpoints.management }),
    timeoutMs: 15000, modelProbeTimeoutMs: 30000 }));
  const profileBytes = JSON.stringify(profile);
  await writeFile(fixture.profilePath, profileBytes, { mode: 0o600 }); fixture.pins.profileSha256 = digest(profileBytes);
  readTeamHostProfile(fixture.profilePath, fixture.pins.profileSha256);
  const descriptor = record(JSON.parse(await readFile(fixture.descriptorPath, 'utf8')));
  assert.ok(Array.isArray(descriptor.owners) && descriptor.owners.length === 1);
  const owner = record(descriptor.owners[0]); record(record(owner.profile).env).LEGACY_AGENT_HOST_PROFILE_SHA256 = fixture.pins.profileSha256;
  descriptor.management = profile.management.flatMap(row => [null, row.cwd].map(projectPath => ({ runtimeId: row.provider,
    owner: { ownerId: owner.ownerId, revision: owner.revision }, contextId: 'local', projectPath,
    profileId: row.profileId, configRevision: row.configRevision })));
  const descriptorBytes = JSON.stringify(descriptor);
  await writeFile(fixture.descriptorPath, descriptorBytes, { mode: 0o600 }); fixture.pins.descriptorSha256 = digest(descriptorBytes);
  fixture.appEnvironment.AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256 = fixture.pins.descriptorSha256;
  const lease = acquireProfileWriterLease(profile.owner.storageRoot);
  let uiSeed;
  try {
    lease.assertCurrent();
    const owner = createFilesystemTeamOwner({ root: profile.owner.storageRoot, binding: team.binding,
      members: team.members, grants: team.grants, savedSettings: team.savedSettings });
    const connection = owner.connect(profile.principalId), subject = 'TEST mixed collaboration sidebar seed', commandId = 'TEST-collaboration-seed';
    const receipt = connection.execute({ commandId, operation: 'task.create', payload: { subject } });
    assert.equal(receipt.phase, 'completed'); const tasks = connection.listTasks(); assert.equal(tasks.length, 1);
    uiSeed = { taskId: tasks[0]!.id, subject, commandId };
    await writeFile(join(fixture.root, 'ui-seed-receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600, flag: 'wx' });
  } finally { lease.release(); }
  return { ...fixture, uiSeed, emulatedRuntime: { provider: 'claude' as const, variant: 'collaboration' as const,
    sources, executable: selections[0]!.executable, peers: selections.flatMap(row => row.peers), versionSentinel,
    savedModel: 'sonnet', installer: undefined, observedPeerPids: [] as number[],
    commandPrefix: `${fixture.node} ${selections[0]!.executable.path} `, collaboration: { selections, endpoints, project } } };
}
export type DesktopEmulatedCollaborationFixture = Awaited<ReturnType<typeof prepareDesktopEmulatedCollaborationFixture>>;
export function isDesktopEmulatedCollaborationFixture(fixture: { emulatedRuntime: { variant?: string } }):
  fixture is DesktopEmulatedCollaborationFixture {
  return fixture.emulatedRuntime.variant === 'collaboration';
}

export async function readDesktopEmulatedCollaborationEffects(fixture: DesktopEmulatedCollaborationFixture) {
  const result: Row[] = [];
  for (const selection of fixture.emulatedRuntime.collaboration.selections) {
    let bytes: string;
    try { bytes = await readFile(join(selection.peers[0]!.root, 'effects.ndjson'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    assert.ok(Buffer.byteLength(bytes) <= 1024 * 1024);
    for (const line of bytes.trim().split('\n').filter(Boolean)) {
      const row = record(JSON.parse(line)); assert.equal(row.provider, selection.provider);
      assert.ok(row.role === 'runtime' || row.role === 'management'); assert.ok(Number.isSafeInteger(row.pid) && Number(row.pid) > 1);
      assert.notEqual(row.event, 'failure', 'a finite protocol refusal cannot qualify collaboration'); result.push(row);
    }
  }
  return result;
}
export async function verifyDesktopEmulatedCollaborationFixture(fixture: DesktopEmulatedCollaborationFixture) {
  const selected = fixture.emulatedRuntime;
  for (const pin of [...selected.sources, selected.collaboration.project, ...selected.collaboration.selections.map(row => row.executable)]) {
    assert.equal(await realpath(pin.path), pin.path); assert.equal(await fileDigest(pin.path), pin.sha256);
  }
  for (const path of selected.versionSentinel.versionPaths) assert.equal(await fileDigest(path), selected.versionSentinel.versionSha256);
  assert.equal(await fileDigest(fixture.descriptorPath), fixture.pins.descriptorSha256);
  const profile = readTeamHostProfile(fixture.profilePath, fixture.pins.profileSha256);
  assert.equal(profile.runtime?.members.length, 2); assert.equal(profile.runtime?.providerTemplates?.length, 3); assert.equal(profile.management?.length, 3);
  for (const row of [...profile.runtime!.members, ...profile.runtime!.providerTemplates!, ...profile.management!]) {
    const selection = selected.collaboration.selections.find(value => value.provider === row.provider); assert.ok(selection);
    assert.deepEqual(row.executable, selection.executable);
    assert.deepEqual(row.environment, selection.peers.find(value => value.role === row.environment.TEST_PEER_ROLE)?.environment);
  }
  return { provider: 'claude', providers: [...providers], sources: selected.sources,
    executables: selected.collaboration.selections.map(row => ({ provider: row.provider, ...row.executable })),
    protocolRevisions: { claude: 'sdk-0.3.305', codex: '0.162.0', opencode: '1.19.4' },
    runtimeConfigured: true, managementConfigured: true, vendorsAllowed: false, collaborationVariant: 'mixed-v1' };
}
export async function observeDesktopEmulatedCollaborationChildren(group: number, fixture: DesktopEmulatedCollaborationFixture,
  phase: 'before-first-team-read' | 'after-team-read') {
  assertOwnedCdpListener(group); await verifyDesktopEmulatedCollaborationFixture(fixture);
  const table = processTable(), hosts = table.filter(row => row.pgid === group && command(row.pid) === `${fixture.node} ${fixture.hostEntry}`);
  if (phase === 'before-first-team-read') assert.ok(hosts.length <= 1); else assert.equal(hosts.length, 1);
  const launches = (await readDesktopEmulatedCollaborationEffects(fixture)).filter(row => row.event === 'launch');
  for (const host of hosts) for (const child of table.filter(row => row.ppid === host.pid)) {
    assert.equal(child.pgid, child.pid);
    const selected = fixture.emulatedRuntime.collaboration.selections.filter(row => command(child.pid).startsWith(`${fixture.node} ${row.executable.path} `));
    assert.equal(selected.length, 1);
    assert.ok(launches.some(row => row.pid === child.pid && row.parentPid === host.pid && row.provider === selected[0]!.provider));
    if (!fixture.emulatedRuntime.observedPeerPids.includes(child.pid)) fixture.emulatedRuntime.observedPeerPids.push(child.pid);
  }
}
export async function observeDesktopEmulatedCollaborationCleanup(fixture: DesktopEmulatedCollaborationFixture) {
  const effects = await readDesktopEmulatedCollaborationEffects(fixture);
  const births = effects.filter(row => row.event === 'launch'); assert.ok(births.length > 0);
  const originalPeerPids = [...new Set([...fixture.emulatedRuntime.observedPeerPids, ...births.map(row => Number(row.pid))])];
  const remaining = processTable().filter(row => originalPeerPids.includes(row.pid));
  return { originalPeerPids, remaining, absent: remaining.length === 0, effects };
}
