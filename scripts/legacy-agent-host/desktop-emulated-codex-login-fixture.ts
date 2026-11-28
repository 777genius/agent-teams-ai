import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { digest, desktopNodeScriptHeader, fileDigest, prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import { processTable } from './desktop-backend-observations.ts';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';

export const emulatedCodexLoginSource = 'packages/legacy-agent-host/tests/fixtures/codex-metadata-peer.ts';
const args = ['app-server', '--listen', 'stdio://'];
const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
const profileId = 'TEST-emulated-codex-login';
const configRevision = 'TEST-emulated-codex-login-config';

/** Original Host/D stdio protocol with a signed-out finite peer; no vendor executable or credentials. */
export async function prepareDesktopEmulatedCodexLoginFixture(repo: string, pnpmEntry: string) {
  assert.equal(process.platform, 'linux', 'this UI lane owns the original private TEST OS opener');
  const fixture = await prepareDesktopBackendFixture(repo, {
    pnpmEntry, seedUiTask: true, seedUiPreferences: true, observeCodexLoginOpen: true,
  });
  const peerRoot = join(fixture.root, 'TEST-codex-login-management');
  for (const name of ['', 'home', 'codex', 'tmp', 'config', 'data', 'cache', 'bin'])
    await mkdir(join(peerRoot, name), { mode: 0o700 });
  const sourcePath = join(repo, emulatedCodexLoginSource);
  const peerPath = join(peerRoot, 'bin/TEST-codex-login.ts');
  await writeFile(peerPath, desktopNodeScriptHeader(fixture.node) + await readFile(sourcePath, 'utf8'),
    { mode: 0o700, flag: 'wx' });
  const peer = { path: peerPath, sha256: await fileDigest(peerPath) };
  const profile = JSON.parse(await readFile(fixture.profilePath, 'utf8')) as TeamHostProfile;
  assert.equal(profile.runtime, undefined);
  assert.equal(profile.management, undefined);
  profile.management = [{
    provider: 'codex', protocolRevision: '0.162.0', profileId, configRevision,
    accountBinding: 'TEST-no-vendor-account', cwd: join(fixture.root, 'workspace'),
    executable: peer, timeoutMs: 10000,
    environment: {
      HOME: join(peerRoot, 'home'), CODEX_HOME: join(peerRoot, 'codex'), TMPDIR: join(peerRoot, 'tmp'),
      XDG_CONFIG_HOME: join(peerRoot, 'config'), XDG_DATA_HOME: join(peerRoot, 'data'),
      XDG_CACHE_HOME: join(peerRoot, 'cache'), PATH: `${dirname(fixture.node)}:/usr/bin:/bin`,
      SHELL: '/bin/sh', TEST_LOGIN: 'desktop-pending',
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
    runtimeId: 'codex', owner: { ownerId: owner.ownerId, revision: owner.revision },
    contextId: 'local', projectPath, profileId, configRevision,
  }));
  const descriptorBytes = JSON.stringify(descriptor);
  await writeFile(fixture.descriptorPath, descriptorBytes, { mode: 0o600 });
  fixture.pins.descriptorSha256 = digest(descriptorBytes);
  fixture.appEnvironment.AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256 = fixture.pins.descriptorSha256;
  const openerPath = join(fixture.root, 'bin/xdg-open');
  return { ...fixture, emulatedManagement: {
    kind: 'codex-login' as const, peerRoot, peer, sourcePath, sourceSha256: await fileDigest(sourcePath),
    openerPath, openerSha256: await fileDigest(openerPath),
    command: `${fixture.node} ${peerPath} ${args.join(' ')}`, observedPeerPids: [] as number[],
  } };
}

type CodexLoginFixture = Awaited<ReturnType<typeof prepareDesktopEmulatedCodexLoginFixture>>;

/** Recheck the selected peer, original opener and the sole management profile before/after UI. */
export async function verifyDesktopEmulatedCodexLoginFixture(fixture: CodexLoginFixture) {
  const selected = fixture.emulatedManagement;
  assert.equal(await realpath(selected.peer.path), selected.peer.path);
  for (const [path, sha256] of [[selected.sourcePath, selected.sourceSha256],
    [selected.peer.path, selected.peer.sha256], [selected.openerPath, selected.openerSha256],
    [fixture.profilePath, fixture.pins.profileSha256], [fixture.descriptorPath, fixture.pins.descriptorSha256]])
    assert.equal(await fileDigest(path!), sha256);
  const profile = JSON.parse(await readFile(fixture.profilePath, 'utf8')) as TeamHostProfile;
  assert.equal(profile.runtime, undefined);
  assert.equal(profile.management?.length, 1);
  const management = profile.management![0]!;
  assert.ok(management.provider === 'codex');
  assert.equal(management.protocolRevision, '0.162.0');
  assert.equal(management.profileId, profileId);
  assert.equal(management.configRevision, configRevision);
  assert.deepEqual(management.executable, selected.peer);
  assert.equal(management.environment.TEST_LOGIN, 'desktop-pending');
  assert.equal(management.environment.HOME, join(selected.peerRoot, 'home'));
  assert.equal(management.environment.CODEX_HOME, join(selected.peerRoot, 'codex'));
  return { kind: selected.kind, peerSha256: selected.peer.sha256, sourceSha256: selected.sourceSha256,
    openerSha256: selected.openerSha256, protocolRevision: '0.162.0', vendorExecutable: false,
    runtimeConfigured: false, managementConfigured: true };
}

async function readBoundedPeerLog(path: string) {
  const size = (await stat(path)).size;
  assert.ok(size > 0 && size <= 1024 * 1024, 'bounded original TEST login peer log');
  const bytes = await readFile(path, 'utf8');
  assert.equal(Buffer.byteLength(bytes), size, 'original peer log is quiescent after Host cleanup');
  const rows = bytes.trim().split('\n').filter(Boolean).map(line => record(JSON.parse(line)));
  assert.ok(rows.length <= 2048, 'finite original login protocol observations');
  return { rows, sha256: digest(bytes) };
}

/** Observe exact original peers after guarded Quit. Counts come from the wire, never from UI intent. */
export async function observeDesktopEmulatedCodexLoginCleanup(fixture: CodexLoginFixture) {
  const selected = fixture.emulatedManagement;
  const launches = await readBoundedPeerLog(join(selected.peerRoot, 'home/TEST-login-processes.ndjson'));
  assert.ok(launches.rows.length <= 256);
  for (const row of launches.rows) {
    assert.ok(Number.isSafeInteger(row.pid) && Number(row.pid) > 1);
    assert.deepEqual(row.args, args, 'only the captured original app-server protocol invocation ran');
  }
  const launchPids = launches.rows.map(row => Number(row.pid));
  assert.equal(new Set(launchPids).size, launchPids.length, 'original peer identities remain distinct');
  const originalPeerPids = [...new Set([...selected.observedPeerPids, ...launchPids])];
  const remaining = processTable().filter(row => originalPeerPids.includes(row.pid));
  const wire = await readBoundedPeerLog(join(selected.peerRoot, 'home/TEST-wire.ndjson'));
  assert.ok(wire.rows.every(row => launchPids.includes(Number(row.pid))));
  const starts = wire.rows.filter(row => row.method === 'account/login/start');
  const cancellations = wire.rows.filter(row => row.method === 'account/login/cancel');
  assert.deepEqual(starts.map(row => record(row.params).type), ['chatgpt', 'chatgptDeviceCode']);
  assert.equal(new Set(starts.map(row => row.pid)).size, 2, 'each explicit login owns one distinct peer');
  assert.equal(cancellations.length, 2, 'both original authorizations were cancelled exactly once');
  for (const [index, start] of starts.entries()) {
    assert.equal(cancellations[index]!.pid, start.pid);
    assert.equal(record(cancellations[index]!.params).loginId, 'TEST-native-login-' + String(start.pid));
  }
  const allowed = ['initialize', 'initialized', 'account/read', 'account/rateLimits/read',
    'config/read', 'model/list', 'account/login/start', 'account/login/cancel'];
  assert.ok(wire.rows.every(row => allowed.includes(String(row.method))), 'no logout, session or model invocation');
  const accountReads = wire.rows.filter(row => row.method === 'account/read').length;
  assert.ok(accountReads > 0, 'signed-out readback reaches the original protocol peer');
  const accountAbsent = await stat(join(selected.peerRoot, 'codex/TEST-login-account.json'))
    .then(() => false, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return true; throw error; });
  assert.equal(accountAbsent, true, 'pending/cancel never persists an authenticated account');
  const opened = await readBoundedPeerLog(join(fixture.root, 'external-open.jsonl'));
  assert.equal(opened.rows.length, 2, 'only the two original explicit Open login clicks dispatch');
  for (const row of opened.rows) {
    assert.deepEqual(Object.keys(row), ['sha256']);
    assert.match(String(row.sha256), /^[a-f0-9]{64}$/u);
  }
  const fixturePins = await verifyDesktopEmulatedCodexLoginFixture(fixture);
  return { originalPeerPids, observedDirectChildPids: selected.observedPeerPids, launchPids, remaining,
    absent: remaining.length === 0, launchLogSha256: launches.sha256, wireLogSha256: wire.sha256,
    externalOpenLogSha256: opened.sha256, externalOpenCount: opened.rows.length,
    protocol: { browserStarts: starts.filter(row => record(row.params).type === 'chatgpt').length,
      deviceStarts: starts.filter(row => record(row.params).type === 'chatgptDeviceCode').length,
      cancellations: cancellations.length, originalLoginIdsCancelled: true, accountReads,
      logout: wire.rows.filter(row => row.method === 'account/logout').length,
      sessionOrModelRequests: wire.rows.filter(row => !allowed.includes(String(row.method))).length, accountAbsent },
    fixturePins };
}
