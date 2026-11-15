import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import { desktopNodeScriptHeader, digest, fileDigest } from './desktop-backend-fixture.ts';
import { prepareDesktopEmulatedRuntimeFixture } from './desktop-emulated-runtime-fixture.ts';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';

export type DesktopEmulatedClaudeSettingsFixture = Awaited<ReturnType<typeof prepareDesktopEmulatedRuntimeFixture>>;

/** Replace only this fresh TEST fixture's captured executable before any Host or UI starts. */
export async function prepareDesktopEmulatedClaudeSettingsFixture(
  repo: string,
  pnpmEntry: string,
  kind: 'extensions' | 'saved-import',
) {
  const fixture = await prepareDesktopEmulatedRuntimeFixture(repo, pnpmEntry, 'claude');
  const relativeSources = kind === 'extensions'
    ? ['tools/owned-process-broker/fixtures/claudeExtensionsPeer.mjs',
      'tools/owned-process-broker/fixtures/claudeProviderPeer.mjs']
    : ['tools/owned-process-broker/fixtures/claudeSavedImportPeer.mjs'];
  const sources = await Promise.all(relativeSources.map(async relative => {
    const path = join(repo, relative);
    assert.equal(await realpath(path), path);
    return { path, sha256: await fileDigest(path) };
  }));
  const wrapper = `${desktopNodeScriptHeader(fixture.node)}import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';import {readFileSync,realpathSync} from 'node:fs';
assert.equal(process.env.TEST_DESKTOP_SETTINGS,${JSON.stringify(kind)});
assert.equal(process.env.TEST_PEER_ROLE,'management');
for(const source of ${JSON.stringify(sources)}){assert.equal(realpathSync(source.path),source.path);assert.equal(createHash('sha256').update(readFileSync(source.path)).digest('hex'),source.sha256)}
await import(${kind === 'extensions'
    ? `['plugin','mcp','auth'].includes(process.argv[2])?${JSON.stringify(pathToFileURL(sources[0]!.path).href)}:${JSON.stringify(pathToFileURL(sources[1]!.path).href)}`
    : JSON.stringify(pathToFileURL(sources[0]!.path).href)});
`;
  const executable = { path: join(fixture.root, `bin/TEST-claude-${kind}-peer`), sha256: digest(wrapper) };
  await writeFile(executable.path, wrapper, { mode: 0o700, flag: 'wx' });
  for (const peer of fixture.emulatedRuntime.peers) peer.environment.TEST_DESKTOP_SETTINGS = kind;
  const profile = readTeamHostProfile(fixture.profilePath, fixture.pins.profileSha256);
  for (const selected of [...profile.runtime!.members, ...profile.runtime!.providerTemplates!, ...profile.management!]) {
    assert.equal(selected.provider, 'claude');
    selected.executable = executable;
    selected.environment = { ...fixture.emulatedRuntime.peers.find(peer => peer.role === selected.environment.TEST_PEER_ROLE)!.environment };
  }
  const management = profile.management![0]!;
  assert.equal(management.provider, 'claude');
  if (management.provider !== 'claude') throw new Error('Original Claude management profile required');
  management.settingSources = ['user', 'project', 'local'];
  fixture.emulatedRuntime.sources = sources;
  fixture.emulatedRuntime.executable = executable;
  fixture.emulatedRuntime.commandPrefix = `${fixture.node} ${executable.path} `;
  await publishDesktopEmulatedClaudeSettingsProfile(fixture, profile);
  return fixture;
}

/** Before capture only: publish the same original profile/descriptor pins together. */
export async function publishDesktopEmulatedClaudeSettingsProfile(
  fixture: DesktopEmulatedClaudeSettingsFixture,
  profile: TeamHostProfile,
  editDescriptor?: (descriptor: Record<string, unknown>) => void,
) {
  const profileBytes = JSON.stringify(profile);
  await writeFile(fixture.profilePath, profileBytes, { mode: 0o600 });
  fixture.pins.profileSha256 = digest(profileBytes);
  readTeamHostProfile(fixture.profilePath, fixture.pins.profileSha256);
  const descriptor = JSON.parse(await readFile(fixture.descriptorPath, 'utf8'));
  assert.equal(descriptor.owners.length, 1);
  descriptor.owners[0].profile.env.LEGACY_AGENT_HOST_PROFILE_SHA256 = fixture.pins.profileSha256;
  editDescriptor?.(descriptor);
  const descriptorBytes = JSON.stringify(descriptor);
  await writeFile(fixture.descriptorPath, descriptorBytes, { mode: 0o600 });
  fixture.pins.descriptorSha256 = digest(descriptorBytes);
  fixture.appEnvironment.AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256 = fixture.pins.descriptorSha256;
}
