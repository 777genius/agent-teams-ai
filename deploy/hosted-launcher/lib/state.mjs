import { randomBytes } from 'node:crypto';
import { open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile, pathExists, readRegularFile } from './fsutil.mjs';

export const STATE_FORMAT = 'agent-teams.hosted-launcher.state/v1';
const STATE_KEYS = ['format', 'deploymentId', 'workspaceId', 'ownerAuthority', 'restoreGeneration',
  'ownerGeneration', 'mountGeneration', 'idleTeam', 'desiredTeam', 'updatedAt'];
const TEAM_KEYS = ['teamId', 'legacyKey'];

export const DEPLOYMENT_ID = /^[a-z][a-z0-9-]*_[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
export const WORKSPACE_ID = /^workspace_[0-9a-f]{32}$/u;
export const OWNER_AUTHORITY = /^owner-authority_[0-9a-f]{24}$/u;
export const TEAM_ID = /^team_[0-9a-f]{32}$/u;
export const LEGACY_KEY = /^[A-Za-z0-9_-]{1,128}$/u;

const hex = bytes => randomBytes(bytes).toString('hex');
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
  if (!exactKeys(value, STATE_KEYS) || value.format !== STATE_FORMAT ||
      !DEPLOYMENT_ID.test(value.deploymentId) || !WORKSPACE_ID.test(value.workspaceId) ||
      !OWNER_AUTHORITY.test(value.ownerAuthority) || !generation(value.restoreGeneration) ||
      !generation(value.ownerGeneration) || !generation(value.mountGeneration) ||
      typeof value.updatedAt !== 'string') {
    throw new Error('hostedctl-state-invalid');
  }
  return Object.freeze({ ...value, idleTeam: parseTeam(value.idleTeam, false),
    desiredTeam: parseTeam(value.desiredTeam, true) });
}

/**
 * Deployment, workspace and owner-authority identities are created once. Product binds its
 * personal database to the deployment id and pins the owner authority in its high-water volume,
 * so none of them may change for the life of the deployment.
 */
export function initialState({ deploymentId = `deployment_${hex(12)}`, now = new Date() } = {}) {
  return parseState({
    format: STATE_FORMAT, deploymentId, workspaceId: `workspace_${hex(16)}`,
    ownerAuthority: `owner-authority_${hex(12)}`, restoreGeneration: 0,
    ownerGeneration: 0, mountGeneration: 0,
    // Product only becomes ready with a live Owner. Until the operator publishes a team, Owner
    // serves this empty placeholder team, as the E2E issuer does before its first rotation.
    idleTeam: { teamId: `team_${hex(16)}`, legacyKey: `hosted-idle_${hex(8)}` },
    desiredTeam: null, updatedAt: now.toISOString(),
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
  return parseState({ ...state, ownerGeneration, mountGeneration, updatedAt: now.toISOString() });
}

export const activeTeam = state => state.desiredTeam ?? state.idleTeam;

const statePath = directory => join(directory, 'state.json');

export async function readState(directory) {
  const bytes = await readRegularFile(statePath(directory), { maxBytes: 16_384, mode: 0o600 });
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
        parsed.restoreGeneration < current.restoreGeneration) {
      throw new Error('hostedctl-state-regression-refused');
    }
  }
  await atomicWriteFile(statePath(directory), `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  return parsed;
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
