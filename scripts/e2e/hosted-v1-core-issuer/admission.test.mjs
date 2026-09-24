import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createServer } from 'node:net';
import { chown, chmod, lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { parseWorkspaceId } from '../../../src/shared/contracts/hosted/identifiers.ts';
import { createCoreIdentity, publishCoreAdmission } from './admission.mjs';

const image = Object.freeze({
  ownerArtifactDigest: `sha256:${'a'.repeat(64)}`,
  ownerExecutableDigest: `sha256:${'b'.repeat(64)}`,
  imageReference: `127.0.0.1:5000/core-owner@sha256:${'a'.repeat(64)}`,
});

test('default sandbox workspace identity satisfies the Product canonical parser throughout bootstrap', () => {
  const identity = createCoreIdentity({ image });
  const bootstrap = JSON.parse(identity.bootstrap);
  assert.equal(parseWorkspaceId(identity.workspaceId), identity.workspaceId);
  assert.equal(parseWorkspaceId(bootstrap.workspaceId), identity.workspaceId);
  assert.equal(parseWorkspaceId(bootstrap.workspaceManifest.registrations[0].workspaceId), identity.workspaceId);
  assert.equal(parseWorkspaceId(identity.bootstrapBinding.workspaceId), identity.workspaceId);
  assert.throws(() => createCoreIdentity({ image, workspaceId: `workspace_${'a'.repeat(24)}` }),
    /identity-input-invalid/u);
});

test('signed sandbox app-data root matches the production personal service storage root', async () => {
  const compose = parse(await readFile(new URL('../../../docker/docker-compose.yml', import.meta.url), 'utf8'));
  const authDataDir = compose.services['agent-teams-personal'].environment.AUTH_DATA_DIR;
  const identity = createCoreIdentity({ image });
  const bootstrap = JSON.parse(identity.bootstrap);
  assert.equal(bootstrap.runtimeInstance.appDataRoot.reference, authDataDir);
  assert.equal(bootstrap.runtimeInstance.logsRoot.reference, `${authDataDir}/logs`);
  assert.equal(identity.bootstrapBinding.bootstrapDigest,
    createHash('sha256').update(identity.bootstrap).digest('hex'));
});

test('signs v3 admission for the observed live socket with separate image and executable identities', async () => {
  const root = await mkdtemp('/tmp/core-issuer-admission-');
  const runDirectory = join(root, 'run');
  const trustDirectory = join(root, 'trust');
  const socketPath = join(runDirectory, 'owner.sock');
  const server = createServer();
  try {
    await mkdir(runDirectory, { mode: 0o700 });
    await chown(runDirectory, process.getuid(), process.getgid());
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
    await chown(socketPath, process.getuid(), process.getgid());
    const identity = createCoreIdentity({ image });
    const output = await publishCoreAdmission({ identity, runDirectory, trustDirectory, socketPath,
      productSocketPath: '/run/agent-teams-orchestrator/orchestrator-lifecycle.sock',
      uid: process.getuid(), gid: process.getgid() });
    const envelope = JSON.parse(await readFile(output.manifestPath, 'utf8'));
    const releasePin = JSON.parse(await readFile(output.releasePinPath, 'utf8'));
    const payload = JSON.parse(envelope.payload);
    const publicKey = createPublicKey({ format: 'jwk', key: {
      kty: 'OKP', crv: 'Ed25519', x: releasePin.launcher.publicKey,
    } });
    assert.equal(envelope.format, 'agent-teams.hosted-lifecycle-owner-admission/v3');
    assert.equal(payload.artifact.imageReference, image.imageReference);
    assert.equal(payload.bootstrapBinding.ownerArtifactDigest, image.ownerArtifactDigest);
    assert.equal(payload.socketPath, '/run/agent-teams-orchestrator/orchestrator-lifecycle.sock');
    assert.equal(payload.approvalAdmission.state, 'provisioning');
    assert.equal(payload.approvalSnapshot, null);
    assert.equal(payload.ownerBinding.socketIdentity.inode, (await lstat(socketPath, { bigint: true })).ino.toString());
    assert.equal(releasePin.launcher.keyId, createHash('sha256').update(Buffer.from(releasePin.launcher.publicKey, 'base64url')).digest('hex'));
    assert.ok(verify(null, Buffer.from(`${envelope.format}\0${envelope.payload}`), publicKey,
      Buffer.from(envelope.authentication.signature, 'base64url')));
    assert.equal((await lstat(output.manifestPath)).mode & 0o777, 0o400);
    assert.equal((await lstat(output.trustAnchorPath)).mode & 0o777, 0o400);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses image identity substituted with executable hash', () => {
  assert.throws(() => createCoreIdentity({ image: {
    ...image, ownerArtifactDigest: image.ownerExecutableDigest,
    imageReference: `127.0.0.1:5000/core-owner@${image.ownerExecutableDigest}`,
  } }), /image-provenance-required/u);
});
