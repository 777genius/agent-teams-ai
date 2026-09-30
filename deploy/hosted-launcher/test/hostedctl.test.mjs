import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import YAML from 'yaml';
import { createSessionIdentity, ownerHeader, signedAdmission } from '../lib/admission.mjs';
import { parseConfig } from '../lib/config.mjs';
import { assertOperatorEnv, composeArgs, launcherComposeValues, renderEnvFile,
  writeWorkspaceMounts, workspaceMountsFile } from '../lib/compose.mjs';
import { parseNativeProviders } from '../lib/native-providers.mjs';
import { OWNER_INSTALL_FORMAT, verifyInstalledOwner } from '../lib/owner-artifact.mjs';
import { ownerEnvironment, stopPair } from '../lib/session.mjs';
import { activeTeam, allocateSession, initialState, readState, reconcileWorkspaces,
  STATE_FORMAT_V2, writeState } from '../lib/state.mjs';
import { runSupervisor } from '../lib/supervisor.mjs';
import { resolvePublishedTeam } from '../lib/teams.mjs';
import { pinnedV1Root, prepareWorkspacesForInit, rootHash } from '../lib/workspace-registrations.mjs';

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

async function registrationFixture() {
  const base = await scratch();
  const paths = Object.fromEntries(['state', 'run', 'a', 'b', 'c'].map(name => [name, join(base, name)]));
  for (const path of Object.values(paths)) await mkdir(path, { mode: 0o700 });
  const config = { stateDir: paths.state, runDir: paths.run, workspaceRoot: paths.a,
    agent: { uid: process.getuid() } };
  return { paths, config };
}

async function v1SessionEvidence(config, state) {
  const identity = createSessionIdentity({ state, team: state.idleTeam, workspaceRoot: config.workspaceRoot,
    installed: { artifactDigest: `sha256:${'a'.repeat(64)}` } });
  const values = launcherComposeValues({ ...config, composeProject: 'fixture', claudeRoot: '/tmp/claude',
    secretsDir: '/tmp/secrets', opencode: null }, state,
  { runDirectory: join(config.runDir, `owner-g${state.ownerGeneration}`), bootstrap: identity.bootstrap });
  await writeFile(join(config.stateDir, 'session.env'), renderEnvFile(values), { mode: 0o600 });
  identity.secret.fill(0);
}

test('fresh deployment pins a custom owner key directly in v2 and reconciles without v1 migration', async () => {
  const { config, paths } = await registrationFixture();
  const explicit = { ...config, workspaceRoot: paths.b, ownerRegistrationKey: 'owner.custom',
    workspaces: [{ registrationKey: 'extra.a', root: paths.a },
      { registrationKey: 'owner.custom', root: paths.b }] };
  const registrations = await prepareWorkspacesForInit(explicit);
  const first = await writeState(config.stateDir, initialState(registrations));
  assert.equal(first.format, STATE_FORMAT_V2);
  assert.equal(first.ownerRegistrationKey, 'owner.custom');
  assert.equal(first.registrations.find(row => row.registrationKey === 'owner.custom').workspaceId,
    first.workspaceId);
  assert.equal(first.registrations.find(row => row.registrationKey === 'owner.custom').canonicalRoot, paths.b);
  const reconciled = await reconcileWorkspaces(config.stateDir, explicit, first);
  assert.deepEqual(reconciled, first);
  assert.equal((await readState(config.stateDir)).ownerRegistrationKey, 'owner.custom');
  await assert.rejects(stat(join(config.stateDir, 'workspace-root-pin.json')), { code: 'ENOENT' });
});

test('explicit roots are validated without changing owner mode; legacy root is provisioned', async () => {
  const { config, paths } = await registrationFixture();
  await chmod(paths.b, 0o750);
  const explicit = { ...config, workspaceRoot: paths.b, ownerRegistrationKey: 'owner.custom',
    workspaces: [{ registrationKey: 'owner.custom', root: paths.b }],
    provisionLegacyWorkspaceRoot: false };
  const before = await stat(paths.b);
  await prepareWorkspacesForInit(explicit);
  const after = await stat(paths.b);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
  assert.equal(after.mode & 0o777, 0o750);
  const absent = join(await scratch(), 'missing');
  await assert.rejects(prepareWorkspacesForInit({ ...explicit, workspaceRoot: absent,
    workspaces: [{ registrationKey: 'owner.custom', root: absent }] }), { code: 'ENOENT' });
  const legacy = join(await scratch(), 'legacy');
  await prepareWorkspacesForInit({ ...config, workspaceRoot: legacy,
    workspaces: [{ registrationKey: 'personal.main', root: legacy }],
    ownerRegistrationKey: 'personal.main', provisionLegacyWorkspaceRoot: true,
    agent: { uid: process.getuid(), gid: process.getgid() } });
  assert.equal((await stat(legacy)).mode & 0o777, 0o700);
});

