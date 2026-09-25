import { randomBytes, sign } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile, sha256 } from './fsutil.mjs';

const ADMISSION = 'agent-teams.hosted-lifecycle-owner-admission/v3';
const PAYLOAD = 'agent-teams.hosted-lifecycle-owner-admission-payload/v3';
const RELEASE_PIN = 'agent-teams.hosted-lifecycle-owner-release-pin/v2';
const BOOTSTRAP = 'agent-teams.team-lifecycle-read-bootstrap/v1';
const OWNER_BOOTSTRAP = 'agent-teams.hosted-control.bootstrap/v1';
const LAUNCHER_LEASE = 'agent-teams.hosted-control.launcher-lease/v1';
const OWNER_PROTOCOL_VERSION = 2;

/** Product sees these container paths; they are fixed by docker/docker-compose.yml. */
export const PRODUCT_SOCKET_PATH = '/run/agent-teams-orchestrator/orchestrator-lifecycle.sock';
export const PRODUCT_CLAUDE_ROOT = '/data/.claude';
export const PRODUCT_APP_DATA_ROOT = '/data/.agent-teams/data';
export const TRUST_ANCHOR_SECRET = 'lifecycle_orchestrator_trust_anchor';
export const RELEASE_PIN_SECRET = 'lifecycle_owner_release_pin.json';
export const ADMISSION_MANIFEST = 'lifecycle-owner-admission.json';

const id = prefix => `${prefix}_${randomBytes(12).toString('hex')}`;

export function ownerArtifact(installed) {
  return Object.freeze({ artifactDigest: installed.artifactDigest,
    imageReference: installed.imageReference, artifactVersion: installed.artifactVersion,
    protocolVersion: OWNER_PROTOCOL_VERSION });
}

export function releasePin(installed, key) {
  return `${JSON.stringify({ format: RELEASE_PIN, artifact: ownerArtifact(installed),
    launcher: { algorithm: 'ed25519', publicKey: key.publicKey, keyId: key.keyId } })}\n`;
}

/**
 * Per-session material. Persistent identities come from launcher state; boot, session, actor and
 * the HMAC proof secret are fresh for every Owner generation.
 */
export function createSessionIdentity({ state, team, installed, workspaceRoot, nowMs = Date.now() }) {
  const secret = randomBytes(32);
  const bootId = id('boot');
  const declaredRootHash = sha256(Buffer.from(workspaceRoot));
  const { deploymentId, workspaceId, mountGeneration } = state;
  const bootstrap = JSON.stringify({
    format: BOOTSTRAP, issuedAtMs: nowMs, expiresAtMs: nowMs + 60 * 60_000,
    actorId: id('actor'), authorizedScope: 'scope_team-lifecycle.read',
    deploymentId, bootId, workspaceId,
    runtimeInstance: {
      deploymentId, bootId,
      claudeRoot: { kind: 'claude', reference: PRODUCT_CLAUDE_ROOT },
      appDataRoot: { kind: 'app-data', reference: PRODUCT_APP_DATA_ROOT },
      workspaceRoots: [{ kind: 'workspace', reference: workspaceRoot }],
      tempRoot: { kind: 'temp', reference: '/tmp' },
      logsRoot: { kind: 'logs', reference: `${PRODUCT_APP_DATA_ROOT}/logs` },
    },
    workspaceManifest: { version: 1, registrations: [{
      schemaVersion: 1, registrationKey: 'personal.main', workspaceId,
      displayName: 'Workspace', registrationRevision: 1, declaredRootHash,
      enabled: true, mountBinding: { bootId, mountGeneration, observedAt: nowMs,
        health: 'healthy', allowedOperations: [] },
    }] },
  });
  const bootstrapBinding = {
    deploymentId, bootId, workspaceId, mountGeneration,
    bootstrapDigest: sha256(Buffer.from(bootstrap)),
    ownerArtifactDigest: installed.artifactDigest,
    proofKeyId: sha256(secret),
  };
  return { secret, bootstrap, bootstrapBinding, bootId, declaredRootHash,
    ownerSessionId: id('owner-session'), ownerGeneration: state.ownerGeneration,
    ownerAuthority: state.ownerAuthority, restoreGeneration: state.restoreGeneration,
    deploymentId, workspaceId, teamId: team.teamId, legacyKey: team.legacyKey };
}

