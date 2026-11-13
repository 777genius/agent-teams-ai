import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { digest, desktopNodeScriptHeader, fileDigest, prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import { reserveMixedOpenCodeEndpoint } from './desktop-mixed-native-fixture.ts';
import { processTable } from './desktop-backend-observations.ts';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';

export const emulatedManagementSource = 'packages/legacy-agent-host/tests/fixtures/management-opencode-process.ts';
const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};

/** V1's existing status fallback may read this finite version; every other invocation is refused. */
export async function prepareDesktopOpenCodeVersionSentinel(fixture: { root: string; node: string; sentinelLog: string }) {
  const source = `${desktopNodeScriptHeader(fixture.node)}import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2),allowed=args.length===1&&args[0]==='--version';
appendFileSync(${JSON.stringify(fixture.sentinelLog)},JSON.stringify({executable:'opencode',allowed,argc:args.length,flags:args.filter(x=>x.startsWith('-')),emulated:'version-only'})+'\\n',{mode:0o600});
if(allowed){console.log('1.19.4');process.exit(0)}
process.stderr.write('TEST sentinel refuses native provider invocation\\n');process.exit(78);
`;
  const paths = [join(fixture.root, 'bin/opencode'), join(fixture.root, 'claude/local/node_modules/.bin/opencode')];
  for (const path of paths) await writeFile(path, source, { mode: 0o700 });
  return { versionPaths: paths, versionSha256: digest(source) };
}

/** The original HTTP protocol peer is the only provider-shaped executable in this TEST scope. */
export async function prepareDesktopEmulatedManagementFixture(repo: string, pnpmEntry: string) {
  const fixture = await prepareDesktopBackendFixture(repo, {
    pnpmEntry, seedUiTask: true, seedUiPreferences: true, creation: true,
  });
  const peerRoot = join(fixture.root, 'TEST-oauth-host-management');
  for (const name of ['', 'home', 'tmp', 'config', 'data', 'cache', 'bin'])
    await mkdir(join(peerRoot, name), { mode: 0o700 });
  const peerPath = join(peerRoot, 'bin/TEST-opencode.ts');
  const sourcePath = join(repo, emulatedManagementSource);
  await writeFile(peerPath, `#!${fixture.node}\n${await readFile(sourcePath, 'utf8')}`, { mode: 0o700, flag: 'wx' });
  const endpoint = await reserveMixedOpenCodeEndpoint();
  const peer = { path: peerPath, sha256: await fileDigest(peerPath) };
  const profile = JSON.parse(await readFile(fixture.profilePath, 'utf8')) as TeamHostProfile;
  assert.equal(profile.runtime, undefined);
  assert.equal(profile.management, undefined);
  profile.management = [{
    provider: 'opencode', profileId: 'TEST-emulated-management', configRevision: 'TEST-emulated-config',
    accountBinding: 'TEST-no-vendor-account', cwd: join(fixture.root, 'workspace'), endpoint,
    executable: peer, timeoutMs: 15000, modelProbeTimeoutMs: 30000, oauthTimeoutMs: 30000,
    environment: {
      HOME: join(peerRoot, 'home'), TMPDIR: join(peerRoot, 'tmp'),
      XDG_CONFIG_HOME: join(peerRoot, 'config'), XDG_DATA_HOME: join(peerRoot, 'data'),
      XDG_CACHE_HOME: join(peerRoot, 'cache'), PATH: `${dirname(fixture.node)}:/usr/bin:/bin`,
      TEST_MANAGEMENT_FIXTURE_ROOT: peerRoot,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: {}, model: 'TEST-api/TEST-model' }),
    },
  }];
  const profileBytes = JSON.stringify(profile);
  await writeFile(fixture.profilePath, profileBytes, { mode: 0o600 });
  fixture.pins.profileSha256 = digest(profileBytes);
  const descriptor = record(JSON.parse(await readFile(fixture.descriptorPath, 'utf8')));
  assert.ok(Array.isArray(descriptor.owners) && descriptor.owners.length === 1);
  const owner = record(descriptor.owners[0]);
  record(record(owner.profile).env).LEGACY_AGENT_HOST_PROFILE_SHA256 = fixture.pins.profileSha256;
  descriptor.management = [null, join(fixture.root, 'workspace')].map(projectPath => ({
    runtimeId: 'opencode', owner: { ownerId: owner.ownerId, revision: owner.revision },
    contextId: 'local', projectPath, profileId: 'TEST-emulated-management', configRevision: 'TEST-emulated-config',
  }));
  const descriptorBytes = JSON.stringify(descriptor);
  await writeFile(fixture.descriptorPath, descriptorBytes, { mode: 0o600 });
  fixture.pins.descriptorSha256 = digest(descriptorBytes);
  fixture.appEnvironment.AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256 = fixture.pins.descriptorSha256;
  const versionSentinel = await prepareDesktopOpenCodeVersionSentinel(fixture);
  assert.equal(process.platform, 'linux', 'this management UI fixture owns a Linux TEST opener');
  const openerPath = join(fixture.root, 'bin/xdg-open');
  const opener = `${desktopNodeScriptHeader(fixture.node)}import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);let url;try{url=args.length===1?new URL(args[0]):null}catch{process.exit(78)}
if(!url||url.origin!==${JSON.stringify(endpoint)}||url.pathname!=='/TEST-browser'||url.username||url.password)process.exit(78);
appendFileSync(${JSON.stringify(join(fixture.root, 'ui-emulated-external-open.ndjson'))},JSON.stringify({accepted:true,peerOnly:true})+'\\n',{mode:0o600});
`;
  await writeFile(openerPath, opener, { mode: 0o700, flag: 'wx' });
  return { ...fixture, emulatedManagement: {
    peerRoot, peer, sourcePath, sourceSha256: await fileDigest(sourcePath),
    ...versionSentinel, openerPath, openerSha256: digest(opener),
    command: `${fixture.node} ${peerPath} serve --hostname 127.0.0.1 --port ${new URL(endpoint).port}`,
    observedPeerPids: [] as number[],
  } };
}