test('v1 stop and reboot migration preserves personal ID using durable issued evidence', async () => {
  const { config } = await registrationFixture();
  const first = allocateSession(initialState());
  await writeState(config.stateDir, first);
  await v1SessionEvidence(config, first); // session.env survives stop; /run is empty
  const reserved = await writeState(config.stateDir, allocateSession(allocateSession(first)));
  const migrated = await reconcileWorkspaces(config.stateDir, config, reserved);
  assert.equal(migrated.format, STATE_FORMAT_V2);
  assert.equal(migrated.workspaceId, first.workspaceId);
  assert.equal(migrated.registrations[0].workspaceId, first.workspaceId);
  assert.equal(migrated.registrations[0].mountGeneration, 3);
  const boot = await writeState(config.stateDir, allocateSession(migrated));
  assert.equal(boot.mountGeneration, 4);
  const issuer = createSessionIdentity({ state: boot, team: boot.idleTeam,
    workspaceRoot: config.workspaceRoot, installed: { artifactDigest: `sha256:${'a'.repeat(64)}` } });
  assert.equal(JSON.parse(issuer.bootstrap).workspaceManifest.registrations[0].workspaceId, first.workspaceId);
  issuer.secret.fill(0);
  assert.equal((await readState(config.stateDir)).format, STATE_FORMAT_V2);
  await assert.rejects(writeState(config.stateDir, reserved), /state-regression-refused/);
});

test('registrations survive reorder, tombstone, re-add and replacement without ID reuse', async () => {
  const { config, paths } = await registrationFixture();
  await chmod(paths.b, 0o750);
  const initial = await writeState(config.stateDir, initialState());
  const both = { ...config, ownerRegistrationKey: 'personal.main', workspaces: [
    { registrationKey: 'personal.main', root: paths.a }, { registrationKey: 'extra.b', root: paths.b }] };
  let state = await reconcileWorkspaces(config.stateDir, both, initial);
  const a = state.registrations.find(row => row.registrationKey === 'personal.main');
  const b = state.registrations.find(row => row.registrationKey === 'extra.b');
  assert.equal((await stat(paths.b)).mode & 0o777, 0o750);
  assert.equal(a.workspaceId, initial.workspaceId);
  state = await reconcileWorkspaces(config.stateDir, { ...both, workspaces: [...both.workspaces].reverse() }, state);
  assert.deepEqual(state.registrations.find(row => row.registrationKey === 'extra.b'), b);
  state = await reconcileWorkspaces(config.stateDir,
    { ...both, workspaces: [both.workspaces[0]] }, state);
  const tombstone = state.registrations.find(row => row.registrationKey === 'extra.b');
  assert.equal(tombstone.enabled, false);
  assert.ok(tombstone.registrationRevision > b.registrationRevision);
  await assert.rejects(reconcileWorkspaces(config.stateDir, { ...both, workspaces: [
    both.workspaces[0], { registrationKey: 'extra.copied', root: paths.b }] }, state),
  /state-registration-invalid/);
  state = await reconcileWorkspaces(config.stateDir, both, state);
  const restored = state.registrations.find(row => row.registrationKey === 'extra.b');
  assert.equal(restored.workspaceId, b.workspaceId);
  assert.ok(restored.mountGeneration > tombstone.mountGeneration);
  await assert.rejects(reconcileWorkspaces(config.stateDir,
    { ...both, workspaces: [both.workspaces[0], { registrationKey: 'extra.b', root: paths.c }] }, state),
  /workspace-key-retarget-refused/);
  const replacement = await reconcileWorkspaces(config.stateDir, { ...both, workspaces: [
    both.workspaces[0], { registrationKey: 'extra.c', root: paths.c }] }, state);
  assert.equal(replacement.registrations.find(row => row.registrationKey === 'extra.b').enabled, false);
  assert.notEqual(replacement.registrations.find(row => row.registrationKey === 'extra.c').workspaceId, b.workspaceId);
  await assert.rejects(writeState(config.stateDir, { ...replacement,
    ownerGeneration: replacement.ownerGeneration + 1, mountGeneration: replacement.mountGeneration + 1 }),
  /enabled-mount-generation-invalid/);
  await assert.rejects(writeState(config.stateDir, { ...replacement, registrations: replacement.registrations
    .filter(row => row.registrationKey !== 'extra.b') }), /registration-retarget-refused/);
});

