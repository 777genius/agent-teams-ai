import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { acquireProfileWriterLease } from '../../packages/legacy-agent-host/dist/adapters/profile/ProfileWriterLease.js';
import { createFilesystemTeamOwner } from '../../packages/legacy-agent-host/dist/adapters/team/createFilesystemTeamOwner.js';
import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import { runtimeMemberProfileSchema } from '../../packages/legacy-agent-host/dist/composition/runtimeProfile.js';
import { providerManagementProfileSchema } from '../../packages/legacy-agent-host/dist/management/profile.js';
import { desktopNodeScriptHeader, digest, fileDigest, prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import { assertOwnedCdpListener, processTable } from './desktop-backend-observations.ts';
import { prepareDesktopOpenCodeVersionSentinel } from './desktop-emulated-management-fixture.ts';
import { reserveMixedOpenCodeEndpoint } from './desktop-mixed-native-fixture.ts';
import { seedDesktopLegacySchedule } from './desktop-schedule-fixture.ts';
import { prepareDesktopEmulatedCodexInstaller, readDesktopEmulatedCodexInstallation, verifyDesktopEmulatedCodexInstaller } from './desktop-emulated-codex-installer-fixture.ts';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';

import {
  prepareDesktopEmulatedCollaborationFixture, isDesktopEmulatedCollaborationFixture,
  readDesktopEmulatedCollaborationEffects, verifyDesktopEmulatedCollaborationFixture,
  observeDesktopEmulatedCollaborationChildren, observeDesktopEmulatedCollaborationCleanup,
} from './desktop-emulated-collaboration-fixture.ts';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Row;
};
export const desktopRuntimePeerSources = [
  'tools/owned-process-broker/fixtures/providerPeer.mjs',
  'tools/owned-process-broker/fixtures/providerDesktopPeer.mjs',
] as const;

