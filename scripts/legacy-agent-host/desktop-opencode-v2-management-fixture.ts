import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import { verifyOpenCodeV2EmbeddedGraph } from '../../packages/legacy-agent-host/dist/adapters/providers/OpenCodeV2EmbeddedGraph.js';
import { digest, fileDigest, prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import { desktopOpenCodeV2ManagementProfile, prepareDesktopOpenCodeV2Recipe } from './desktop-opencode-v2-fixture.ts';
import { reserveMixedOpenCodeEndpoint } from './desktop-mixed-native-fixture.ts';
import { desktopV2ProviderId } from './desktop-opencode-v2-management-model.ts';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';
import type { DesktopV2ManagementModel } from './desktop-opencode-v2-management-model.ts';

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
};
export function assertDesktopV2ManagementEnvironment() {
  assert.equal(process.env.LEGACY_DESKTOP_PROOF_MODE, 'opencode-v2-management-ui');
  assert.equal(process.env.LEGACY_DESKTOP_EMULATED_ONLY, undefined, 'actual pinned OpenCode engine is a distinct qualification scope');
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  for (const key of ['LEGACY_DESKTOP_CODEX_PATH', 'LEGACY_DESKTOP_CLAUDE_PATH', 'LEGACY_DESKTOP_OPENCODE_PATH',
    'LEGACY_DESKTOP_MIXED_UI', 'LEGACY_DESKTOP_PACKED_CAPTURE_PATH', 'LEGACY_DESKTOP_DIAGNOSTIC_HOST_ENTRY'])
    assert.equal(process.env[key], undefined, 'this native UI scope selects only original V2 management');
  assert.ok(process.env.OPENCODE_V2_EMBEDDED_BUN && process.env.OPENCODE_V2_EMBEDDED_GRAPH);
  assert.match(process.env.OPENCODE_V2_EMBEDDED_BUN_SHA256 ?? '', /^[a-f0-9]{64}$/u);
  assert.match(process.env.OPENCODE_V2_EMBEDDED_MANIFEST_SHA256 ?? '', /^[a-f0-9]{64}$/u);
}

