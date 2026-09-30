import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { TEAM_ID } from './state.mjs';

const DRAFT_KEY = /^draft-[0-9a-f]{32}$/u;
const MARKER_KEYS = ['schemaVersion', 'operationId', 'teamId', 'directoryFingerprint',
  'rootFingerprint', 'teamsFingerprint'].sort();
const IDENTITY_KEYS = ['schemaVersion', 'teamId', 'createdAt', 'originDeploymentId'].sort();

async function readCustodiedFile(path, uid, gid) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(uid) ||
        before.gid !== BigInt(gid) || (before.mode & 0o077n) !== 0n ||
        before.size < 1n || before.size > 65536n) {
      throw new Error('hostedctl-published-team-file-custody-invalid');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (BigInt(bytes.length) !== before.size || before.ino !== after.ino ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error('hostedctl-published-team-file-changed');
    }
    return bytes.toString('utf8');
  } finally { await handle.close(); }
}

/**
 * Accepts only a team Product published for this deployment: the adoption marker and identity
 * file must be byte-canonical and agent-owned, as the E2E rotation requires.
 */
export async function readPublishedTeam(claudeRoot, legacyKey, { deploymentId, uid, gid }) {
  if (!DRAFT_KEY.test(legacyKey)) throw new Error('hostedctl-published-team-key-invalid');
  const directory = join(claudeRoot, 'teams', legacyKey);
  const entry = await lstat(directory, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== BigInt(uid) ||
      entry.gid !== BigInt(gid) || (entry.mode & 0o077n) !== 0n) {
    throw new Error('hostedctl-published-team-directory-custody-invalid');
  }
  const markerBytes = await readCustodiedFile(join(directory, '.hosted-draft-publication.json'), uid, gid);
  const identityBytes = await readCustodiedFile(join(directory, 'team.identity.json'), uid, gid);
  const marker = JSON.parse(markerBytes);
  const identity = JSON.parse(identityBytes);
  if (JSON.stringify(Object.keys(marker).sort()) !== JSON.stringify(MARKER_KEYS) ||
      marker.schemaVersion !== 1 || marker.operationId !== `adoption_${legacyKey.slice(6)}` ||
      !TEAM_ID.test(marker.teamId) || markerBytes !== `${JSON.stringify(marker)}\n` ||
      JSON.stringify(Object.keys(identity).sort()) !== JSON.stringify(IDENTITY_KEYS) ||
      identity.schemaVersion !== 1 || identity.teamId !== marker.teamId ||
      identity.originDeploymentId !== deploymentId || !Number.isFinite(Date.parse(identity.createdAt)) ||
      identityBytes !== `${JSON.stringify(identity, null, 2)}\n`) {
    throw new Error('hostedctl-published-team-identity-mismatch');
  }
  return Object.freeze({ teamId: marker.teamId, legacyKey, createdAt: identity.createdAt });
}

/** Lists every valid published team; invalid directories are reported, not trusted. */
export async function listPublishedTeams(claudeRoot, options) {
  const names = await readdir(join(claudeRoot, 'teams')).catch(error =>
    error.code === 'ENOENT' ? [] : Promise.reject(error));
  const teams = [];
  const rejected = [];
  for (const name of names.filter(candidate => DRAFT_KEY.test(candidate)).sort()) {
    try { teams.push(await readPublishedTeam(claudeRoot, name, options)); }
    catch (error) { rejected.push({ legacyKey: name, reason: error.message }); }
  }
  return { teams, rejected };
}

/** Resolves `switch-team <teamId>` to exactly one published directory. */
export async function resolvePublishedTeam(claudeRoot, teamId, options) {
  if (!TEAM_ID.test(teamId ?? '')) throw new Error('hostedctl-team-id-invalid');
  const { teams } = await listPublishedTeams(claudeRoot, options);
  const matches = teams.filter(team => team.teamId === teamId);
  if (matches.length !== 1) throw new Error(`hostedctl-published-team-not-unique:${matches.length}`);
  return matches[0];
}