test('personal issuer signs all durable boundaries while Compose mounts only enabled roots', async () => {
  const { config, paths } = await registrationFixture();
  let state = await writeState(config.stateDir, initialState({ ownerRegistrationKey: 'personal.main',
    workspaces: [{ registrationKey: 'personal.main', root: paths.a },
      { registrationKey: 'extra.b', root: paths.b }, { registrationKey: 'denied.c', root: paths.c }] }));
  state = await reconcileWorkspaces(config.stateDir, { ...config, ownerRegistrationKey: 'personal.main',
    workspaces: [{ registrationKey: 'personal.main', root: paths.a },
      { registrationKey: 'extra.b', root: paths.b }] }, state);
  state = allocateSession(state);
  const identity = createSessionIdentity({ state, team: state.idleTeam, workspaceRoot: paths.a,
    installed: { artifactDigest: `sha256:${'a'.repeat(64)}` } });
  const bootstrap = JSON.parse(identity.bootstrap);
  assert.deepEqual(bootstrap.runtimeInstance.workspaceRoots.map(row => row.reference),
    [paths.c, paths.b, paths.a]);
  assert.equal(bootstrap.workspaceId, state.workspaceId);
  assert.equal(bootstrap.workspaceManifest.registrations[0].enabled, false);
  assert.equal(bootstrap.workspaceManifest.registrations[0].mountBinding, undefined);
  assert.equal(bootstrap.workspaceManifest.registrations[1].mountBinding.mountGeneration,
    state.mountGeneration);
  assert.throws(() => createSessionIdentity({ state, team: state.idleTeam, workspaceRoot: paths.b,
    installed: { artifactDigest: `sha256:${'a'.repeat(64)}` } }), /session-workspace-binding-invalid/);
  const codexRoot = join(await scratch(), 'codex');
  await mkdir(codexRoot);
  const sessions = join(codexRoot, 'sessions');
  const archivedSessions = join(codexRoot, 'archived_sessions');
  await mkdir(sessions);
  await mkdir(archivedSessions);
  const mounted = { ...config, codexMetadata: { sessions, archivedSessions },
    composeFiles: ['/base.yml', '/personal.yml'], composeEnvFile: '/operator.env',
    sessionEnvFile: join(config.stateDir, 'session.env'), composeProject: 'fixture' };
  await writeWorkspaceMounts(mounted, state);
  const override = await readFile(workspaceMountsFile(mounted), 'utf8');
  const service = YAML.parse(override).services['agent-teams-personal'];
  assert.deepEqual(service.volumes.map(volume => [volume.source, volume.target, volume.read_only]), [
    [paths.b, paths.b, false],
    [sessions, '/data/codex-metadata/sessions', true],
    [archivedSessions, '/data/codex-metadata/archived_sessions', true],
  ]);
  assert.equal(service.environment.HOSTED_DASHBOARD_MULTI_ROOT_ACTIVE,
    '${HOSTED_DASHBOARD_MULTI_ROOT_ACTIVE:?Run hostedctl}');
  assert.ok(override.includes(`source: ${JSON.stringify(paths.b)}`));
  assert.ok(!override.includes(paths.c));
  assert.ok(!override.includes(paths.a)); // owner stays in the static personal override
  assert.ok(!override.includes(`source: ${JSON.stringify(codexRoot)}`)); // never bind the credential home
  assert.ok(override.includes(`source: ${JSON.stringify(sessions)}`));
  assert.ok(override.includes(`source: ${JSON.stringify(archivedSessions)}`));
  assert.ok(override.includes('target: "/data/codex-metadata/sessions"'));
  assert.ok(override.includes('target: "/data/codex-metadata/archived_sessions"'));
  assert.equal((override.match(/read_only: true/gu) ?? []).length, 2);
  assert.ok(composeArgs(mounted).includes(workspaceMountsFile(mounted)));
  const values = launcherComposeValues(mounted, state, { bootstrap: identity.bootstrap, runDirectory: paths.run });
  assert.equal(values.HOSTED_WORKSPACE_IDS,
    [state.workspaceId, state.registrations.find(row => row.registrationKey === 'extra.b').workspaceId]
      .sort().join(','));
  assert.equal(values.HOSTED_DASHBOARD_MULTI_ROOT_ACTIVE, 'false');
  identity.secret.fill(0);
});

