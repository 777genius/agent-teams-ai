import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { chown, chmod, lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

const ADMISSION = 'agent-teams.hosted-lifecycle-owner-admission/v3';
const PAYLOAD = 'agent-teams.hosted-lifecycle-owner-admission-payload/v3';
const RELEASE_PIN = 'agent-teams.hosted-lifecycle-owner-release-pin/v2';
const BOOTSTRAP = 'agent-teams.team-lifecycle-read-bootstrap/v1';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const id = prefix => `${prefix}_${randomBytes(12).toString('hex')}`;

function assertImage(image) {
  if (!image || !/^sha256:[0-9a-f]{64}$/u.test(image.ownerArtifactDigest) ||
      !image.imageReference?.endsWith(`@${image.ownerArtifactDigest}`) ||
      !/^sha256:[0-9a-f]{64}$/u.test(image.ownerExecutableDigest) ||
      image.ownerArtifactDigest === image.ownerExecutableDigest) {
    throw new Error('core-issuer-image-provenance-required');
  }
}

export function createCoreIdentity({ image, claudeRoot = '/data/.claude', appDataRoot = '/data/.agent-teams/data',
  workspaceRoot = '/workspaces/sandbox', restoreGeneration = 0, mountGeneration = 1,
  deploymentId = id('deployment'), workspaceId = `workspace_${randomBytes(16).toString('hex')}`,
  teamId = `team_${randomBytes(16).toString('hex')}`,
  ownerGeneration = 1, ownerAuthority = id('owner-authority') } = {}) {
  assertImage(image);
  if (!/^team_[0-9a-f]{32}$/u.test(teamId) || !/^[a-z][a-z0-9-]*_[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(deploymentId) ||
      !/^workspace_[0-9a-f]{32}$/u.test(workspaceId) ||
      !/^owner-authority_[0-9a-f]{24}$/u.test(ownerAuthority) ||
      !Number.isSafeInteger(ownerGeneration) || ownerGeneration < 1) {
    throw new Error('core-issuer-identity-input-invalid');
  }
  const secret = randomBytes(32);
  const signing = generateKeyPairSync('ed25519');
  const jwk = signing.publicKey.export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new Error('core-issuer-ed25519-public-key-invalid');
  }
  const launcherKeyId = sha256(Buffer.from(jwk.x, 'base64url'));
  const bootId = id('boot');
  const ownerSessionId = id('owner-session');
  const declaredRootHash = sha256(Buffer.from(workspaceRoot));
  const bootstrap = JSON.stringify({
    format: BOOTSTRAP, issuedAtMs: Date.now(), expiresAtMs: Date.now() + 60 * 60_000,
    actorId: id('actor'), authorizedScope: 'scope_team-lifecycle.read',
    deploymentId, bootId, workspaceId,
    runtimeInstance: {
      deploymentId, bootId,
      claudeRoot: { kind: 'claude', reference: claudeRoot },
      appDataRoot: { kind: 'app-data', reference: appDataRoot },
      workspaceRoots: [{ kind: 'workspace', reference: workspaceRoot }],
      tempRoot: { kind: 'temp', reference: '/tmp' },
      logsRoot: { kind: 'logs', reference: `${appDataRoot}/logs` },
    },
    workspaceManifest: { version: 1, registrations: [{
      schemaVersion: 1, registrationKey: 'core-issuer.sandbox', workspaceId,
      displayName: 'Core issuer sandbox', registrationRevision: 1, declaredRootHash,
      enabled: true, mountBinding: { bootId, mountGeneration, observedAt: Date.now(),
        health: 'healthy', allowedOperations: [] },
    }] },
  });
  const bootstrapBinding = {
    deploymentId, bootId, workspaceId, mountGeneration,
    bootstrapDigest: sha256(Buffer.from(bootstrap)),
    ownerArtifactDigest: image.ownerArtifactDigest,
    proofKeyId: sha256(secret),
  };
  const artifact = { artifactDigest: image.ownerArtifactDigest,
    imageReference: image.imageReference, artifactVersion: '0.0.1-sandbox', protocolVersion: 2 };
  const releasePin = {
    format: RELEASE_PIN, artifact,
    launcher: { algorithm: 'ed25519', publicKey: jwk.x, keyId: launcherKeyId },
  };
  return { secret, signingKey: signing.privateKey, launcherKeyId, artifact,
    releasePin, bootstrap, bootstrapBinding, deploymentId, bootId, workspaceId, teamId,
    ownerAuthority, ownerSessionId, declaredRootHash, mountGeneration, restoreGeneration,
    ownerGeneration };
}

export async function observedOwnerSocket(socketPath, uid, gid) {
  const entry = await lstat(socketPath, { bigint: true });
  const identity = { device: entry.dev.toString(), inode: entry.ino.toString(),
    uid: Number(entry.uid), gid: Number(entry.gid), mode: Number(entry.mode & 0o777n) };
  if (!entry.isSocket() || entry.isSymbolicLink() || identity.uid !== uid ||
      identity.gid !== gid || identity.mode !== 0o600) {
    throw new Error('core-issuer-owner-socket-identity-invalid');
  }
  return identity;
}

async function privateDirectory(path, uid, gid) {
  await mkdir(path, { recursive: false, mode: 0o700 });
  await chown(path, uid, gid);
  await chmod(path, 0o700);
}

async function privateFile(path, bytes, uid, gid) {
  const handle = await open(path, 'wx', 0o400);
  try { await handle.writeFile(bytes); await handle.chown(uid, gid); await handle.chmod(0o400); await handle.sync(); }
  finally { await handle.close(); }
}

export async function publishCoreAdmission({ identity, runDirectory, trustDirectory, socketPath,
  productSocketPath = socketPath, uid = 1000, gid = 1000 }) {
  if (!identity?.signingKey || !identity?.secret || !identity.imageReference &&
      !identity.artifact?.imageReference) throw new Error('core-issuer-identity-invalid');
  const socketIdentity = await observedOwnerSocket(socketPath, uid, gid);
  const ownerBinding = { ownerAuthority: identity.ownerAuthority,
    ownerGeneration: identity.ownerGeneration, ownerSessionId: identity.ownerSessionId, socketIdentity };
  const payload = JSON.stringify({
    format: PAYLOAD, artifact: identity.artifact, ownerBinding,
    bootstrapBinding: identity.bootstrapBinding, socketPath: productSocketPath,
    approvalAdmission: { state: 'provisioning' }, approvalSnapshot: null,
  });
  const signature = sign(null, Buffer.from(`${ADMISSION}\0${payload}`), identity.signingKey).toString('base64url');
  const manifest = `${JSON.stringify({ format: ADMISSION, payload,
    authentication: { algorithm: 'ed25519', launcherKeyId: identity.launcherKeyId, signature } })}\n`;
  const pin = `${JSON.stringify(identity.releasePin)}\n`;
  await privateDirectory(trustDirectory, uid, gid);
  await privateFile(join(trustDirectory, 'trust-anchor'), `${identity.secret.toString('hex')}\n`, uid, gid);
  await privateFile(join(trustDirectory, 'release-owner-pin.json'), pin, uid, gid);
  // Owner already created the run directory and published this exact socket.
  const run = await lstat(runDirectory);
  if (!run.isDirectory() || run.isSymbolicLink() || run.uid !== uid || run.gid !== gid ||
      (run.mode & 0o777) !== 0o700) throw new Error('core-issuer-run-directory-invalid');
  await privateFile(join(runDirectory, 'lifecycle-owner-admission.json'), manifest, uid, gid);
  const current = await observedOwnerSocket(socketPath, uid, gid);
  if (JSON.stringify(current) !== JSON.stringify(socketIdentity)) {
    throw new Error('core-issuer-socket-changed-during-publication');
  }
  return { ownerBinding, manifestPath: join(runDirectory, 'lifecycle-owner-admission.json'),
    trustAnchorPath: join(trustDirectory, 'trust-anchor'), releasePinPath: join(trustDirectory, 'release-owner-pin.json'),
    bootstrap: identity.bootstrap, imageReference: identity.artifact.imageReference };
}