/** TEST executables implement a finite native protocol; the original Host and D remain unchanged. */
export async function prepareDesktopEmulatedRuntimeFixture(repo: string, pnpmEntry: string, provider: 'codex' | 'claude' | 'opencode' = 'codex', variant?: 'selection' | 'installer' | 'lifecycle' | 'collaboration', candidateRuntime?: Parameters<typeof prepareDesktopBackendFixture>[1]['candidateRuntime']) {
  if (candidateRuntime) assert.ok(provider === 'claude' && variant === 'lifecycle', 'One captured packaged Launch/Stop lifecycle');
  if (variant === 'collaboration') {
    assert.equal(provider, 'claude'); return prepareDesktopEmulatedCollaborationFixture(repo, pnpmEntry);
  }
  assert.ok(variant === undefined || (variant === 'selection' || variant === 'installer') && provider === 'codex' || variant === 'lifecycle' && provider === 'claude');
  if (variant === 'installer') {
    assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  }
  const fixture = await prepareDesktopBackendFixture(repo, { pnpmEntry, seedUiPreferences: true, creation: true, ...(candidateRuntime ? { candidateRuntime } : {}) });
  const selectedSources = provider === 'claude' ? ['tools/owned-process-broker/fixtures/claudeProviderPeer.mjs'] :
    [...desktopRuntimePeerSources, ...(provider === 'opencode'
      ? ['packages/legacy-agent-host/dist/adapters/providers/OpenCodeMcpPolicyPlugin.js'] : [])];
  const sources = await Promise.all(selectedSources.map(async source => {
    const path = join(repo, source); assert.equal(await realpath(path), path);
    return { path, sha256: await fileDigest(path) };
  }));
  const installer = variant === 'installer' ? await prepareDesktopEmulatedCodexInstaller(fixture, repo, sources) : undefined;
  const codexProtocolRevision = '0.162.0';
  const wrapper = `${desktopNodeScriptHeader(fixture.node)}import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {readFileSync,realpathSync} from 'node:fs';
for(const source of ${JSON.stringify(sources)}){assert.equal(realpathSync(source.path),source.path);assert.equal(createHash('sha256').update(readFileSync(source.path)).digest('hex'),source.sha256)}
${provider === 'codex' ? `if(process.argv.length===3&&process.argv[2]==='--version')process.stdout.write('codex-cli ${codexProtocolRevision}\\n');else ` : ''}await import(${JSON.stringify(pathToFileURL(sources[0]!.path).href)});
`;
  const path = join(fixture.root, provider === 'claude' ? 'bin/TEST-claude-peer' : `bin/TEST-${provider}-peer.mjs`);
  if (!installer) await writeFile(path, wrapper, { mode: 0o700, flag: 'wx' });
  const executable = installer?.executable ?? { path, sha256: digest(wrapper) };
  if (provider === 'codex' && !installer) fixture.appEnvironment.CODEX_CLI_PATH = executable.path;
  const peerRoot = join(fixture.root, `TEST-peer-${provider}-scope`);
  for (const name of ['', 'home', 'tmp', 'config', 'data', 'cache']) await mkdir(join(peerRoot, name), { mode: 0o700 });
  const peers = await Promise.all((['runtime', 'management'] as const).map(async role => {
    const root = peerRoot;
    const environment: Record<string, string> = {
      HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'),
      ...(provider === 'claude' ? { CLAUDE_CONFIG_DIR: join(root, 'config') } : provider === 'codex' ? { CODEX_HOME: join(root, 'config') } : {}),
      XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'),
      PATH: `${dirname(fixture.node)}:/usr/bin:/bin`, SHELL: '/bin/sh',
      TEST_EMULATED_DESKTOP_PROVIDER: '1', TEST_PEER_SCENARIO: 'desktop-ui-v1', TEST_PEER_PROVIDER: provider,
      TEST_PEER_ROLE: role, TEST_DESKTOP_PEER_ROOT: root, TEST_PEER_EFFECTS: join(root, 'effects.ndjson'),
      TEST_DESKTOP_PEER_WORKSPACE: join(fixture.root, 'workspace'),
      ...(variant === 'selection' || variant === 'installer' ? { TEST_DESKTOP_SELECTION: 'two-models-v1' } : {}),
      ...(provider !== 'claude' ? { TEST_PEER_HELPER_SHA256: sources[1]!.sha256 } : {}),
      ...(provider === 'opencode' ? { TEST_PEER_MCP_POLICY_SHA256: sources[2]!.sha256,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, share: 'disabled',
        model: 'test-provider/TEST-model', small_model: 'test-provider/TEST-model', provider: { 'test-provider': {
          npm: '@ai-sdk/openai-compatible', name: 'TEST provider', options: {
            baseURL: 'http://127.0.0.1:19999/TEST-no-network', apiKey: 'TEST-LOCALHOST-ONLY' },
          models: { 'TEST-model': { name: 'TEST model', limit: { context: 4096, output: 1024 },
            variants: { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } } } } } },
        agent: { build: { mode: 'primary' } }, compaction: { auto: false } }),
        OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_TELEMETRY: '1', OPENCODE_DISABLE_SHARE: '1' } : {}),
    };
    return { root, role, environment };
  }));
  const runtime = peers.find(peer => peer.role === 'runtime')!, management = peers.find(peer => peer.role === 'management')!;
  let project: { path: string; sha256: string } | undefined;
  if (provider === 'opencode') {
    const config = record(JSON.parse(runtime.environment.OPENCODE_CONFIG_CONTENT!));
    const path = join(fixture.root, 'workspace/opencode.json'), bytes = JSON.stringify({ provider: config.provider });
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
    project = { path, sha256: digest(bytes) };
  }
  const versionSentinel = provider === 'opencode' ? await prepareDesktopOpenCodeVersionSentinel(fixture) : undefined;
  const endpoints = provider === 'opencode' ? { runtime: await reserveMixedOpenCodeEndpoint(), management: await reserveMixedOpenCodeEndpoint() } : undefined;
  if (endpoints) assert.notEqual(endpoints.runtime, endpoints.management);
  const profile = JSON.parse(await readFile(fixture.profilePath, 'utf8')) as TeamHostProfile;
  assert.equal(profile.runtime, undefined); assert.equal(profile.management, undefined);
  const team = profile.teams[0]!;
  team.members[0]!.role = 'lead';
  team.members[0]!.delivery = { ...team.binding, runId: team.scope.runId, memberId: 'alice-id', generation: '1' };
  team.grants.push({ principalId: 'alice-session', memberName: 'alice', permissions: ['read', 'task.write', 'message.write'] });
  const model = provider === 'claude' ? 'TEST-claude-sonnet' : 'TEST-model';
  const savedModel = provider === 'opencode' ? 'test-provider/' + model : model;
  team.savedSettings = { cwd: join(fixture.root, 'workspace'), providerId: provider === 'claude' ? 'anthropic' : provider, model: savedModel,
    ...(provider === 'claude' ? { effort: 'low' as const, fastMode: 'off' as const } : {}),
    prompt: '', skipPermissions: false, syncModelsWithLead: true };
  const member = runtimeMemberProfileSchema.parse({
    provider, teamId: team.scope.teamId, memberId: 'alice-id', principalId: 'alice-session',
    sessionId: `TEST-emulated-${provider}-session`, generation: 1, configRevision: `TEST-emulated-${provider}-runtime`,
    cwd: join(fixture.root, 'workspace'), model, accountBinding: 'TEST-no-vendor-account', executable, environment: runtime.environment,
    ...(provider === 'claude' ? { configNamespace: 'custom-directory', nativeTools: ['Read', 'Write', 'AskUserQuestion'], autoAllowedTools: [],
      nativeOptions: { permissionMode: 'default', settingSources: [], effort: 'low', fastMode: false } }
      : provider === 'codex' ? { protocolRevision: codexProtocolRevision, nativeOptions: { approvalPolicy: 'on-request', sandbox: 'read-only' } }
      : { protocolRevision: '1.19.4', endpoint: endpoints!.runtime, nativeOptions: { providerId: 'test-provider', agent: 'build', toolApprovalMode: 'manual' } }),
    limits: { queuedInputs: 2, inputBytes: 65536, outputBytes: 1_000_000, outputEvents: 1500, pendingInteractions: 4, timeoutMs: 90_000 },
  });
  profile.runtime = { members: [member], providerTemplates: [structuredClone(member)] };
  profile.management = [providerManagementProfileSchema.parse({ provider, profileId: `TEST-emulated-${provider}-management`,
    configRevision: `TEST-emulated-${provider}-management`, accountBinding: member.accountBinding, cwd: member.cwd,
    ...(provider === 'claude' ? { sdkRevision: '0.3.305', configNamespace: 'custom-directory', settingSources: [] }
      : provider === 'codex' ? { protocolRevision: codexProtocolRevision } : { endpoint: endpoints!.management }),
    executable, environment: management.environment, timeoutMs: 15000, modelProbeTimeoutMs: 30000 })];
  const profileBytes = JSON.stringify(profile);
  await writeFile(fixture.profilePath, profileBytes, { mode: 0o600 });
  fixture.pins.profileSha256 = digest(profileBytes);
  readTeamHostProfile(fixture.profilePath, fixture.pins.profileSha256);
  const descriptor = record(JSON.parse(await readFile(fixture.descriptorPath, 'utf8')));
  assert.ok(Array.isArray(descriptor.owners) && descriptor.owners.length === 1);
  const owner = record(descriptor.owners[0]);
  record(record(owner.profile).env).LEGACY_AGENT_HOST_PROFILE_SHA256 = fixture.pins.profileSha256;
  descriptor.management = [null, member.cwd].map(projectPath => ({ runtimeId: provider,
    owner: { ownerId: owner.ownerId, revision: owner.revision }, contextId: 'local', projectPath,
    profileId: `TEST-emulated-${provider}-management`, configRevision: `TEST-emulated-${provider}-management` }));
  const descriptorBytes = JSON.stringify(descriptor);
  await writeFile(fixture.descriptorPath, descriptorBytes, { mode: 0o600 });
  fixture.pins.descriptorSha256 = digest(descriptorBytes);
  fixture.appEnvironment.AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256 = fixture.pins.descriptorSha256;
  const lease = acquireProfileWriterLease(profile.owner.storageRoot);
  let uiSeed;
  try {
    lease.assertCurrent();
    const owner = createFilesystemTeamOwner({ root: profile.owner.storageRoot, binding: team.binding,
      members: team.members, grants: team.grants, savedSettings: team.savedSettings });
    const connection = owner.connect(profile.principalId);
    const subject = 'TEST persisted Host sidebar seed', commandId = 'TEST-ui-offline-seed';
    const receipt = connection.execute({ commandId, operation: 'task.create', payload: { subject } });
    assert.equal(receipt.phase, 'completed');
    const tasks = connection.listTasks(); assert.equal(tasks.length, 1);
    uiSeed = { taskId: tasks[0]!.id, subject, commandId };
    await writeFile(join(fixture.root, 'ui-seed-receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600, flag: 'wx' });
  } finally { lease.release(); }
  if (provider === 'claude') await seedDesktopLegacySchedule(fixture, { model, prompt: 'TEST_UI_STANDALONE_DONE' });
  return { ...fixture, uiSeed, emulatedRuntime: { provider, sources, executable, peers, versionSentinel, project, savedModel, variant, installer,
    observedPeerPids: [] as number[], commandPrefix: `${fixture.node} ${executable.path} ` } };
}

export async function readDesktopEmulatedRuntimeEffects(fixture: Awaited<ReturnType<typeof prepareDesktopEmulatedRuntimeFixture>>) {
  if (isDesktopEmulatedCollaborationFixture(fixture)) return readDesktopEmulatedCollaborationEffects(fixture);
  const rows: Row[] = [];
  for (const root of new Set(fixture.emulatedRuntime.peers.map(peer => peer.root))) {
    let text: string;
    try { text = await readFile(join(root, 'effects.ndjson'), 'utf8'); }
    catch (error) { if (record(error).code === 'ENOENT') continue; throw error; }
    assert.ok(Buffer.byteLength(text) <= 1024 * 1024, 'Bounded original TEST peer journal');
    for (const line of text.trim().split('\n').filter(Boolean)) {
      const row = record(JSON.parse(line));
      assert.equal(row.provider, fixture.emulatedRuntime.provider);
      assert.ok(row.role === 'management' || row.role === 'runtime');
      assert.ok(Number.isSafeInteger(row.pid) && Number(row.pid) > 1); rows.push(row);
    }
  }
  assert.equal(rows.some(row => row.event === 'failure'), false, 'TEST protocol refusal cannot become a passing UI proof');
  return rows;
}

export async function verifyDesktopEmulatedRuntimeFixture(fixture: Awaited<ReturnType<typeof prepareDesktopEmulatedRuntimeFixture>>) {
  if (isDesktopEmulatedCollaborationFixture(fixture)) return verifyDesktopEmulatedCollaborationFixture(fixture);
  const selected = fixture.emulatedRuntime;
  for (const source of [...selected.sources, selected.executable]) {
    assert.equal(await realpath(source.path), source.path); assert.equal(await fileDigest(source.path), source.sha256);
  }
  if (selected.versionSentinel) for (const path of selected.versionSentinel.versionPaths)
    assert.equal(await fileDigest(path), selected.versionSentinel.versionSha256);
  if (selected.project) {
    assert.equal(await realpath(selected.project.path), selected.project.path);
    assert.equal(await fileDigest(selected.project.path), selected.project.sha256);
  }
  assert.equal(await fileDigest(fixture.profilePath), fixture.pins.profileSha256);
  assert.equal(await fileDigest(fixture.descriptorPath), fixture.pins.descriptorSha256);
  const profile = readTeamHostProfile(fixture.profilePath, fixture.pins.profileSha256);
  assert.equal(profile.runtime?.providerTemplates?.length, 1);
  const template = profile.runtime!.providerTemplates![0]!;
  const finiteImport = template.environment.TEST_DESKTOP_IMPORT_LIFECYCLE === 'current-solo-v1';
  assert.equal(finiteImport, process.env.LEGACY_DESKTOP_PROOF_MODE === 'emulated-import-lifecycle-ui');
  if (finiteImport) {
    assert.equal(process.env.LEGACY_DESKTOP_EMULATED_ONLY, '1');
    assert.equal(selected.provider, 'claude'); assert.equal(selected.variant, undefined);
    assert.deepEqual(profile.runtime?.members, []);
    assert.deepEqual(selected.peers.map(peer => [peer.role, peer.environment.TEST_DESKTOP_IMPORT_LIFECYCLE]),
      [['runtime', 'current-solo-v1'], ['management', 'current-solo-v1']]);
    assert.deepEqual(selected.sources.map(source => source.path),
      [join(import.meta.dirname, '../../tools/owned-process-broker/fixtures/claudeProviderPeer.mjs')]);
    assert.equal(selected.executable.path, join(fixture.root, 'bin/TEST-claude-peer'));
    const descriptor = record(JSON.parse(await readFile(fixture.descriptorPath, 'utf8')));
    assert.deepEqual(descriptor.creation, {
      owner: { ownerId: profile.owner.ownerId, revision: profile.owner.revision },
      contextIds: ['local'], importAuthority: { principalId: profile.principalId },
    });
  } else assert.equal(profile.runtime?.members.length, 1);
  assert.equal(profile.management?.length, 1);
  for (const row of [...profile.runtime!.members, ...profile.runtime!.providerTemplates!, ...profile.management!]) {
    assert.equal(row.provider, selected.provider); assert.deepEqual(row.executable, selected.executable);
    const peer = selected.peers.find(peer => peer.role === row.environment.TEST_PEER_ROLE);
    assert.ok(peer); assert.deepEqual(row.environment, peer.environment);
  }
  const member = finiteImport ? profile.runtime!.providerTemplates![0]! : profile.runtime!.members[0]!;
  return { executable: selected.executable, sources: selected.sources, provider: selected.provider,
    ...(selected.installer ? { installer: await verifyDesktopEmulatedCodexInstaller(selected.installer) } : {}),
    ...(selected.variant === 'selection' || selected.variant === 'installer' ? { selectionVariant: 'two-models-v1' } : {}),
    ...(selected.variant === 'lifecycle' ? { lifecycleVariant: 'cold-resume-active-quit-v1' } : {}),
    protocolRevision: member.provider === 'claude' ? 'sdk-0.3.305' : member.protocolRevision,
    ...(selected.versionSentinel ? { versionSentinelSha256: selected.versionSentinel.versionSha256 } : {}),
    ...(selected.project ? { project: selected.project, localReadinessScope: 'declared-TEST-key-finite-peer' } : {}),
    runtimeConfigured: true, managementConfigured: true, vendorsAllowed: false };
}

/** Only direct children of the original Host, with immutable TEST entrypoints and original launch rows. */
export async function observeDesktopEmulatedRuntimeChildren(group: number,
  fixture: Awaited<ReturnType<typeof prepareDesktopEmulatedRuntimeFixture>>, phase: 'before-first-team-read' | 'after-team-read') {
  if (isDesktopEmulatedCollaborationFixture(fixture)) return observeDesktopEmulatedCollaborationChildren(group, fixture, phase);
  assertOwnedCdpListener(group); await verifyDesktopEmulatedRuntimeFixture(fixture);
  const deadline = performance.now() + 3000;
  // One observation budget, including the original census; these facts never authorize signals.
  const census = () => {
    const remaining = Math.floor(deadline - performance.now());
    assert.ok(remaining > 0, 'Original peer observation deadline');
    const output = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,ppid=,pgid=,lstart=,command='], {
      encoding: 'utf8', timeout: remaining, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', LC_ALL: process.platform === 'linux' ? 'C.UTF-8' : 'en_US.UTF-8' },
    });
    const lines = output.trim().split('\n'); assert.ok(lines.length <= 20_000);
    const rows = lines.map(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S{3}\s+\S{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/u.exec(line);
      assert.ok(match, 'Original census includes peer birth and argv');
      const pid = Number(match[1]), ppid = Number(match[2]), pgid = Number(match[3]);
      assert.ok(Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(ppid) && ppid >= 0 && Number.isSafeInteger(pgid) && pgid >= 0);
      return { pid, ppid, pgid, birth: match[4]!, command: match[5]!.trim() };
    });
    assert.equal(new Set(rows.map(row => row.pid)).size, rows.length, 'Unambiguous original census');
    assert.ok(performance.now() < deadline, 'Original peer census exceeded its deadline');
    return rows;
  };
  const table = census(), hosts = table.filter(row => row.pgid === group && row.command === `${fixture.node} ${fixture.hostEntry}`);
  if (phase === 'before-first-team-read') assert.ok(hosts.length <= 1); else assert.equal(hosts.length, 1);
  await readDesktopEmulatedRuntimeEffects(fixture);
  const installed = fixture.emulatedRuntime.installer ? await readDesktopEmulatedCodexInstallation(fixture.emulatedRuntime.installer) : undefined;
  const prefixes = [fixture.emulatedRuntime.commandPrefix,
    ...(installed ? [`${fixture.node} ${installed.executable.path} `] : [])];
  for (const host of hosts) for (const child of table.filter(row => row.ppid === host.pid)) {
    assert.equal(child.pgid, child.pid);
    assert.ok(prefixes.some(prefix => child.command.startsWith(prefix)), 'Only an exact pinned TEST executable from the original seed or stock installation');
    let absent = false;
    for (;;) {
      assert.ok(performance.now() < deadline, 'Original peer observation deadline');
      const launches: Row[] = (await readDesktopEmulatedRuntimeEffects(fixture)).filter(row => row.event === 'launch' && row.pid === child.pid);
      assert.ok(performance.now() < deadline, 'Original peer launch read exceeded its deadline');
      assert.ok(launches.length <= 1, 'One original peer launch; PID reuse remains ambiguous');
      if (launches.length) assert.equal(launches[0]!.parentPid, host.pid, 'Original peer parent');
      const current = census();
      assert.deepEqual(current.find(row => row.pid === host.pid), host, 'Original Host birth and argv remain current');
      const peer = current.find(row => row.pid === child.pid);
      if (peer) {
        assert.equal(absent, false, 'An absent original peer PID must not reappear');
        assert.deepEqual(peer, child, 'Original peer birth, parent, group and argv remain current');
      } else absent = true;
      if (launches.length) break;
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(25, Math.max(0, deadline - performance.now()))));
    }
    if (!fixture.emulatedRuntime.observedPeerPids.includes(child.pid)) fixture.emulatedRuntime.observedPeerPids.push(child.pid);
  }
  assert.ok(performance.now() < deadline, 'Original peer observation deadline');
}

/** PIDs are absence observations only; original Host custody performs all stopping. */
export async function observeDesktopEmulatedRuntimeCleanup(fixture: Awaited<ReturnType<typeof prepareDesktopEmulatedRuntimeFixture>>) {
  if (isDesktopEmulatedCollaborationFixture(fixture)) return observeDesktopEmulatedCollaborationCleanup(fixture);
  const effects = await readDesktopEmulatedRuntimeEffects(fixture);
  const launches = effects.filter(row => row.event === 'launch').map(row => Number(row.pid));
  assert.ok(launches.length > 0);
  const originalPeerPids = [...new Set([...launches, ...fixture.emulatedRuntime.observedPeerPids])];
  const remaining = processTable().filter(row => originalPeerPids.includes(row.pid));
  return { originalPeerPids, remaining, absent: remaining.length === 0, effects };
}