test('metadata mount sources are an explicit canonical subtree pair and activation is launcher-owned', async () => {
  const base = await scratch();
  const sessions = join(base, 'sessions');
  const archivedSessions = join(base, 'archived_sessions');
  await mkdir(join(base, 'a'));
  await mkdir(sessions);
  await mkdir(archivedSessions);
  const config = { stateDir: base, workspaceRoot: join(base, 'a'), codexMetadata: { sessions, archivedSessions } };
  await writeWorkspaceMounts(config, initialState());
  const alias = join(base, 'alias');
  await symlink(sessions, alias);
  await assert.rejects(writeWorkspaceMounts({ ...config,
    codexMetadata: { sessions: alias, archivedSessions } }, initialState()),
  /codex-metadata-source-invalid/);
  const env = join(base, 'operator.env');
  await writeFile(env, 'HOSTED_DASHBOARD_MULTI_ROOT_ACTIVE=true\n');
  await assert.rejects(assertOperatorEnv(env), /compose-env-sets-launcher-keys/);
});

test('Compose resolves dollar-bearing signed mount paths exactly', async t => {
  const { config, paths } = await registrationFixture();
  const otherRoot = join(paths.a, '$workspace');
  await mkdir(otherRoot);
  const metadataBase = join(await scratch(), '$metadata');
  await mkdir(metadataBase);
  const sessions = join(metadataBase, 'sessions');
  const archivedSessions = join(metadataBase, 'archived_sessions');
  await mkdir(sessions);
  await mkdir(archivedSessions);
  const state = initialState({ ownerRegistrationKey: 'personal.main', workspaces: [
    { registrationKey: 'personal.main', root: paths.a },
    { registrationKey: 'other', root: otherRoot },
  ] });
  const mounted = { ...config, codexMetadata: { sessions, archivedSessions } };
  await writeWorkspaceMounts(mounted, state);
  const source = await readFile(workspaceMountsFile(mounted), 'utf8');
  assert.ok(source.includes('$$workspace'));
  assert.ok(source.includes('$$metadata'));
  if (spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status !== 0) {
    t.skip('Docker Compose CLI unavailable for effective mount assertion');
    return;
  }
  const baseCompose = join(config.stateDir, 'base.yml');
  await writeFile(baseCompose, 'services:\n  agent-teams-personal:\n    image: busybox:latest\n');
  const rendered = JSON.parse(execFileSync('docker', ['compose', '-p', 'hostedctl-dollar-fixture',
    '-f', baseCompose, '-f', workspaceMountsFile(mounted), 'config', '--format', 'json'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOSTED_DASHBOARD_MULTI_ROOT_ACTIVE: 'false',
      workspace: 'WRONG_WORKSPACE', metadata: 'WRONG_METADATA' },
  }));
  const volumes = rendered.services['agent-teams-personal'].volumes;
  // Compose config serializes preserved literal dollars as $$ for a reusable Compose model.
  const escaped = path => path.replaceAll('$', () => '$$');
  assert.deepEqual(volumes.map(volume => [volume.source, volume.target]), [
    [escaped(otherRoot), escaped(otherRoot)],
    [escaped(sessions), '/data/codex-metadata/sessions'],
    [escaped(archivedSessions), '/data/codex-metadata/archived_sessions'],
  ]);
});

test('mixed-case registration keys persist in stable code-unit order', async () => {
  const { config, paths } = await registrationFixture();
  const initial = await writeState(config.stateDir, initialState());
  const next = await reconcileWorkspaces(config.stateDir, { ...config,
    ownerRegistrationKey: 'personal.main', workspaces: [
      { registrationKey: 'personal.main', root: paths.a },
      { registrationKey: 'B', root: paths.b },
      { registrationKey: 'b', root: paths.c },
    ] }, initial);
  assert.deepEqual(next.registrations.map(row => row.registrationKey), ['B', 'b', 'personal.main']);
});

