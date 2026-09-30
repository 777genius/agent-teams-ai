import { createPublicKey, verify } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnvFile } from './config.mjs';
import { assertAbsolute, atomicWriteFile, ensureDirectory, pathExists, readRegularFile, sha256 } from './fsutil.mjs';

export const MAX_WORKSPACES = 16;
export const MAX_ROOT_BYTES = 2048;
export const REGISTRATION_KEY = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
export const ROOT_PIN_FORMAT = 'agent-teams.hosted-launcher.root-pin/v1';
const BOOTSTRAP_FORMAT = 'agent-teams.team-lifecycle-read-bootstrap/v1';
const ADMISSION_FORMAT = 'agent-teams.hosted-lifecycle-owner-admission/v3';
const ADMISSION_PAYLOAD_FORMAT = 'agent-teams.hosted-lifecycle-owner-admission-payload/v3';

export const rootHash = root => sha256(Buffer.from(root));
export const rootPinPath = directory => join(directory, 'workspace-root-pin.json');

export function configuredWorkspaces(config) {
  if (config.workspaces !== undefined && config.ownerRegistrationKey === undefined) {
    throw new Error('hostedctl-owner-registration-key-required');
  }
  const workspaces = config.workspaces ?? [{ registrationKey: 'personal.main', root: config.workspaceRoot }];
  const ownerRegistrationKey = config.ownerRegistrationKey ?? 'personal.main';
  if (!Array.isArray(workspaces) || workspaces.length < 1 || workspaces.length > MAX_WORKSPACES ||
      !REGISTRATION_KEY.test(ownerRegistrationKey)) throw new Error('hostedctl-workspaces-invalid');
  const seen = new Set();
  for (const item of workspaces) {
    if (!item || Object.keys(item).sort().join(',') !== 'registrationKey,root' ||
        !REGISTRATION_KEY.test(item.registrationKey) || seen.has(item.registrationKey) ||
        typeof item.root !== 'string' || Buffer.byteLength(item.root) > MAX_ROOT_BYTES ||
        /[\u0000-\u001f\u007f]/u.test(item.root)) {
      throw new Error('hostedctl-workspaces-invalid');
    }
    assertAbsolute(item.root, 'workspace-root');
    seen.add(item.registrationKey);
  }
  const owner = workspaces.find(item => item.registrationKey === ownerRegistrationKey);
  if (!owner || (config.workspaceRoot !== undefined && owner.root !== config.workspaceRoot)) {
    throw new Error('hostedctl-owner-workspace-root-invalid');
  }
  return { ownerRegistrationKey, workspaces };
}

/** Validate existing roots without modifying their ownership or permissions. */
export async function canonicalWorkspaces(config) {
  const { ownerRegistrationKey, workspaces } = configuredWorkspaces(config);
  const canonical = [];
  const roots = new Set();
  for (const item of workspaces) {
    const entry = await lstat(item.root);
    if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(item.root) !== item.root ||
        roots.has(item.root)) throw new Error(`hostedctl-workspace-root-not-canonical:${item.registrationKey}`);
    roots.add(item.root);
    canonical.push(item);
  }
  return { ownerRegistrationKey, workspaces: canonical };
}

/** Legacy single-root init provisions its managed directory; explicit registrations are existing roots. */
export async function prepareWorkspacesForInit(config) {
  if (config.provisionLegacyWorkspaceRoot === true) {
    await ensureDirectory(config.workspaceRoot, { uid: config.agent.uid, gid: config.agent.gid, mode: 0o700 });
  }
  return canonicalWorkspaces(config);
}

function recovery(reason) {
  // Operator recovery: stop the service, restore the original state.json and session.env from a
  // trusted stateDir backup, and configure the original root before retrying. Never reset the
  // counters, invent a root, or replace an established registration key to make this pass.
  throw new Error(`hostedctl-v1-root-evidence-${reason}:restore-matching-state-and-session-env-backup`);
}

function parseBootstrap(text, state, root) {
  let bootstrap;
  try { bootstrap = JSON.parse(text); } catch { recovery('corrupt'); }
  const row = bootstrap?.workspaceManifest?.registrations;
  if (bootstrap?.format !== BOOTSTRAP_FORMAT || bootstrap.deploymentId !== state.deploymentId ||
      bootstrap.workspaceId !== state.workspaceId || !Array.isArray(row) || row.length !== 1 ||
      row[0]?.registrationKey !== 'personal.main' || row[0]?.workspaceId !== state.workspaceId ||
      row[0]?.declaredRootHash !== rootHash(root)) {
    recovery('mismatch');
  }
  const generation = row[0].mountBinding?.mountGeneration;
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > state.mountGeneration ||
      row[0].schemaVersion !== 1 || row[0].enabled !== true ||
      row[0].mountBinding.bootId !== bootstrap.bootId ||
      bootstrap.runtimeInstance?.deploymentId !== state.deploymentId ||
      bootstrap.runtimeInstance?.bootId !== bootstrap.bootId ||
      bootstrap.runtimeInstance?.workspaceRoots?.length !== 1 ||
      bootstrap.runtimeInstance.workspaceRoots[0]?.kind !== 'workspace' ||
      bootstrap.runtimeInstance.workspaceRoots[0]?.reference !== root) recovery('mismatch');
  return { bootstrap, generation };
}

