import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireProfileWriterLease } from '../../packages/legacy-agent-host/dist/adapters/profile/ProfileWriterLease.js';
import { createFilesystemTeamOwner } from '../../packages/legacy-agent-host/dist/adapters/team/createFilesystemTeamOwner.js';
import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import { runtimeMemberProfileSchema } from '../../packages/legacy-agent-host/dist/composition/runtimeProfile.js';
import { digest, fileDigest, prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import { assertOwnedCdpListener, command, processTable } from './desktop-backend-observations.ts';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Row;
};
export const desktopRuntimePeerSources = [
  'tools/owned-process-broker/fixtures/providerPeer.mjs',
  'tools/owned-process-broker/fixtures/providerDesktopPeer.mjs',
] as const;

/** TEST executables implement a finite native protocol; the original Host and D remain unchanged. */
export async function prepareDesktopEmulatedRuntimeFixture(repo: string, pnpmEntry: string) {
  const provider = 'codex' as const;
  const fixture = await prepareDesktopBackendFixture(repo, { pnpmEntry, seedUiPreferences: true, creation: true });
  const sources = await Promise.all(desktopRuntimePeerSources.map(async source => {
    const path = join(repo, source); assert.equal(await realpath(path), path);
    return { path, sha256: await fileDigest(path) };
  }));
  const wrapper = `#!${fixture.node}\nimport assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {readFileSync,realpathSync} from 'node:fs';
for(const source of ${JSON.stringify(sources)}){assert.equal(realpathSync(source.path),source.path);assert.equal(createHash('sha256').update(readFileSync(source.path)).digest('hex'),source.sha256)}
await import(${JSON.stringify(pathToFileURL(sources[0]!.path).href)});
`;
  const path = join(fixture.root, 'bin/TEST-codex-peer.mjs');
  await writeFile(path, wrapper, { mode: 0o700, flag: 'wx' });
  const executable = { path, sha256: digest(wrapper) };
  const peerRoot = join(fixture.root, `TEST-peer-${provider}-scope`);
  for (const name of ['', 'home', 'tmp', 'config', 'data', 'cache']) await mkdir(join(peerRoot, name), { mode: 0o700 });
  const peers = await Promise.all((['runtime', 'management'] as const).map(async role => {
    const root = peerRoot;
    return { root, role, environment: {
      HOME: join(root, 'home'), CODEX_HOME: join(root, 'config'), TMPDIR: join(root, 'tmp'),
      XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'),
      PATH: `${dirname(fixture.node)}:/usr/bin:/bin`, SHELL: '/bin/sh',
      TEST_EMULATED_DESKTOP_PROVIDER: '1', TEST_PEER_SCENARIO: 'desktop-ui-v1', TEST_PEER_PROVIDER: provider,
      TEST_PEER_ROLE: role, TEST_DESKTOP_PEER_ROOT: root, TEST_PEER_EFFECTS: join(root, 'effects.ndjson'),
      TEST_PEER_HELPER_SHA256: sources[1]!.sha256,
    } };
  }));
  const runtime = peers.find(peer => peer.role === 'runtime')!, management = peers.find(peer => peer.role === 'management')!;
  const profile = JSON.parse(await readFile(fixture.profilePath, 'utf8')) as TeamHostProfile;
  assert.equal(profile.runtime, undefined); assert.equal(profile.management, undefined);
  const team = profile.teams[0]!;
  team.members[0]!.role = 'lead';
  team.members[0]!.delivery = { ...team.binding, runId: team.scope.runId, memberId: 'alice-id', generation: '1' };
  team.grants.push({ principalId: 'alice-session', memberName: 'alice', permissions: ['read', 'task.write', 'message.write'] });
  team.savedSettings = { cwd: join(fixture.root, 'workspace'), providerId: provider, model: 'TEST-model',
    prompt: '', skipPermissions: false, syncModelsWithLead: true };
  const member = runtimeMemberProfileSchema.parse({
    provider, protocolRevision: '0.162.0', teamId: team.scope.teamId, memberId: 'alice-id', principalId: 'alice-session',
    sessionId: 'TEST-emulated-codex-session', generation: 1, configRevision: 'TEST-emulated-codex-runtime',
    cwd: join(fixture.root, 'workspace'), model: 'TEST-model', accountBinding: 'TEST-no-vendor-account',
    executable, environment: runtime.environment, nativeOptions: { approvalPolicy: 'on-request', sandbox: 'read-only' },
    limits: { queuedInputs: 2, inputBytes: 65536, outputBytes: 1_000_000, outputEvents: 1500, pendingInteractions: 4, timeoutMs: 90_000 },
  });
  profile.runtime = { members: [member], providerTemplates: [structuredClone(member)] };
  profile.management = [{ provider, protocolRevision: '0.162.0', profileId: 'TEST-emulated-codex-management',
    configRevision: 'TEST-emulated-codex-management', accountBinding: member.accountBinding, cwd: member.cwd,
    executable, environment: management.environment, timeoutMs: 15000, modelProbeTimeoutMs: 30000 }];
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
    profileId: 'TEST-emulated-codex-management', configRevision: 'TEST-emulated-codex-management' }));
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
  return { ...fixture, uiSeed, emulatedRuntime: { provider, sources, executable, peers,
    observedPeerPids: [] as number[], commandPrefix: `${fixture.node} ${executable.path} ` } };
}

