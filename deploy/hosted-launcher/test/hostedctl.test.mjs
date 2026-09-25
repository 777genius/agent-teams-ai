import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createSessionIdentity, ownerHeader } from '../lib/admission.mjs';
import { OWNER_INSTALL_FORMAT, verifyInstalledOwner } from '../lib/owner-artifact.mjs';
import { ownerEnvironment, stopPair } from '../lib/session.mjs';
import { activeTeam, allocateSession, initialState, readState, writeState } from '../lib/state.mjs';
import { runSupervisor } from '../lib/supervisor.mjs';
import { resolvePublishedTeam } from '../lib/teams.mjs';

const directories = [];
async function scratch() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'hostedctl-test-')));
  directories.push(path);
  return path;
}
async function writable(path) {
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await writable(join(path, entry.name));
  }
}
afterEach(async () => {
  for (const path of directories.splice(0)) {
    await writable(path);
    await rm(path, { recursive: true, force: true });
  }
});

const noop = () => undefined;
const sha = text => createHash('sha256').update(text).digest('hex');

test('each session allocates strictly higher owner and mount generations', () => {
  let state = initialState();
  const seen = [];
  for (let index = 0; index < 5; index += 1) {
    state = allocateSession(state);
    seen.push(state.ownerGeneration);
    assert.equal(state.mountGeneration, state.ownerGeneration);
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
});

test('persisted state never moves a generation backwards or swaps identities', async () => {
  const directory = await scratch();
  const first = await writeState(directory, allocateSession(allocateSession(initialState())));
  assert.equal((await readState(directory)).ownerGeneration, 2);
  const stale = allocateSession(initialState({ deploymentId: first.deploymentId }));
  await assert.rejects(writeState(directory, { ...first, ownerGeneration: 1 }), /state-regression-refused/);
  await assert.rejects(writeState(directory, { ...stale, ownerGeneration: 9, mountGeneration: 9 }),
    /state-regression-refused/);
  assert.equal((await readState(directory)).ownerGeneration, 2);
});

function fakeSession(calls, { closeResult = { helperCode: 0, ownerCode: 0 } } = {}) {
  let resolveExit;
  const exited = new Promise(resolve => { resolveExit = resolve; });
  return {
    ownerGeneration: 1, socketPath: '/nonexistent/hostedctl-test.sock', runDirectory: '/nonexistent/g1',
    exit: resolveExit,
    owner: { exited, close: async () => { calls.push('close-owner'); resolveExit(closeResult); return closeResult; } },
  };
}

test('stopping a pair stops Product before revoking the Owner lease', async () => {
  const calls = [];
  const compose = { stopProduct: async () => { calls.push('stop-product'); } };
  await stopPair({ compose, session: fakeSession(calls), log: noop });
  assert.deepEqual(calls, ['stop-product', 'close-owner']);
});

test('a Product that will not stop is reported after the Owner is still revoked', async () => {
  const calls = [];
  const compose = { stopProduct: async () => { calls.push('stop-product'); throw new Error('stuck'); } };
  await assert.rejects(stopPair({ compose, session: fakeSession(calls), log: noop }), /stuck/);
  assert.deepEqual(calls, ['stop-product', 'close-owner']);
});

function scriptedSignals(script) {
  const queue = [...script];
  return {
    take: () => queue.shift() ?? null,
    peek: () => queue[0] ?? null,
    wait: () => new Promise(resolve => setImmediate(resolve)),
    dispose: noop,
  };
}

async function supervisorConfig() {
  const root = await scratch();
  return { stateDir: root, runDir: root,
    timeouts: { healthPollMs: 1, productUnhealthyGraceMs: 1_000_000 } };
}

test('supervisor stops the pair in order and exits 0 on SIGTERM', async () => {
  const calls = [];
  const compose = { productHealth: async () => 'healthy', stopProduct: async () => { calls.push('stop-product'); } };
  const code = await runSupervisor({ config: await supervisorConfig(), compose, log: noop,
    signals: scriptedSignals([null, null, 'terminate']),
    startPair: async () => { calls.push('start'); return fakeSession(calls); } });
  assert.equal(code, 0);
  assert.deepEqual(calls, ['start', 'stop-product', 'close-owner']);
});

test('supervisor exits non-zero when the Owner dies so systemd starts a new pair', async () => {
  const calls = [];
  const compose = { productHealth: async () => 'healthy', stopProduct: async () => { calls.push('stop-product'); } };
  const code = await runSupervisor({ config: await supervisorConfig(), compose, log: noop,
    signals: scriptedSignals([]),
    startPair: async () => {
      calls.push('start');
      const session = fakeSession(calls);
      session.exit({ helperCode: 0, ownerCode: 1 });
      return session;
    } });
  assert.equal(code, 1);
  assert.deepEqual(calls, ['start', 'stop-product', 'close-owner']);
});

test('switch-team reload fully stops the old pair before the next generation starts', async () => {
  const calls = [];
  let started = 0;
  const compose = { productHealth: async () => 'healthy', stopProduct: async () => { calls.push('stop-product'); } };
  const code = await runSupervisor({ config: await supervisorConfig(), compose, log: noop,
    signals: scriptedSignals([null, null, 'reload', null, null, 'terminate']),
    startPair: async () => { started += 1; calls.push(`start-${started}`); return fakeSession(calls); } });
  assert.equal(code, 0);
  assert.deepEqual(calls, ['start-1', 'stop-product', 'close-owner', 'start-2', 'stop-product', 'close-owner']);
});

async function publishTeam(claudeRoot, { deploymentId, teamId, legacyKey }) {
  const directory = join(claudeRoot, 'teams', legacyKey);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const marker = { schemaVersion: 1, operationId: `adoption_${legacyKey.slice(6)}`, teamId,
    directoryFingerprint: 'a'.repeat(64), rootFingerprint: 'b'.repeat(64), teamsFingerprint: 'c'.repeat(64) };
  const identity = { schemaVersion: 1, teamId, createdAt: '2026-09-25T00:00:00.000Z', originDeploymentId: deploymentId };
  await writeFile(join(directory, '.hosted-draft-publication.json'), `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  await writeFile(join(directory, 'team.identity.json'), `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
}

test('switch-team resolves only a team Product published for this deployment', async () => {
  const claudeRoot = await scratch();
  const state = initialState();
  const teamId = `team_${'1'.repeat(32)}`;
  const legacyKey = `draft-${'2'.repeat(32)}`;
  await publishTeam(claudeRoot, { deploymentId: state.deploymentId, teamId, legacyKey });
  await publishTeam(claudeRoot, { deploymentId: 'deployment_other', teamId: `team_${'3'.repeat(32)}`,
    legacyKey: `draft-${'4'.repeat(32)}` });
  const options = { deploymentId: state.deploymentId, uid: process.getuid(), gid: process.getgid() };
  const team = await resolvePublishedTeam(claudeRoot, teamId, options);
  assert.deepEqual({ teamId: team.teamId, legacyKey: team.legacyKey }, { teamId, legacyKey });
  await assert.rejects(resolvePublishedTeam(claudeRoot, `team_${'3'.repeat(32)}`, options), /not-unique:0/);
  const switched = { ...state, desiredTeam: { teamId, legacyKey } };
  assert.equal(activeTeam(switched).teamId, teamId);
  assert.equal(activeTeam({ ...switched, desiredTeam: null }).teamId, state.idleTeam.teamId);
});

async function fakeOwnerInstall() {
  const root = join(await scratch(), 'owner');
  const launcherBytes = 'launcher-bytes';
  const launcher = `hostedActualOwnerLauncher-${sha(launcherBytes)}`;
  const files = { cli: 'cli', 'bin/bun': 'bun', 'dist/local-cli/cli.js': 'bundle',
    [`dist/local-cli/${launcher}`]: launcherBytes };
  await mkdir(join(root, 'dist', 'local-cli'), { recursive: true });
  await mkdir(join(root, 'bin'));
  for (const [relative, content] of Object.entries(files)) {
    await writeFile(join(root, relative), content, { mode: 0o444 });
  }
  for (const directory of ['dist/local-cli', 'dist', 'bin', '.']) await chmod(join(root, directory), 0o555);
  return { root, record: { format: OWNER_INSTALL_FORMAT, root,
    files: Object.fromEntries(Object.entries(files).map(([relative, content]) => [relative, sha(content)])) } };
}

test('an installed Owner file that no longer matches its sha256 refuses the start', async t => {
  const { root, record } = await fakeOwnerInstall();
  const trustedUid = process.getuid();
  try { await verifyInstalledOwner(record, { trustedUid }); }
  catch (error) {
    if (/path-not-root-owned/.test(error.message)) { t.skip('scratch directory ancestors are not trusted here'); return; }
    throw error;
  }
  await chmod(join(root, 'dist', 'local-cli'), 0o755);
  await chmod(join(root, 'dist', 'local-cli', 'cli.js'), 0o644);
  await writeFile(join(root, 'dist', 'local-cli', 'cli.js'), 'tampered');
  await chmod(join(root, 'dist', 'local-cli', 'cli.js'), 0o444);
  await chmod(join(root, 'dist', 'local-cli'), 0o555);
  await assert.rejects(verifyInstalledOwner(record, { trustedUid }), /file-digest-mismatch:dist\/local-cli\/cli\.js/);
});

test('Owner env is an explicit allowlist and never inherits the launcher environment', () => {
  process.env.HOSTEDCTL_TEST_LEAK = 'leak';
  const config = { agent: { home: '/home/agent', user: 'agent' },
    opencode: { runtimeMode: 'official-v1.18.32' } };
  const env = ownerEnvironment(config, '/opt/agent-teams/owner/x',
    new Map([['CLAUDE_CODE_OAUTH_TOKEN', 'token']]));
  delete process.env.HOSTEDCTL_TEST_LEAK;
  assert.equal(env.HOSTEDCTL_TEST_LEAK, undefined);
  assert.equal(env.HOME, '/home/agent');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'token');
  assert.equal(env.HOSTED_OPENCODE_RUNTIME_MODE, 'official-v1.18.32');
  assert.throws(() => ownerEnvironment(config, '/x', new Map([['LD_PRELOAD', '/evil.so']])),
    /provider-env-key-not-allowed:LD_PRELOAD/);
});

test('Owner header uses the personal-host kind and the exact key order Owner compares', () => {
  const state = allocateSession(initialState());
  const identity = createSessionIdentity({ state, team: state.idleTeam, workspaceRoot: '/srv/w',
    installed: { artifactDigest: `sha256:${'a'.repeat(64)}` } });
  const header = ownerHeader(identity, { claudeRoot: '/srv/claude', socketPath: '/run/x/s.sock' });
  assert.equal(header.admissionKind, 'core-lifecycle-personal-host-v1');
  // appMcp is appended last by the root helper, after leaseEvidence.
  assert.deepEqual(Object.keys(header), ['format', 'admissionKind', 'restoreGeneration', 'teamId',
    'declaredRootHash', 'ownerAuthority', 'ownerGeneration', 'ownerSessionId', 'claudeRoot',
    'socketPath', 'legacyKey', 'bootstrapBinding', 'leaseEvidence']);
  assert.equal(header.declaredRootHash, sha('/srv/w'));
});