async function verifyAvailableAdmission(config, env, bootstrap, state, key) {
  const runDirectory = env.get('HOSTED_LIFECYCLE_ORCHESTRATOR_RUN_DIR');
  if (typeof runDirectory !== 'string' || !runDirectory.startsWith(`${config.runDir}/owner-g`) ||
      !/^owner-g[1-9][0-9]*$/u.test(runDirectory.slice(config.runDir.length + 1))) recovery('mismatch');
  const ownerGeneration = Number(runDirectory.slice(config.runDir.length + '/owner-g'.length));
  if (!Number.isSafeInteger(ownerGeneration) || ownerGeneration > state.ownerGeneration) recovery('mismatch');
  if (!await pathExists(runDirectory)) return;
  const run = await lstat(runDirectory);
  if (!run.isDirectory() || run.isSymbolicLink() || run.uid !== config.agent.uid ||
      (run.mode & 0o777) !== 0o700) recovery('admission-directory-invalid');
  const path = join(runDirectory, 'lifecycle-owner-admission.json');
  if (!await pathExists(path)) recovery('admission-missing');
  if (!key?.publicKey) recovery('admission-key-missing');
  let admission;
  try {
    admission = JSON.parse((await readRegularFile(path, { maxBytes: 65_536,
      uid: config.agent.uid, mode: 0o400 })).toString('utf8'));
  } catch { recovery('admission-corrupt'); }
  let payload;
  try { payload = JSON.parse(admission.payload); } catch { recovery('admission-corrupt'); }
  const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.publicKey }, format: 'jwk' });
  if (admission.format !== ADMISSION_FORMAT || admission.authentication?.algorithm !== 'ed25519' ||
      admission.authentication?.launcherKeyId !== key.keyId ||
      !verify(null, Buffer.from(`${ADMISSION_FORMAT}\0${admission.payload}`), publicKey,
        Buffer.from(admission.authentication?.signature ?? '', 'base64url')) ||
      payload?.format !== ADMISSION_PAYLOAD_FORMAT ||
      payload?.ownerBinding?.ownerGeneration !== ownerGeneration ||
      payload?.bootstrapBinding?.deploymentId !== bootstrap.deploymentId ||
      payload?.bootstrapBinding?.bootId !== bootstrap.bootId ||
      payload?.bootstrapBinding?.workspaceId !== bootstrap.workspaceId ||
      payload?.bootstrapBinding?.mountGeneration !== bootstrap.workspaceManifest.registrations[0].mountBinding.mountGeneration ||
      payload?.bootstrapBinding?.bootstrapDigest !== sha256(Buffer.from(env.get('AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP')))) {
    recovery('admission-mismatch');
  }
}

/** Called under the existing state lock, before any new generation is allocated. */
export async function pinnedV1Root(directory, config, state, key) {
  const { workspaces, ownerRegistrationKey } = await canonicalWorkspaces(config);
  if (ownerRegistrationKey !== 'personal.main') recovery('owner-key-changed');
  const root = workspaces.find(item => item.registrationKey === 'personal.main').root;
  const path = rootPinPath(directory);
  if (await pathExists(path)) {
    let pin;
    try { pin = JSON.parse((await readRegularFile(path, { maxBytes: 8192,
      uid: process.getuid?.() ?? 0, mode: 0o600 })).toString('utf8')); }
    catch { recovery('pin-corrupt'); }
    if (!pin || typeof pin !== 'object' || Array.isArray(pin) || Object.keys(pin).sort().join(',') !==
        'canonicalRoot,declaredRootHash,deploymentId,format,mountGeneration,workspaceId' ||
        pin.format !== ROOT_PIN_FORMAT || pin.deploymentId !== state.deploymentId ||
        pin.workspaceId !== state.workspaceId || pin.canonicalRoot !== root ||
        pin.declaredRootHash !== rootHash(root) || !Number.isSafeInteger(pin.mountGeneration) ||
        pin.mountGeneration < 0 || pin.mountGeneration > state.mountGeneration) recovery('pin-mismatch');
    return pin;
  }
  let evidenceGeneration = 0;
  const sessionPath = join(directory, 'session.env');
  if (state.mountGeneration === 0 && state.ownerGeneration !== 0) recovery('mismatch');
  if (state.mountGeneration > 0 && await pathExists(sessionPath)) {
    let env;
    try { env = parseEnvFile((await readRegularFile(sessionPath, { maxBytes: 65_536,
      uid: process.getuid?.() ?? 0, mode: 0o600 })).toString('utf8')); }
    catch { recovery('session-corrupt'); }
    const text = env.get('AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP');
    if (!text) recovery('session-corrupt');
    const { bootstrap, generation } = parseBootstrap(text, state, root);
    if (env.get('AUTH_DEPLOYMENT_ID') !== state.deploymentId ||
        env.get('HOSTED_WORKSPACE_IDS') !== state.workspaceId ||
        env.get('HOSTED_WORKSPACE_ROOT') !== root ||
        env.get('AUTH_RESTORE_GENERATION') !== String(state.restoreGeneration)) recovery('mismatch');
    await verifyAvailableAdmission(config, env, bootstrap, state, key);
    // This proves issuance and root binding only. session.env is written before Product start,
    // so it cannot prove that the session became healthy or served any request.
    evidenceGeneration = generation;
  } else if (state.mountGeneration !== 0 || state.ownerGeneration !== 0) recovery('missing');
  const pin = { format: ROOT_PIN_FORMAT, deploymentId: state.deploymentId,
    workspaceId: state.workspaceId, canonicalRoot: root, declaredRootHash: rootHash(root),
    mountGeneration: evidenceGeneration };
  await atomicWriteFile(path, `${JSON.stringify(pin)}\n`, { mode: 0o600 });
  return pin;
}