export function launcherLease(identity, installed) {
  return { format: LAUNCHER_LEASE, launcherLeaseId: id('launcher-lease'),
    ownerArtifactDigest: installed.artifactDigest,
    ownerExecutableDigest: installed.executableDigest,
    bootstrapDigest: identity.bootstrapBinding.bootstrapDigest,
    proofKeyId: identity.bootstrapBinding.proofKeyId,
    ownerGeneration: identity.ownerGeneration, ownerSessionId: identity.ownerSessionId };
}

/**
 * The authenticated FD5 header without leaseEvidence and appMcp, which the root spawn helper
 * adds after it has created the sealed lease and verified the MCP files itself.
 */
export function ownerHeader(identity, { claudeRoot, socketPath, runtimeIsolation }) {
  return {
    format: OWNER_BOOTSTRAP, admissionKind: 'core-lifecycle-v1',
    ...(runtimeIsolation ? { runtimeIsolation } : {}),
    restoreGeneration: identity.restoreGeneration, teamId: identity.teamId,
    declaredRootHash: identity.declaredRootHash, ownerAuthority: identity.ownerAuthority,
    ownerGeneration: identity.ownerGeneration, ownerSessionId: identity.ownerSessionId,
    claudeRoot, socketPath, legacyKey: identity.legacyKey,
    bootstrapBinding: identity.bootstrapBinding, leaseEvidence: null,
  };
}

export async function observeOwnerSocket(socketPath, uid, gid) {
  const entry = await lstat(socketPath, { bigint: true });
  const identity = { device: entry.dev.toString(), inode: entry.ino.toString(),
    uid: Number(entry.uid), gid: Number(entry.gid), mode: Number(entry.mode & 0o777n) };
  if (!entry.isSocket() || identity.uid !== uid || identity.gid !== gid || identity.mode !== 0o600) {
    throw new Error('hostedctl-owner-socket-identity-invalid');
  }
  return identity;
}

export function signedAdmission(identity, installed, socketIdentity, key) {
  const payload = JSON.stringify({
    format: PAYLOAD, artifact: ownerArtifact(installed),
    ownerBinding: { ownerAuthority: identity.ownerAuthority, ownerGeneration: identity.ownerGeneration,
      ownerSessionId: identity.ownerSessionId, socketIdentity },
    bootstrapBinding: identity.bootstrapBinding, socketPath: PRODUCT_SOCKET_PATH,
    approvalAdmission: { state: 'provisioning' }, approvalSnapshot: null,
  });
  const signature = sign(null, Buffer.from(`${ADMISSION}\0${payload}`), key.privateKey)
    .toString('base64url');
  return `${JSON.stringify({ format: ADMISSION, payload,
    authentication: { algorithm: 'ed25519', launcherKeyId: key.keyId, signature } })}\n`;
}

/**
 * Publishes the per-session trust material. The trust anchor and pin go to HOSTED_SECRETS_DIR,
 * which Compose hands to the non-root trust initializer; the manifest goes next to the socket.
 */
export async function publishAdmission({ identity, installed, key, runDirectory, socketPath,
  secretsDir, uid, gid }) {
  const socketIdentity = await observeOwnerSocket(socketPath, uid, gid);
  const secretFile = { uid, gid, mode: 0o400 };
  await atomicWriteFile(join(secretsDir, TRUST_ANCHOR_SECRET),
    `${identity.secret.toString('hex')}\n`, secretFile);
  await atomicWriteFile(join(secretsDir, RELEASE_PIN_SECRET), releasePin(installed, key), secretFile);
  const run = await lstat(runDirectory);
  if (!run.isDirectory() || run.isSymbolicLink() || run.uid !== uid || run.gid !== gid ||
      (run.mode & 0o777) !== 0o700) throw new Error('hostedctl-owner-run-directory-invalid');
  const handle = await open(join(runDirectory, ADMISSION_MANIFEST), 'wx', 0o400);
  try {
    await handle.writeFile(signedAdmission(identity, installed, socketIdentity, key));
    await handle.chown(uid, gid);
    await handle.chmod(0o400);
    await handle.sync();
  } finally { await handle.close(); }
  const current = await observeOwnerSocket(socketPath, uid, gid);
  if (JSON.stringify(current) !== JSON.stringify(socketIdentity)) {
    throw new Error('hostedctl-owner-socket-changed-during-publication');
  }
  return socketIdentity;
}