export async function readDesktopEmulatedRuntimeEffects(fixture: Awaited<ReturnType<typeof prepareDesktopEmulatedRuntimeFixture>>) {
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
  const selected = fixture.emulatedRuntime;
  for (const source of [...selected.sources, selected.executable]) {
    assert.equal(await realpath(source.path), source.path); assert.equal(await fileDigest(source.path), source.sha256);
  }
  assert.equal(await fileDigest(fixture.profilePath), fixture.pins.profileSha256);
  assert.equal(await fileDigest(fixture.descriptorPath), fixture.pins.descriptorSha256);
  const profile = readTeamHostProfile(fixture.profilePath, fixture.pins.profileSha256);
  assert.equal(profile.runtime?.members.length, 1); assert.equal(profile.runtime?.providerTemplates?.length, 1);
  assert.equal(profile.management?.length, 1);
  for (const row of [...profile.runtime!.members, ...profile.runtime!.providerTemplates!, ...profile.management!]) {
    assert.equal(row.provider, selected.provider); assert.deepEqual(row.executable, selected.executable);
    const peer = selected.peers.find(peer => peer.role === row.environment.TEST_PEER_ROLE);
    assert.ok(peer); assert.deepEqual(row.environment, peer.environment);
  }
  return { executable: selected.executable, sources: selected.sources, provider: selected.provider,
    runtimeConfigured: true, managementConfigured: true, vendorsAllowed: false };
}

/** Only direct children of the original Host, with immutable TEST entrypoints and original launch rows. */
export async function observeDesktopEmulatedRuntimeChildren(group: number,
  fixture: Awaited<ReturnType<typeof prepareDesktopEmulatedRuntimeFixture>>, phase: 'before-first-team-read' | 'after-team-read') {
  assertOwnedCdpListener(group); await verifyDesktopEmulatedRuntimeFixture(fixture);
  const table = processTable(), hosts = table.filter(row => row.pgid === group && command(row.pid) === `${fixture.node} ${fixture.hostEntry}`);
  if (phase === 'before-first-team-read') assert.ok(hosts.length <= 1); else assert.equal(hosts.length, 1);
  const launches = (await readDesktopEmulatedRuntimeEffects(fixture)).filter(row => row.event === 'launch');
  for (const host of hosts) for (const child of table.filter(row => row.ppid === host.pid)) {
    assert.equal(child.pgid, child.pid);
    assert.ok(command(child.pid).startsWith(fixture.emulatedRuntime.commandPrefix), 'Only the original pinned TEST executable');
    assert.ok(launches.some(row => row.pid === child.pid && row.parentPid === host.pid), 'Original peer birth under this captured Host');
    if (!fixture.emulatedRuntime.observedPeerPids.includes(child.pid)) fixture.emulatedRuntime.observedPeerPids.push(child.pid);
  }
}

/** PIDs are absence observations only; original Host custody performs all stopping. */
export async function observeDesktopEmulatedRuntimeCleanup(fixture: Awaited<ReturnType<typeof prepareDesktopEmulatedRuntimeFixture>>) {
  const effects = await readDesktopEmulatedRuntimeEffects(fixture);
  const launches = effects.filter(row => row.event === 'launch').map(row => Number(row.pid));
  assert.ok(launches.length > 0);
  const originalPeerPids = [...new Set([...launches, ...fixture.emulatedRuntime.observedPeerPids])];
  const remaining = processTable().filter(row => originalPeerPids.includes(row.pid));
  return { originalPeerPids, remaining, absent: remaining.length === 0, effects };
}