test('v1 missing or stale evidence after issued generations fails closed; zero pins current root', async () => {
  const { config, paths } = await registrationFixture();
  const initial = await writeState(config.stateDir, initialState());
  const pinned = await reconcileWorkspaces(config.stateDir, config, initial);
  assert.equal(pinned.registrations[0].canonicalRoot, paths.a);
  const other = await registrationFixture();
  const started = await writeState(other.config.stateDir, allocateSession(initialState()));
  await assert.rejects(reconcileWorkspaces(other.config.stateDir, other.config, started),
    /root-evidence-missing:restore-matching-state-and-session-env-backup/);
  await v1SessionEvidence(other.config, started);
  await assert.rejects(reconcileWorkspaces(other.config.stateDir,
    { ...other.config, workspaceRoot: other.paths.b }, started), /root-evidence-mismatch/);
  await writeFile(join(other.config.stateDir, 'session.env'), 'broken\n', { mode: 0o600 });
  await assert.rejects(reconcileWorkspaces(other.config.stateDir, other.config, started),
    /root-evidence-session-corrupt/);
  assert.equal((await readState(other.config.stateDir)).format, initial.format);
});

test('a durable root pin completes migration after interruption before v2 write', async () => {
  const { config } = await registrationFixture();
  const started = await writeState(config.stateDir, allocateSession(initialState()));
  await v1SessionEvidence(config, started);
  const pin = await pinnedV1Root(config.stateDir, config, started);
  await rm(join(config.stateDir, 'session.env'));
  const migrated = await reconcileWorkspaces(config.stateDir, config, started);
  assert.equal(migrated.registrations[0].declaredRootHash, pin.declaredRootHash);
  assert.equal(migrated.registrations[0].workspaceId, started.workspaceId);
});

test('available signed admission must match durable v1 bootstrap', async () => {
  const { config } = await registrationFixture();
  const started = await writeState(config.stateDir, allocateSession(initialState()));
  const installed = { artifactDigest: `sha256:${'a'.repeat(64)}` };
  const identity = createSessionIdentity({ state: started, team: started.idleTeam,
    workspaceRoot: config.workspaceRoot, installed });
  const runDirectory = join(config.runDir, `owner-g${started.ownerGeneration}`);
  await mkdir(runDirectory, { mode: 0o700 });
  const values = launcherComposeValues({ ...config, composeProject: 'fixture', claudeRoot: '/tmp/claude',
    secretsDir: '/tmp/secrets', opencode: null }, started,
  { runDirectory, bootstrap: identity.bootstrap });
  await writeFile(join(config.stateDir, 'session.env'), renderEnvFile(values), { mode: 0o600 });
  await assert.rejects(reconcileWorkspaces(config.stateDir, config, started),
    /root-evidence-admission-missing/);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x;
  const key = { privateKey, publicKey: x, keyId: sha(Buffer.from(x, 'base64url')) };
  const admissionPath = join(runDirectory, 'lifecycle-owner-admission.json');
  const signed = signedAdmission(identity, installed, { uid: process.getuid() }, key);
  await writeFile(admissionPath, signed.replace(identity.bootstrapBinding.bootstrapDigest, '0'.repeat(64)),
    { mode: 0o400 });
  await assert.rejects(reconcileWorkspaces(config.stateDir, config, started, key),
    /root-evidence-admission-mismatch/);
  await chmod(admissionPath, 0o600);
  await writeFile(admissionPath, signed, { mode: 0o400 });
  await chmod(admissionPath, 0o400);
  const migrated = await reconcileWorkspaces(config.stateDir, config, started, key);
  assert.equal(migrated.registrations[0].workspaceId, started.workspaceId);
  identity.secret.fill(0);
});

