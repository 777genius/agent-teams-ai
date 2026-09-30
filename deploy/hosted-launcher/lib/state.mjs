import { randomBytes } from 'node:crypto';
import { open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { assertAbsolute, atomicWriteFile, pathExists, readRegularFile } from './fsutil.mjs';
import { canonicalWorkspaces, MAX_WORKSPACES, MAX_ROOT_BYTES, pinnedV1Root,
  REGISTRATION_KEY, rootHash, rootPinPath, ROOT_PIN_FORMAT } from './workspace-registrations.mjs';

export const STATE_FORMAT = 'agent-teams.hosted-launcher.state/v1';
export const STATE_FORMAT_V2 = 'agent-teams.hosted-launcher.state/v2';
export const MAX_STATE_BYTES = 131_072;
const STATE_KEYS = ['format', 'deploymentId', 'workspaceId', 'ownerAuthority', 'restoreGeneration',
  'ownerGeneration', 'mountGeneration', 'idleTeam', 'desiredTeam', 'updatedAt'];
const STATE_KEYS_V2 = [...STATE_KEYS, 'ownerRegistrationKey', 'registrationRevision', 'registrations'];
const REGISTRATION_KEYS = ['registrationKey', 'workspaceId', 'canonicalRoot', 'declaredRootHash',
  'enabled', 'registrationRevision', 'mountGeneration'];
const TEAM_KEYS = ['teamId', 'legacyKey'];

export const DEPLOYMENT_ID = /^[a-z][a-z0-9-]*_[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
export const WORKSPACE_ID = /^workspace_[0-9a-f]{32}$/u;
export const OWNER_AUTHORITY = /^owner-authority_[0-9a-f]{24}$/u;
export const TEAM_ID = /^team_[0-9a-f]{32}$/u;
export const LEGACY_KEY = /^[A-Za-z0-9_-]{1,128}$/u;

const hex = bytes => randomBytes(bytes).toString('hex');
const compareRegistrationKeys = (a, b) => a.registrationKey < b.registrationKey ? -1 :
  a.registrationKey > b.registrationKey ? 1 : 0;
const exactKeys = (value, keys) => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const generation = value => Number.isSafeInteger(value) && value >= 0;

function parseTeam(value, allowNull) {
  if (value === null && allowNull) return null;
  if (!exactKeys(value, TEAM_KEYS) || !TEAM_ID.test(value.teamId) || !LEGACY_KEY.test(value.legacyKey)) {
    throw new Error('hostedctl-state-team-invalid');
  }
  return Object.freeze({ teamId: value.teamId, legacyKey: value.legacyKey });
}

export function parseState(value) {
  const v2 = value?.format === STATE_FORMAT_V2;
  if (!exactKeys(value, v2 ? STATE_KEYS_V2 : STATE_KEYS) ||
      ![STATE_FORMAT, STATE_FORMAT_V2].includes(value.format) ||
      !DEPLOYMENT_ID.test(value.deploymentId) || !WORKSPACE_ID.test(value.workspaceId) ||
      !OWNER_AUTHORITY.test(value.ownerAuthority) || !generation(value.restoreGeneration) ||
      !generation(value.ownerGeneration) || !generation(value.mountGeneration) ||
      typeof value.updatedAt !== 'string') {
    throw new Error('hostedctl-state-invalid');
  }
  if (!v2) return Object.freeze({ ...value, idleTeam: parseTeam(value.idleTeam, false),
    desiredTeam: parseTeam(value.desiredTeam, true) });
  if (!REGISTRATION_KEY.test(value.ownerRegistrationKey) || !generation(value.registrationRevision) ||
      !Array.isArray(value.registrations) || value.registrations.length < 1 ||
      value.registrations.length > MAX_WORKSPACES) throw new Error('hostedctl-state-registrations-invalid');
  const keys = new Set();
  const ids = new Set();
  const rootHashes = new Set();
  let owner = null;
  const registrations = value.registrations.map(row => {
    if (!exactKeys(row, REGISTRATION_KEYS) || !REGISTRATION_KEY.test(row.registrationKey) ||
        !WORKSPACE_ID.test(row.workspaceId) || typeof row.canonicalRoot !== 'string' ||
        Buffer.byteLength(row.canonicalRoot) > MAX_ROOT_BYTES ||
        rootHash(row.canonicalRoot) !== row.declaredRootHash || typeof row.enabled !== 'boolean' ||
        !generation(row.registrationRevision) || row.registrationRevision < 1 ||
        row.registrationRevision > value.registrationRevision || !generation(row.mountGeneration) ||
        row.mountGeneration > value.mountGeneration || keys.has(row.registrationKey) ||
        ids.has(row.workspaceId) || rootHashes.has(row.declaredRootHash)) {
      throw new Error('hostedctl-state-registration-invalid');
    }
    keys.add(row.registrationKey);
    ids.add(row.workspaceId);
    rootHashes.add(row.declaredRootHash);
    assertAbsolute(row.canonicalRoot, 'state-workspace-root');
    if (row.registrationKey === value.ownerRegistrationKey) owner = row;
    return Object.freeze({ ...row });
  });
  if (!owner || owner.workspaceId !== value.workspaceId || !owner.enabled ||
      JSON.stringify([...keys].sort()) !== JSON.stringify([...keys])) {
    throw new Error('hostedctl-state-owner-registration-invalid');
  }
  return Object.freeze({ ...value, registrations: Object.freeze(registrations),
    idleTeam: parseTeam(value.idleTeam, false), desiredTeam: parseTeam(value.desiredTeam, true) });
}

/**
 * Deployment, workspace and owner-authority identities are created once. Product binds its
 * personal database to the deployment id and pins the owner authority in its high-water volume,
 * so none of them may change for the life of the deployment.
 */
export function initialState({ deploymentId = `deployment_${hex(12)}`, now = new Date(),
  ownerRegistrationKey, workspaces } = {}) {
  if ((ownerRegistrationKey === undefined) !== (workspaces === undefined)) {
    throw new Error('hostedctl-initial-registrations-incomplete');
  }
  const workspaceId = `workspace_${hex(16)}`;
  const registrations = workspaces === undefined ? undefined : [...workspaces]
    .sort(compareRegistrationKeys).map(item => ({
      registrationKey: item.registrationKey,
      workspaceId: item.registrationKey === ownerRegistrationKey ? workspaceId : `workspace_${hex(16)}`,
      canonicalRoot: item.root, declaredRootHash: rootHash(item.root), enabled: true,
      registrationRevision: 1, mountGeneration: 0,
    }));
  return parseState({
    format: registrations === undefined ? STATE_FORMAT : STATE_FORMAT_V2,
    deploymentId, workspaceId,
    ownerAuthority: `owner-authority_${hex(12)}`, restoreGeneration: 0,
    ownerGeneration: 0, mountGeneration: 0,
    // Product only becomes ready with a live Owner. Until the operator publishes a team, Owner
    // serves this empty placeholder team, as the E2E issuer does before its first rotation.
    idleTeam: { teamId: `team_${hex(16)}`, legacyKey: `hosted-idle_${hex(8)}` },
    desiredTeam: null, updatedAt: now.toISOString(),
    ...(registrations === undefined ? {} : { ownerRegistrationKey, registrationRevision: 1, registrations }),
  });
}

/**
 * Returns the next session's generations. Both strictly increase; the caller must persist the
 * returned state before any Owner receives them, so a crash can skip a number but never reuse one.
 */
export function allocateSession(state, now = new Date()) {
  const ownerGeneration = state.ownerGeneration + 1;
  const mountGeneration = state.mountGeneration + 1;
  if (!Number.isSafeInteger(ownerGeneration) || !Number.isSafeInteger(mountGeneration)) {
    throw new Error('hostedctl-generation-exhausted');
  }
  return parseState({ ...state, ownerGeneration, mountGeneration, updatedAt: now.toISOString(),
    ...(state.format === STATE_FORMAT_V2 ? { registrations: state.registrations.map(row =>
      row.enabled ? { ...row, mountGeneration } : row) } : {}) });
}

export const activeTeam = state => state.desiredTeam ?? state.idleTeam;

const statePath = directory => join(directory, 'state.json');

export async function readState(directory) {
  const bytes = await readRegularFile(statePath(directory), { maxBytes: MAX_STATE_BYTES, mode: 0o600 });
  return parseState(JSON.parse(bytes.toString('utf8')));
}

export async function stateExists(directory) {
  return pathExists(statePath(directory));
}

/** Refuses to move any generation backwards, even if a caller passes a stale copy. */
export async function writeState(directory, next) {
  const parsed = parseState(next);
  if (await stateExists(directory)) {
    const current = await readState(directory);
    if (current.deploymentId !== parsed.deploymentId || current.workspaceId !== parsed.workspaceId ||
        current.ownerAuthority !== parsed.ownerAuthority ||
        parsed.ownerGeneration < current.ownerGeneration ||
        parsed.mountGeneration < current.mountGeneration ||
        parsed.restoreGeneration < current.restoreGeneration ||
        (current.format === STATE_FORMAT_V2 && parsed.format !== STATE_FORMAT_V2)) {
      throw new Error('hostedctl-state-regression-refused');
    }
    if (current.format === STATE_FORMAT_V2 && parsed.format === STATE_FORMAT_V2) {
      if (parsed.ownerRegistrationKey !== current.ownerRegistrationKey ||
          parsed.registrationRevision < current.registrationRevision) {
        throw new Error('hostedctl-state-regression-refused');
      }
      const nextRows = new Map(parsed.registrations.map(row => [row.registrationKey, row]));
      for (const row of current.registrations) {
        const following = nextRows.get(row.registrationKey);
        if (!following || following.workspaceId !== row.workspaceId ||
            following.canonicalRoot !== row.canonicalRoot ||
            following.declaredRootHash !== row.declaredRootHash ||
            following.registrationRevision < row.registrationRevision ||
            following.mountGeneration < row.mountGeneration ||
            (following.registrationRevision > row.registrationRevision &&
              parsed.registrationRevision <= current.registrationRevision) ||
            (following.enabled !== row.enabled &&
              (following.registrationRevision === row.registrationRevision ||
                following.mountGeneration === row.mountGeneration))) {
          throw new Error('hostedctl-state-registration-retarget-refused');
        }
      }
      if (parsed.ownerGeneration > current.ownerGeneration &&
          parsed.registrations.some(row => row.enabled && row.mountGeneration !== parsed.mountGeneration)) {
        throw new Error('hostedctl-state-enabled-mount-generation-invalid');
      }
      const oldIds = new Set(current.registrations.map(row => row.workspaceId));
      if (parsed.registrations.some(row => !current.registrations.some(old => old.registrationKey === row.registrationKey) &&
          (oldIds.has(row.workspaceId) || row.registrationRevision <= current.registrationRevision))) {
        throw new Error('hostedctl-state-registration-retarget-refused');
      }
    }
    if (current.format === STATE_FORMAT && parsed.format === STATE_FORMAT_V2) {
      const pin = JSON.parse((await readRegularFile(rootPinPath(directory), { maxBytes: 8192,
        uid: process.getuid?.() ?? 0, mode: 0o600 })).toString('utf8'));
      const owner = parsed.registrations.find(row => row.registrationKey === 'personal.main');
      if (pin.format !== ROOT_PIN_FORMAT || pin.deploymentId !== current.deploymentId ||
          pin.workspaceId !== current.workspaceId || pin.canonicalRoot !== owner?.canonicalRoot ||
          pin.declaredRootHash !== owner.declaredRootHash ||
          parsed.ownerRegistrationKey !== 'personal.main' ||
          parsed.ownerGeneration !== current.ownerGeneration ||
          parsed.mountGeneration !== current.mountGeneration ||
          parsed.restoreGeneration !== current.restoreGeneration) {
        throw new Error('hostedctl-state-root-pin-mismatch');
      }
    }
  }
  const bytes = `${JSON.stringify(parsed, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > MAX_STATE_BYTES) throw new Error('hostedctl-state-size-exceeded');
  await atomicWriteFile(statePath(directory), bytes, { mode: 0o600 });
  return parsed;
}

/** Reconcile operator registrations under state.lock before issuing a new session. */
export async function reconcileWorkspaces(directory, config, state, key) {
  const { ownerRegistrationKey, workspaces } = await canonicalWorkspaces(config);
  let next = state;
  if (state.format === STATE_FORMAT) {
    const pin = await pinnedV1Root(directory, config, state, key);
    next = parseState({ ...state, format: STATE_FORMAT_V2, ownerRegistrationKey: 'personal.main',
      registrationRevision: 1, registrations: [{ registrationKey: 'personal.main',
        workspaceId: state.workspaceId, canonicalRoot: pin.canonicalRoot,
        declaredRootHash: pin.declaredRootHash, enabled: true, registrationRevision: 1,
        mountGeneration: state.mountGeneration }] });
    next = await writeState(directory, next);
  }
  if (next.ownerRegistrationKey !== ownerRegistrationKey) throw new Error('hostedctl-owner-registration-key-changed');
  const configured = new Map(workspaces.map(item => [item.registrationKey, item]));
  let revision = next.registrationRevision;
  let generation = next.mountGeneration;
  const rows = next.registrations.map(row => {
    const item = configured.get(row.registrationKey);
    configured.delete(row.registrationKey);
    if (item && item.root !== row.canonicalRoot) throw new Error(`hostedctl-workspace-key-retarget-refused:${row.registrationKey}`);
    const enabled = Boolean(item);
    if (enabled === row.enabled) return row;
    revision += 1;
    generation += 1;
    if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(generation)) throw new Error('hostedctl-generation-exhausted');
    return { ...row, enabled, registrationRevision: revision, mountGeneration: generation };
  });
  for (const item of [...configured.values()].sort(compareRegistrationKeys)) {
    if (rows.length >= MAX_WORKSPACES) throw new Error('hostedctl-workspace-registration-capacity-exhausted');
    revision += 1;
    generation += 1;
    rows.push({ registrationKey: item.registrationKey, workspaceId: `workspace_${hex(16)}`,
      canonicalRoot: item.root, declaredRootHash: rootHash(item.root), enabled: true,
      registrationRevision: revision, mountGeneration: generation });
  }
  if (revision === next.registrationRevision) return next;
  rows.sort(compareRegistrationKeys);
  return writeState(directory, parseState({ ...next, registrationRevision: revision,
    mountGeneration: generation, registrations: rows, updatedAt: new Date().toISOString() }));
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** An exclusive pid file. A file left by a dead process is taken over. */
export async function acquirePidLock(path) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return { path, release: () => rm(path, { force: true }) };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = await readLockHolder(path);
      if (holder !== null && processAlive(holder)) {
        const busy = new Error(`hostedctl-lock-held:${path}:${holder}`);
        busy.holder = holder;
        throw busy;
      }
      await rm(path, { force: true });
    }
  }
  throw new Error(`hostedctl-lock-unavailable:${path}`);
}

export async function readLockHolder(path) {
  const text = await readFile(path, 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  const pid = Number(text?.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export async function liveLockHolder(path) {
  const pid = await readLockHolder(path);
  return pid !== null && processAlive(pid) ? pid : null;
}

/** Serializes short state read-modify-write sections between hostedctl invocations. */
export async function withStateLock(directory, task, { retries = 50, delayMs = 100 } = {}) {
  let lock;
  for (let attempt = 0; !lock; attempt += 1) {
    try { lock = await acquirePidLock(join(directory, 'state.lock')); }
    catch (error) {
      if (error.holder === undefined || attempt >= retries) throw error;
      await new Promise(resolveDelay => setTimeout(resolveDelay, delayMs));
    }
  }
  try { return await task(); } finally { await lock.release(); }
}