/** Observe original TEST peer identities after Host shutdown; never signal or adopt by PID. */
export async function observeDesktopEmulatedManagementCleanup(
  fixture: Awaited<ReturnType<typeof prepareDesktopEmulatedManagementFixture>>,
) {
  const logPath = join(fixture.emulatedManagement.peerRoot, 'native-effects.ndjson');
  const bytes = await readFile(logPath, 'utf8');
  assert.ok(Buffer.byteLength(bytes) <= 1024 * 1024, 'bounded original TEST peer log');
  const launches = bytes.trim().split('\n').filter(Boolean).map(line => record(JSON.parse(line)))
    .filter(row => row.event === 'launch').map(row => row.pid);
  assert.ok(launches.length > 0 && launches.every(pid => Number.isSafeInteger(pid) && Number(pid) > 1));
  const originalPeerPids = [...new Set([...fixture.emulatedManagement.observedPeerPids, ...launches as number[]])];
  const remaining = processTable().filter(row => originalPeerPids.includes(row.pid));
  return { originalPeerPids, observedDirectChildPids: fixture.emulatedManagement.observedPeerPids,
    launchPids: launches, remaining, absent: remaining.length === 0, logSha256: digest(bytes) };
}

/** Recheck actual captured bytes, not just the mode name, before Electron can start. */
export async function verifyDesktopEmulatedManagementFixture(
  fixture: Awaited<ReturnType<typeof prepareDesktopEmulatedManagementFixture>>,
) {
  const selected = fixture.emulatedManagement;
  assert.equal(await realpath(selected.peer.path), selected.peer.path);
  assert.equal(await fileDigest(selected.sourcePath), selected.sourceSha256);
  assert.equal(await fileDigest(selected.peer.path), selected.peer.sha256);
  for (const path of selected.versionPaths) assert.equal(await fileDigest(path), selected.versionSha256);
  assert.equal(await fileDigest(selected.openerPath), selected.openerSha256);
  assert.equal(await fileDigest(fixture.profilePath), fixture.pins.profileSha256);
  assert.equal(await fileDigest(fixture.descriptorPath), fixture.pins.descriptorSha256);
  const profile = JSON.parse(await readFile(fixture.profilePath, 'utf8')) as TeamHostProfile;
  assert.equal(profile.runtime, undefined);
  assert.ok(profile.management && profile.management.length === 1);
  assert.equal(profile.management[0]!.provider, 'opencode');
  assert.deepEqual(profile.management[0]!.executable, selected.peer);
  return { peerSha256: selected.peer.sha256, sourceSha256: selected.sourceSha256,
    versionSentinelSha256: selected.versionSha256, openerSha256: selected.openerSha256,
    runtimeConfigured: false, managementConfigured: true };
}