/** A single management-only native V2 recipe. Every legacy agent name remains a finite sentinel. */
export async function prepareDesktopV2ManagementFixture(repo: string, pnpmEntry: string, model: DesktopV2ManagementModel) {
  assertDesktopV2ManagementEnvironment();
  const fixture = await prepareDesktopBackendFixture(repo, { pnpmEntry, seedUiTask: true, seedUiPreferences: true });
  const bunPath = await realpath(process.env.OPENCODE_V2_EMBEDDED_BUN!);
  const engineDirectory = await realpath(process.env.OPENCODE_V2_EMBEDDED_GRAPH!);
  assert.equal(bunPath, process.env.OPENCODE_V2_EMBEDDED_BUN);
  assert.equal(engineDirectory, process.env.OPENCODE_V2_EMBEDDED_GRAPH);
  const profile = JSON.parse(await readFile(fixture.profilePath, 'utf8')) as TeamHostProfile;
  assert.equal(profile.runtime, undefined); assert.equal(profile.management, undefined);
  const selection = { bunPath, bunSha256: await fileDigest(bunPath), engineDirectory, modelUrl: model.url,
    settingsProjectModel: true, endpoint: await reserveMixedOpenCodeEndpoint(), managementEndpoint: await reserveMixedOpenCodeEndpoint() };
  assert.equal(selection.bunSha256, process.env.OPENCODE_V2_EMBEDDED_BUN_SHA256);
  const member = await prepareDesktopOpenCodeV2Recipe({ repo, root: fixture.root, node: fixture.node, selection,
    identity: { teamId: 'TEST-management-only', memberId: 'TEST-unallocated', principalId: profile.principalId,
      sessionId: 'TEST-no-runtime-session', generation: 1, configRevision: 'TEST-v2-management' } });
  assert.ok(member.embedded);
  // The initial recipe has no configured key. Only the original Connect form may publish one.
  const provider = record(member.embedded.providerConfiguration);
  member.embedded.providerConfiguration = { ...provider, settings: { baseURL: model.url + '/v1' } };
  assert.equal(member.nativeOptions.providerId, desktopV2ProviderId);
  assert.equal(member.embedded.manifestSha256, process.env.OPENCODE_V2_EMBEDDED_MANIFEST_SHA256);
  const management = desktopOpenCodeV2ManagementProfile(member, selection.managementEndpoint, 'TEST-v2-settings-management');
  profile.management = [management];
  for (const name of ['workspace', 'workspace-other']) {
    const cwd = join(fixture.root, name); await mkdir(cwd, { recursive: true, mode: 0o700 });
    const discovery = join(fixture.root, 'claude/projects', cwd.replace(/[/\\]/g, '-'));
    await mkdir(discovery, { recursive: true, mode: 0o700 });
    await writeFile(join(discovery, 'TEST-project-discovery-only.jsonl'),
      JSON.stringify({ type: 'TEST-project-discovery-only', cwd }) + '\n', { mode: 0o600, flag: 'wx' });
    await mkdir(join(fixture.root, 'preferences', name), { recursive: true, mode: 0o700 });
  }
  await mkdir(join(fixture.root, 'preferences/global'), { recursive: true, mode: 0o700 });
  const profileBytes = JSON.stringify(profile); await writeFile(fixture.profilePath, profileBytes, { mode: 0o600 });
  fixture.pins.profileSha256 = digest(profileBytes);
  readTeamHostProfile(fixture.profilePath, fixture.pins.profileSha256);
  const descriptor = record(JSON.parse(await readFile(fixture.descriptorPath, 'utf8')));
  assert.ok(Array.isArray(descriptor.owners) && descriptor.owners.length === 1);
  const owner = record(descriptor.owners[0]);
  record(record(owner.profile).env).LEGACY_AGENT_HOST_PROFILE_SHA256 = fixture.pins.profileSha256;
  descriptor.management = [null, join(fixture.root, 'workspace'), join(fixture.root, 'workspace-other')].map(projectPath => ({
    runtimeId: 'opencode', owner: { ownerId: owner.ownerId, revision: owner.revision }, contextId: 'local', projectPath,
    profileId: management.profileId, configRevision: management.configRevision,
    preferences: { globalRoot: join(fixture.root, 'preferences/global'),
      projectRoot: projectPath === null ? null : join(fixture.root, 'preferences', basename(projectPath)) },
  }));
  const descriptorBytes = JSON.stringify(descriptor); await writeFile(fixture.descriptorPath, descriptorBytes, { mode: 0o600 });
  fixture.pins.descriptorSha256 = digest(descriptorBytes);
  fixture.appEnvironment.AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256 = fixture.pins.descriptorSha256;
  return { ...fixture, v2Management: { selection, management,
    childEntry: await realpath(join(repo, 'packages/legacy-agent-host/dist/adapters/providers/OpenCodeV2EmbeddedChild.js')),
    authPath: join(member.environment.XDG_DATA_HOME!, 'opencode/auth.json') } };
}
export type DesktopV2ManagementFixture = Awaited<ReturnType<typeof prepareDesktopV2ManagementFixture>>;

export async function verifyDesktopV2ManagementFixture(fixture: DesktopV2ManagementFixture) {
  const selected = fixture.v2Management;
  assert.equal(await fileDigest(selected.selection.bunPath), selected.selection.bunSha256);
  assert.equal(await fileDigest(fixture.profilePath), fixture.pins.profileSha256);
  assert.equal(await fileDigest(fixture.descriptorPath), fixture.pins.descriptorSha256);
  const profile = readTeamHostProfile(fixture.profilePath, fixture.pins.profileSha256);
  assert.equal(profile.runtime, undefined); assert.deepEqual(profile.management, [selected.management]);
  assert.ok(selected.management.embedded); await verifyOpenCodeV2EmbeddedGraph(selected.management.embedded);
  assert.deepEqual(record(selected.management.embedded.providerConfiguration).settings, { baseURL: selected.selection.modelUrl + '/v1' });
  return { generation: 'v2', version: '2.1.4', bunSha256: selected.selection.bunSha256,
    manifestSha256: selected.management.embedded.manifestSha256, profileSha256: fixture.pins.profileSha256,
    descriptorSha256: fixture.pins.descriptorSha256, runtimeConfigured: false,
    managementConfigured: true, codexOrClaudeExecutable: false };
}