test('single-root config remains compatible while explicit registrations are bounded', () => {
  const raw = { productRepo: '/srv/product', stateDir: '/srv/state', installRoot: '/srv/install',
    runDir: '/srv/run', logDir: '/srv/log', launcherKeyFile: '/srv/state/key', secretsDir: '/srv/secrets',
    composeProject: 'fixture', composeEnvFile: '/srv/compose.env', claudeRoot: '/srv/claude',
    workspaceRoot: '/srv/a', agent: { uid: 1000, gid: 1000, home: '/home/agent', user: 'agent' } };
  assert.deepEqual(parseConfig(raw).workspaces, [{ registrationKey: 'personal.main', root: '/srv/a' }]);
  assert.equal(parseConfig(raw).provisionLegacyWorkspaceRoot, true);
  assert.equal(parseConfig({ ...raw, workspaceRoot: undefined, ownerRegistrationKey: 'personal.main',
    workspaces: [{ registrationKey: 'personal.main', root: '/srv/a' }] }).workspaceRoot, '/srv/a');
  assert.equal(parseConfig({ ...raw, ownerRegistrationKey: 'personal.main',
    workspaces: [{ registrationKey: 'personal.main', root: '/srv/a' }] }).provisionLegacyWorkspaceRoot, false);
  assert.throws(() => parseConfig({ ...raw, workspaces: [{ registrationKey: 'personal.main', root: '/srv/a' }] }),
    /owner-registration-key-required/);
  assert.throws(() => parseConfig({ ...raw, ownerRegistrationKey: 'personal.main', workspaces: Array(17)
    .fill({ registrationKey: 'personal.main', root: '/srv/a' }) }), /workspaces-invalid/);
  assert.deepEqual(parseConfig({ ...raw, codexMetadata: {
    sessions: '/srv/codex/sessions', archivedSessions: '/srv/codex/archived_sessions',
  } }).codexMetadata, { sessions: '/srv/codex/sessions',
    archivedSessions: '/srv/codex/archived_sessions' });
  assert.throws(() => parseConfig({ ...raw, codexMetadata: { sessions: '/srv/codex' } }),
    /codex-metadata-invalid/);
  assert.throws(() => parseConfig({ ...raw, codexMetadata: {
    sessions: '/srv/codex/auth.json', archivedSessions: '/srv/codex/archived_sessions',
  } }), /codex-metadata-invalid/);
});

test('maximum registration state remains readable above the former 16 KiB cap', async () => {
  const { config } = await registrationFixture();
  const v1 = initialState();
  const longRoot = `/${Array(12).fill('r'.repeat(160)).join('/')}`;
  const registrations = Array.from({ length: 16 }, (_, index) => {
    const canonicalRoot = index === 0 ? config.workspaceRoot : `${longRoot}/${index}`;
    return { registrationKey: index === 0 ? 'personal.main' : `extra.${String(index).padStart(2, '0')}`,
      workspaceId: index === 0 ? v1.workspaceId : `workspace_${index.toString(16).padStart(32, '0')}`,
      canonicalRoot, declaredRootHash: rootHash(canonicalRoot), enabled: true,
      registrationRevision: index + 1, mountGeneration: 0 };
  }).sort((a, b) => a.registrationKey.localeCompare(b.registrationKey));
  const state = { ...v1, format: STATE_FORMAT_V2, ownerRegistrationKey: 'personal.main',
    registrationRevision: 16, registrations };
  await writeState(config.stateDir, state);
  assert.equal((await readState(config.stateDir)).registrations.length, 16);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) > 16_384);
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
    new Map([['OPENAI_API_KEY', 'key']]));
  delete process.env.HOSTEDCTL_TEST_LEAK;
  assert.equal(env.HOSTEDCTL_TEST_LEAK, undefined);
  assert.equal(env.HOME, '/home/agent');
  assert.equal(env.OPENAI_API_KEY, 'key');
  // The Claude token reaches Owner only as nativeProviders.anthropic.oauthTokenFile.
  assert.throws(() => ownerEnvironment(config, '/x', new Map([['CLAUDE_CODE_OAUTH_TOKEN', 't']])),
    /provider-env-key-not-allowed:CLAUDE_CODE_OAUTH_TOKEN/);
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

test('nativeProviders keeps Owner order and never points into the Claude root', () => {
  const parsed = parseNativeProviders({
    codex: { codexCliPath: '/usr/local/bin/codex', codexHome: '/home/agent/.codex' },
    anthropic: { oauthTokenFile: '/home/agent/.claude-oauth-token' },
  }, '/srv/claude');
  assert.equal(JSON.stringify(parsed), JSON.stringify({
    anthropic: { oauthTokenFile: '/home/agent/.claude-oauth-token' },
    codex: { codexHome: '/home/agent/.codex', codexCliPath: '/usr/local/bin/codex' },
  }));
  assert.equal(parseNativeProviders(undefined, '/srv/claude'), null);
  assert.throws(() => parseNativeProviders({}, '/srv/claude'), /native-providers-invalid/);
  assert.throws(() => parseNativeProviders({ anthropic: { oauthTokenFile: '/srv/claude/token' } }, '/srv/claude'),
    /native-path-inside-claude-root/);
  assert.throws(() => parseNativeProviders({ anthropic: { oauthTokenFile: '/home/a/../token' } }, '/srv/claude'),
    /must-be-absolute-normalized-path/);
});
