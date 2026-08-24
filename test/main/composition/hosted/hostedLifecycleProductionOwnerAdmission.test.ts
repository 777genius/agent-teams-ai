import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { HOSTED_LIFECYCLE_OWNER_GENERATION_LIMIT } from '../../../../src/main/composition/hosted/hostedLifecycleOwnerHighWaterBinding';
import {
  admitHostedLifecycleProductionOwner,
  HOSTED_LIFECYCLE_OWNER_ADMISSION_FORMAT,
  HOSTED_LIFECYCLE_OWNER_ADMISSION_MANIFEST_ENV,
  HOSTED_LIFECYCLE_OWNER_ADMISSION_PAYLOAD_FORMAT,
  HOSTED_LIFECYCLE_OWNER_ADMISSION_SIGNATURE_DOMAIN,
  HOSTED_LIFECYCLE_OWNER_ADMISSION_V4_FORMAT,
  HOSTED_LIFECYCLE_OWNER_ADMISSION_V4_PAYLOAD_FORMAT,
  HOSTED_LIFECYCLE_OWNER_ADMISSION_V4_SIGNATURE_DOMAIN,
  HOSTED_LIFECYCLE_OWNER_RELEASE_PIN_ENV,
  HOSTED_LIFECYCLE_OWNER_RELEASE_PIN_FORMAT,
  type HostedLifecycleReleaseOwnerArtifact,
  type HostedLifecycleReleaseOwnerPin,
} from '../../../../src/main/composition/hosted/hostedLifecycleProductionOwnerAdmission';
import {
  HOSTED_APPROVAL_ACTIVATION_CAPABILITY,
  HOSTED_APPROVAL_ACTIVATION_MANIFEST_FORMAT,
  serializeHostedApprovalRuntimeActivationPublication,
  verifyHostedApprovalRuntimeActivationPublication,
} from '../../../../src/main/services/team/provisioning/HostedApprovalRuntimeActivationEnvelope';
import { serializeHostedApprovalRuntimeAdmissionDocument } from '../../../../src/main/services/team/provisioning/HostedApprovalRuntimeAdmissionPublisher';
import { HOSTED_APPROVAL_RUNTIME_WIRE_CAPABILITY_DIGEST } from '../../../../src/shared/contracts/hostedApprovalWireCapability';

const TRUST_ANCHOR = '11'.repeat(32);
const ARTIFACT_DIGEST = `sha256:${'2'.repeat(64)}` as `sha256:${string}`;
const APPROVAL_SNAPSHOT = Object.freeze({
  schemaVersion: 1,
  approvalGeneration: 3,
  authorities: Object.freeze([
    Object.freeze({
      deploymentId: 'deployment_owner-admission-test',
      teamId: `team_${'1'.repeat(32)}`,
      runId: `run_${'4'.repeat(32)}`,
      planGeneration: 7,
      laneId: 'primary',
      providerId: 'opencode',
      credentialGeneration: 5,
      credentialId: 'credential_owner-admission-test',
      sessionId: 'session_owner-admission-test',
      runtimeInstanceId: `runtime_instance_${'3'.repeat(32)}`,
      deliveryOwnerId: `member_${'2'.repeat(32)}`,
    }),
  ]),
});
const APPROVAL_DIGEST = `sha256:${createHash('sha256')
  .update(JSON.stringify(APPROVAL_SNAPSHOT))
  .digest('hex')}` as `sha256:${string}`;
const RELEASE_ARTIFACT: HostedLifecycleReleaseOwnerArtifact = Object.freeze({
  artifactDigest: ARTIFACT_DIGEST,
  imageReference: `registry.example.invalid/agent-teams/lifecycle-owner@${ARTIFACT_DIGEST}`,
  artifactVersion: '1.4.2',
  protocolVersion: 2,
});
const LAUNCHER_KEYS = generateKeyPairSync('ed25519');
const FOREIGN_LAUNCHER_KEYS = generateKeyPairSync('ed25519');

function rawEd25519PublicKey(key: KeyObject): string {
  const jwk = key.export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new Error('test-launcher-public-key-invalid');
  }
  return jwk.x;
}

function launcherKeyId(publicKey: string): string {
  return sha256(Buffer.from(publicKey, 'base64url'));
}

const LAUNCHER_PUBLIC_KEY = rawEd25519PublicKey(LAUNCHER_KEYS.publicKey);
const LAUNCHER_KEY_ID = launcherKeyId(LAUNCHER_PUBLIC_KEY);
const FOREIGN_LAUNCHER_PUBLIC_KEY = rawEd25519PublicKey(FOREIGN_LAUNCHER_KEYS.publicKey);
const FOREIGN_LAUNCHER_KEY_ID = launcherKeyId(FOREIGN_LAUNCHER_PUBLIC_KEY);
const RELEASE_PIN: HostedLifecycleReleaseOwnerPin = Object.freeze({
  ...RELEASE_ARTIFACT,
  launcherPublicKey: LAUNCHER_PUBLIC_KEY,
  launcherKeyId: LAUNCHER_KEY_ID,
});

interface OwnerAdmissionFixture {
  readonly root: string;
  readonly runDirectory: string;
  readonly manifestPath: string;
  readonly socketPath: string;
  readonly trustAnchorPath: string;
  readonly releasePinPath: string;
  readonly environment: Record<string, string>;
  readonly options: {
    readonly manifestPath: string;
    readonly trustAnchorPath: string;
    readonly releasePinPath: string;
    readonly socketPath: string;
    readonly expectedUid: number;
    readonly expectedGid: number;
  };
  readonly payload: Record<string, unknown>;
  writeReleasePin(pin: HostedLifecycleReleaseOwnerPin): Promise<void>;
  writeSignedPayload(
    payload: Record<string, unknown>,
    signingKey?: KeyObject,
    keyId?: string
  ): Promise<void>;
  writeV4SignedPayload(payload: Record<string, unknown>): Promise<void>;
  writeLegacySignedPayload(payload: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function releasePinDocument(pin: HostedLifecycleReleaseOwnerPin): string {
  return `${JSON.stringify({
    format: HOSTED_LIFECYCLE_OWNER_RELEASE_PIN_FORMAT,
    artifact: {
      artifactDigest: pin.artifactDigest,
      imageReference: pin.imageReference,
      artifactVersion: pin.artifactVersion,
      protocolVersion: pin.protocolVersion,
    },
    launcher: {
      algorithm: 'ed25519',
      publicKey: pin.launcherPublicKey,
      keyId: pin.launcherKeyId,
    },
  })}\n`;
}

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function createRouteSocket(path: string): Promise<{
  readonly server: Server;
  readonly identity: Readonly<{
    device: string;
    inode: string;
    uid: number;
    gid: number;
    mode: number;
  }>;
}> {
  const server = createServer();
  await listen(server, path);
  await chmod(path, 0o600);
  const stat = await lstat(path, { bigint: true });
  return {
    server,
    identity: Object.freeze({
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
      uid: Number(stat.uid),
      gid: Number(stat.gid),
      mode: 0o600,
    }),
  };
}

async function fixture(): Promise<OwnerAdmissionFixture> {
  // Keep the Unix-domain socket below macOS' short sockaddr_un path limit.
  const root = await mkdtemp('/tmp/hoa-');
  const runDirectory = join(root, 'owner-run');
  const trustDirectory = join(root, 'trust');
  const manifestPath = join(runDirectory, 'lifecycle-owner-admission.json');
  const socketPath = join(runDirectory, 'orchestrator-lifecycle.sock');
  const trustAnchorPath = join(trustDirectory, 'trust-anchor');
  const releasePinPath = join(trustDirectory, 'release-owner-pin.json');
  await Promise.all([mkdir(runDirectory, { mode: 0o700 }), mkdir(trustDirectory, { mode: 0o700 })]);
  await Promise.all([
    writeFile(trustAnchorPath, `${TRUST_ANCHOR}\n`, { mode: 0o400 }),
    writeFile(releasePinPath, releasePinDocument(RELEASE_PIN), { mode: 0o400 }),
  ]);
  await Promise.all([chmod(trustAnchorPath, 0o400), chmod(releasePinPath, 0o400)]);
  const server = createServer();
  await listen(server, socketPath);
  await chmod(socketPath, 0o600);
  const socketStat = await lstat(socketPath, { bigint: true });
  const bootstrap = JSON.stringify({
    format: 'agent-teams.team-lifecycle-read-bootstrap/v1',
    issuedAtMs: 1,
    expiresAtMs: 9_999_999_999_999,
    actorId: 'actor_owner-admission-test',
    authorizedScope: 'scope_team-lifecycle.read',
    deploymentId: 'deployment_owner-admission-test',
    bootId: 'boot_owner-admission-test',
    workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    runtimeInstance: {
      deploymentId: 'deployment_owner-admission-test',
      bootId: 'boot_owner-admission-test',
      claudeRoot: { kind: 'claude', reference: '/data/.claude' },
      appDataRoot: { kind: 'app-data', reference: '/data/.agent-teams' },
      workspaceRoots: [{ kind: 'workspace', reference: '/workspaces/sandbox' }],
      tempRoot: { kind: 'temp', reference: '/tmp' },
      logsRoot: { kind: 'logs', reference: '/data/.agent-teams/logs' },
    },
    workspaceManifest: {
      version: 1,
      registrations: [
        {
          schemaVersion: 1,
          registrationKey: 'owner-admission.test',
          workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          displayName: 'Admission test',
          registrationRevision: 1,
          declaredRootHash: '3'.repeat(64),
          enabled: true,
          mountBinding: {
            bootId: 'boot_owner-admission-test',
            mountGeneration: 7,
            observedAt: 1,
            health: 'healthy',
            allowedOperations: [],
          },
        },
      ],
    },
  });
  const proofKeyId = sha256(Buffer.from(TRUST_ANCHOR, 'hex'));
  const payload: Record<string, unknown> = {
    format: HOSTED_LIFECYCLE_OWNER_ADMISSION_PAYLOAD_FORMAT,
    artifact: { ...RELEASE_ARTIFACT },
    ownerBinding: {
      ownerAuthority: 'owner-authority_admission-test',
      ownerGeneration: 13,
      ownerSessionId: 'owner-session_admission-test-0001',
      socketIdentity: {
        device: socketStat.dev.toString(),
        inode: socketStat.ino.toString(),
        uid: Number(socketStat.uid),
        gid: Number(socketStat.gid),
        mode: 0o600,
      },
    },
    bootstrapBinding: {
      deploymentId: 'deployment_owner-admission-test',
      bootId: 'boot_owner-admission-test',
      workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      mountGeneration: 7,
      bootstrapDigest: sha256(bootstrap),
      ownerArtifactDigest: ARTIFACT_DIGEST,
      proofKeyId,
    },
    approvalAdmission: { state: 'provisioning' },
    approvalSnapshot: null,
    socketPath,
  };
  const writeReleasePin = async (pin: HostedLifecycleReleaseOwnerPin): Promise<void> => {
    await chmod(releasePinPath, 0o600);
    await writeFile(releasePinPath, releasePinDocument(pin));
    await chmod(releasePinPath, 0o400);
  };
  const writeSignedPayload = async (
    nextPayload: Record<string, unknown>,
    signingKey: KeyObject = LAUNCHER_KEYS.privateKey,
    keyId: string = LAUNCHER_KEY_ID
  ): Promise<void> => {
    const serializedPayload = JSON.stringify(nextPayload);
    const signature = sign(
      null,
      Buffer.from(
        `${HOSTED_LIFECYCLE_OWNER_ADMISSION_SIGNATURE_DOMAIN}\u0000${serializedPayload}`,
        'utf8'
      ),
      signingKey
    ).toString('base64url');
    await chmod(manifestPath, 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        format: HOSTED_LIFECYCLE_OWNER_ADMISSION_FORMAT,
        payload: serializedPayload,
        authentication: { algorithm: 'ed25519', launcherKeyId: keyId, signature },
      })}\n`,
      { mode: 0o600 }
    );
    await chmod(manifestPath, 0o400);
  };
  const writeLegacySignedPayload = async (nextPayload: Record<string, unknown>): Promise<void> => {
    const serializedPayload = JSON.stringify(nextPayload);
    const domain = 'agent-teams.hosted-lifecycle-owner-admission/v2';
    const signature = sign(
      null,
      Buffer.from(`${domain}\u0000${serializedPayload}`, 'utf8'),
      LAUNCHER_KEYS.privateKey
    ).toString('base64url');
    await chmod(manifestPath, 0o600);
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        format: domain,
        payload: serializedPayload,
        authentication: {
          algorithm: 'ed25519',
          launcherKeyId: LAUNCHER_KEY_ID,
          signature,
        },
      })}\n`
    );
    await chmod(manifestPath, 0o400);
  };
  const writeV4SignedPayload = async (nextPayload: Record<string, unknown>): Promise<void> => {
    const serializedPayload = JSON.stringify(nextPayload);
    const signature = sign(
      null,
      Buffer.from(
        `${HOSTED_LIFECYCLE_OWNER_ADMISSION_V4_SIGNATURE_DOMAIN}\u0000${serializedPayload}`,
        'utf8'
      ),
      LAUNCHER_KEYS.privateKey
    ).toString('base64url');
    await chmod(manifestPath, 0o600);
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        format: HOSTED_LIFECYCLE_OWNER_ADMISSION_V4_FORMAT,
        payload: serializedPayload,
        authentication: {
          algorithm: 'ed25519',
          launcherKeyId: LAUNCHER_KEY_ID,
          signature,
        },
      })}\n`
    );
    await chmod(manifestPath, 0o400);
  };
  await writeSignedPayload(payload);
  const runIdentity = await lstat(runDirectory, { bigint: true });
  return {
    root,
    runDirectory,
    manifestPath,
    socketPath,
    trustAnchorPath,
    releasePinPath,
    environment: {
      [HOSTED_LIFECYCLE_OWNER_ADMISSION_MANIFEST_ENV]: manifestPath,
      HOSTED_LIFECYCLE_ORCHESTRATOR_SOCKET: socketPath,
      HOSTED_LIFECYCLE_ORCHESTRATOR_TRUST_ANCHOR_FILE: trustAnchorPath,
      [HOSTED_LIFECYCLE_OWNER_RELEASE_PIN_ENV]: releasePinPath,
      AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP: bootstrap,
    },
    options: {
      manifestPath,
      trustAnchorPath,
      releasePinPath,
      socketPath,
      expectedUid: Number(runIdentity.uid),
      expectedGid: Number(runIdentity.gid),
    },
    payload,
    writeReleasePin,
    writeSignedPayload,
    writeV4SignedPayload,
    writeLegacySignedPayload,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('hosted lifecycle production owner admission', () => {
  function activeV4Payload(input: OwnerAdmissionFixture): Record<string, unknown> {
    const payload = structuredClone(input.payload);
    payload.format = HOSTED_LIFECYCLE_OWNER_ADMISSION_V4_PAYLOAD_FORMAT;
    payload.approvalAdmission = {
      state: 'active',
      approvalGeneration: 3,
      approvalDigest: APPROVAL_DIGEST,
      ownerGeneration: 13,
    };
    payload.approvalSnapshot = APPROVAL_SNAPSHOT;
    const ownerBinding = payload.ownerBinding as Record<string, unknown>;
    payload.approvalRoutes = [
      {
        teamId: `team_${'1'.repeat(32)}`,
        workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        ownerGeneration: 13,
        ownerSessionId: 'owner-session_admission-test-0001',
        socketPath: input.socketPath,
        socketIdentity: structuredClone(ownerBinding.socketIdentity),
        artifactDigest: ARTIFACT_DIGEST,
        approvalGeneration: 3,
        approvalDigest: APPROVAL_DIGEST,
        wireCapabilityDigest: HOSTED_APPROVAL_RUNTIME_WIRE_CAPABILITY_DIGEST,
      },
    ];
    return payload;
  }

  it('admits one authenticated bootstrap-bound owner through an explicit release pin', async () => {
    const input = await fixture();
    try {
      const fixturePathsWithoutPin = {
        manifestPath: input.options.manifestPath,
        trustAnchorPath: input.options.trustAnchorPath,
        socketPath: input.options.socketPath,
        expectedUid: input.options.expectedUid,
        expectedGid: input.options.expectedGid,
      };
      expect(
        admitHostedLifecycleProductionOwner(input.environment, fixturePathsWithoutPin)
      ).toBeNull();
      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toMatchObject({
        ...RELEASE_PIN,
        ownerAuthority: 'owner-authority_admission-test',
        expectedOwnerBinding: {
          ownerGeneration: 13,
          ownerSessionId: 'owner-session_admission-test-0001',
        },
        bootstrapBinding: {
          deploymentId: 'deployment_owner-admission-test',
          mountGeneration: 7,
          ownerArtifactDigest: ARTIFACT_DIGEST,
        },
        manifestDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        releasePinDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        approvalAdmission: { state: 'provisioning' },
      });
    } finally {
      await input.close();
    }
  });

  it('admits active approval authority only when its generation is bound to this owner restart', async () => {
    const input = await fixture();
    try {
      const active = structuredClone(input.payload);
      active.approvalAdmission = {
        state: 'active',
        approvalGeneration: 3,
        approvalDigest: APPROVAL_DIGEST,
        ownerGeneration: 13,
      };
      active.approvalSnapshot = APPROVAL_SNAPSHOT;
      await input.writeSignedPayload(active);
      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toMatchObject({
        approvalAdmission: { state: 'active', approvalGeneration: 3, ownerGeneration: 13 },
      });

      const mismatchedSnapshot = structuredClone(active);
      const snapshot = mismatchedSnapshot.approvalSnapshot as {
        authorities: Array<Record<string, unknown>>;
      };
      snapshot.authorities[0].sessionId = 'session_snapshot-drift';
      await input.writeSignedPayload(mismatchedSnapshot);
      // Standalone cannot construct readiness or advance its owner high-water without admission.
      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toBeNull();

      (active.approvalAdmission as Record<string, unknown>).ownerGeneration = 12;
      await input.writeSignedPayload(active);
      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toBeNull();
    } finally {
      await input.close();
    }
  });

  it('admits only a signed v4 active approval route catalog with exact owner and wire bindings', async () => {
    const input = await fixture();
    try {
      const payload = activeV4Payload(input);
      await input.writeV4SignedPayload(payload);

      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toMatchObject({
        approvalAdmission: { state: 'active', approvalGeneration: 3, ownerGeneration: 13 },
        approvalRoutes: [
          {
            teamId: `team_${'1'.repeat(32)}`,
            workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            ownerGeneration: 13,
            artifactDigest: ARTIFACT_DIGEST,
            wireCapabilityDigest: HOSTED_APPROVAL_RUNTIME_WIRE_CAPABILITY_DIGEST,
          },
        ],
      });

      await input.writeSignedPayload(input.payload);
      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toMatchObject({
        approvalRoutes: [],
      });
    } finally {
      await input.close();
    }
  });

  it('carries one publisher document through signed-v4 admission and activation for two teams', async () => {
    const input = await fixture();
    const routeSockets: Server[] = [];
    try {
      const first = await createRouteSocket(join(input.runDirectory, 'approval-team-1.sock'));
      const second = await createRouteSocket(join(input.runDirectory, 'approval-team-2.sock'));
      routeSockets.push(first.server, second.server);
      const payload = activeV4Payload(input);
      const route = (payload.approvalRoutes as Record<string, unknown>[])[0];
      payload.approvalRoutes = [
        {
          ...structuredClone(route),
          ownerGeneration: 21,
          ownerSessionId: 'owner-session_approval-team-0001',
          socketPath: join(input.runDirectory, 'approval-team-1.sock'),
          socketIdentity: first.identity,
        },
        {
          ...structuredClone(route),
          teamId: `team_${'2'.repeat(32)}`,
          ownerGeneration: 22,
          ownerSessionId: 'owner-session_approval-team-0002',
          socketPath: join(input.runDirectory, 'approval-team-2.sock'),
          socketIdentity: second.identity,
        },
      ];
      const snapshot = structuredClone(APPROVAL_SNAPSHOT) as unknown as {
        schemaVersion: number;
        approvalGeneration: number;
        authorities: Array<Record<string, unknown>>;
      };
      snapshot.authorities.push({
        ...structuredClone(snapshot.authorities[0]),
        teamId: `team_${'2'.repeat(32)}`,
        runId: `run_${'5'.repeat(32)}`,
        sessionId: 'session_owner-admission-test-2',
      });
      payload.approvalSnapshot = snapshot;
      const digest = `sha256:${sha256(JSON.stringify(snapshot))}`;
      (payload.approvalAdmission as Record<string, unknown>).approvalDigest = digest;
      for (const approvalRoute of payload.approvalRoutes as Record<string, unknown>[]) {
        approvalRoute.approvalDigest = digest;
      }
      await input.writeV4SignedPayload(payload);

      const admitted = admitHostedLifecycleProductionOwner(input.environment, input.options);
      expect(admitted).toMatchObject({
        approvalRoutes: [
          {
            teamId: `team_${'1'.repeat(32)}`,
            ownerGeneration: 21,
            ownerSessionId: 'owner-session_approval-team-0001',
            socketIdentity: first.identity,
          },
          {
            teamId: `team_${'2'.repeat(32)}`,
            ownerGeneration: 22,
            ownerSessionId: 'owner-session_approval-team-0002',
            socketIdentity: second.identity,
          },
        ],
      });
      if (admitted === null || admitted.approvalAdmission.state !== 'active') {
        throw new Error('expected active signed-v4 admission');
      }

      const publisherBinding = {
        outerAuthority: {
          deploymentId: 'deployment_owner-admission-test',
          bootId: 'boot_owner-admission-test',
          workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          teamId: `team_${'1'.repeat(32)}`,
          restoreGeneration: 4,
          mountBinding: { mountGeneration: 7, declaredRootHash: '3'.repeat(64) },
        },
        routes: snapshot.authorities.map((authority, index) => ({
          routeId: `route_owner-admission-team-${index + 1}`,
          authority,
          scope: {
            principalId: 'actor_owner-admission-test',
            workspaceId: 'workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            teamId: authority.teamId,
            authorityGeneration: 'generation_owner-admission-test',
            restoreGeneration: 4,
          },
          memberName: 'member-owner-admission-test',
          openCodeBinding: {
            toolApprovalMode: 'manual',
            planGeneration: authority.planGeneration,
            credentialGeneration: authority.credentialGeneration,
            credentialId: authority.credentialId,
            runtimeInstanceId: authority.runtimeInstanceId,
            deliveryOwnerId: authority.deliveryOwnerId,
            openCodeArtifactDigest: ARTIFACT_DIGEST,
            sessionRecordFingerprint: `${index + 1}`.repeat(64),
            liveEffectFingerprint: `${index + 3}`.repeat(64),
          },
        })),
        memberIdsByName: { 'member-owner-admission-test': `member_${'2'.repeat(32)}` },
        actorMembers: { 'actor_owner-admission-test': `member_${'2'.repeat(32)}` },
        owner: {
          teamId: `team_${'1'.repeat(32)}`,
          ownerAuthority: admitted.ownerAuthority,
          ownerGeneration: 13,
          ownerSessionId: admitted.expectedOwnerBinding.ownerSessionId,
          socketPath: input.socketPath,
          socketIdentity: admitted.expectedOwnerBinding.socketIdentity,
          processIdentity: { pid: 123, startIdentity: 'process-start_owner-admission-test' },
        },
        capability: {
          schemaVersion: 2,
          protocol: 'agent-teams-hosted-approval-v2',
          authentication: 'opencode-basic',
          runtimeInstanceId: `runtime_instance_${'3'.repeat(32)}`,
          configGeneration: `config_generation_${'6'.repeat(32)}`,
        },
      };
      const admissionDocument = serializeHostedApprovalRuntimeAdmissionDocument(
        publisherBinding as never,
        3,
        13
      );
      const admissionDocumentDigest = `sha256:${sha256(admissionDocument)}` as const;
      const activationKeys = generateKeyPairSync('ed25519');
      const publicKeySpkiDer = createPublicKey(activationKeys.privateKey).export({
        format: 'der',
        type: 'spki',
      });
      const publicKeyDigest = `sha256:${sha256(publicKeySpkiDer)}` as const;
      const contractDigest = `sha256:${'9'.repeat(64)}` as const;
      const signingIdentity = {
        privateKey: activationKeys.privateKey,
        publicKeySpkiDer,
        publicKeyDigest,
        contractDigest,
      };
      const verifier = { publicKeySpkiDer, publicKeyDigest, contractDigest };

      for (const route of admitted.approvalRoutes) {
        const binding = {
          deploymentId: admitted.bootstrapBinding.deploymentId,
          bootId: admitted.bootstrapBinding.bootId,
          workspaceId: route.workspaceId,
          teamId: route.teamId,
          restoreGeneration: 4,
          mountBinding: { mountGeneration: 7, declaredRootHash: '3'.repeat(64) },
          ownerBinding: {
            ownerAuthority: admitted.ownerAuthority,
            ownerGeneration: route.ownerGeneration,
            ownerSessionId: route.ownerSessionId,
            socketIdentity: route.socketIdentity,
          },
          socketPath: route.socketPath,
          approvalGeneration: route.approvalGeneration,
          admissionOwnerGeneration: admitted.approvalAdmission.ownerGeneration,
          approvalDigest: route.approvalDigest,
          admissionDocumentDigest,
          artifactDigest: route.artifactDigest,
          activationCapability: HOSTED_APPROVAL_ACTIVATION_CAPABILITY,
          wireCapabilityDigest: route.wireCapabilityDigest,
          signedManifest: {
            format: HOSTED_APPROVAL_ACTIVATION_MANIFEST_FORMAT,
            manifestDigest: admitted.manifestDigest,
            releasePinDigest: admitted.releasePinDigest,
            launcherKeyId: admitted.launcherKeyId,
          },
        };
        const publication = serializeHostedApprovalRuntimeActivationPublication(
          TRUST_ANCHOR as never,
          signingIdentity,
          binding as never,
          admissionDocument
        );
        expect(
          verifyHostedApprovalRuntimeActivationPublication(
            publication,
            TRUST_ANCHOR as never,
            verifier,
            binding as never
          )
        ).toEqual(JSON.parse(admissionDocument));
      }
    } finally {
      await Promise.all(routeSockets.map(closeServer));
      await input.close();
    }
  });

  it('rejects a run-directory socket that is absent from the signed route catalog', async () => {
    const input = await fixture();
    let unsignedSocket: Server | null = null;
    try {
      const extra = await createRouteSocket(join(input.runDirectory, 'unsigned-approval.sock'));
      unsignedSocket = extra.server;
      await input.writeV4SignedPayload(activeV4Payload(input));

      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toBeNull();
    } finally {
      if (unsignedSocket !== null) await closeServer(unsignedSocket);
      await input.close();
    }
  });

  it('rejects empty, duplicate, unsorted, and wire-drifted v4 route catalogs', async () => {
    const input = await fixture();
    try {
      const empty = activeV4Payload(input);
      empty.approvalRoutes = [];
      await input.writeV4SignedPayload(empty);
      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toBeNull();

      const duplicate = activeV4Payload(input);
      duplicate.approvalRoutes = [
        ...(duplicate.approvalRoutes as unknown[]),
        structuredClone((duplicate.approvalRoutes as unknown[])[0]),
      ];
      await input.writeV4SignedPayload(duplicate);
      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toBeNull();

      const unsorted = activeV4Payload(input);
      const firstRoute = (unsorted.approvalRoutes as Record<string, unknown>[])[0];
      unsorted.approvalRoutes = [
        { ...structuredClone(firstRoute), teamId: `team_${'2'.repeat(32)}` },
        firstRoute,
      ];
      await input.writeV4SignedPayload(unsorted);
      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toBeNull();

      const wireDrift = activeV4Payload(input);
      (wireDrift.approvalRoutes as Record<string, unknown>[])[0].wireCapabilityDigest =
        `sha256:${'8'.repeat(64)}`;
      await input.writeV4SignedPayload(wireDrift);
      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toBeNull();
    } finally {
      await input.close();
    }
  });

  it('rejects invalid v4 route owner, socket, artifact, and approval bindings', async () => {
    const input = await fixture();
    try {
      for (const mutate of [
        (route: Record<string, unknown>) => {
          route.ownerGeneration = 0;
        },
        (route: Record<string, unknown>) => {
          route.ownerSessionId = 'invalid';
        },
        (route: Record<string, unknown>) => {
          route.socketPath = `${input.socketPath}.stale`;
        },
        (route: Record<string, unknown>) => {
          route.artifactDigest = `sha256:${'9'.repeat(64)}`;
        },
        (route: Record<string, unknown>) => {
          route.approvalGeneration = 2;
        },
      ]) {
        const payload = activeV4Payload(input);
        mutate((payload.approvalRoutes as Record<string, unknown>[])[0]);
        await input.writeV4SignedPayload(payload);
        expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toBeNull();
      }
    } finally {
      await input.close();
    }
  });

  it('keeps the exact v2 producer payload compatible but approval-unmounted', async () => {
    const input = await fixture();
    try {
      const legacy = structuredClone(input.payload);
      legacy.format = 'agent-teams.hosted-lifecycle-owner-admission-payload/v2';
      delete legacy.approvalAdmission;
      delete legacy.approvalSnapshot;
      await input.writeLegacySignedPayload(legacy);
      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toMatchObject({
        approvalAdmission: { state: 'provisioning' },
        approvalSnapshot: null,
      });
    } finally {
      await input.close();
    }
  });

  it('rejects v2 envelope with v3 payload and v3 envelope with v2 payload', async () => {
    const input = await fixture();
    try {
      await input.writeLegacySignedPayload(input.payload);
      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toBeNull();

      const legacy = structuredClone(input.payload);
      legacy.format = 'agent-teams.hosted-lifecycle-owner-admission-payload/v2';
      delete legacy.approvalAdmission;
      delete legacy.approvalSnapshot;
      await input.writeSignedPayload(legacy);
      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toBeNull();
    } finally {
      await input.close();
    }
  });

  it('rejects foreign launchers, signed artifact drift, terminal generation, bootstrap substitution, and legacy env fallback', async () => {
    const input = await fixture();
    try {
      const unauthenticated = JSON.parse(await readFile(input.manifestPath, 'utf8')) as Record<
        string,
        unknown
      >;
      (unauthenticated.authentication as Record<string, unknown>).signature = 'A'.repeat(86);
      await chmod(input.manifestPath, 0o600);
      await writeFile(input.manifestPath, `${JSON.stringify(unauthenticated)}\n`);
      await chmod(input.manifestPath, 0o400);
      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toBeNull();

      await input.writeSignedPayload(
        input.payload,
        FOREIGN_LAUNCHER_KEYS.privateKey,
        LAUNCHER_KEY_ID
      );
      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toBeNull();

      const drifted = structuredClone(input.payload);
      (drifted.artifact as Record<string, unknown>).artifactVersion = '1.4.3';
      await input.writeSignedPayload(drifted);
      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toBeNull();

      const changedBootstrapBinding = structuredClone(input.payload);
      (changedBootstrapBinding.bootstrapBinding as Record<string, unknown>).bootstrapDigest =
        '4'.repeat(64);
      await input.writeSignedPayload(changedBootstrapBinding);
      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toBeNull();

      for (const exhaustedGeneration of [
        HOSTED_LIFECYCLE_OWNER_GENERATION_LIMIT,
        Number.MAX_SAFE_INTEGER - 1,
        Number.MAX_SAFE_INTEGER,
      ]) {
        const terminalGeneration = structuredClone(input.payload);
        (terminalGeneration.ownerBinding as Record<string, unknown>).ownerGeneration =
          exhaustedGeneration;
        await input.writeSignedPayload(terminalGeneration);
        expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toBeNull();
      }

      await input.writeSignedPayload(input.payload);
      expect(
        admitHostedLifecycleProductionOwner(
          {
            ...input.environment,
            AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP: `${input.environment.AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP} `,
          },
          input.options
        )
      ).toBeNull();
      expect(
        admitHostedLifecycleProductionOwner(
          {
            ...input.environment,
            AGENT_TEAMS_HOSTED_PHASE2_READ_BOOTSTRAP:
              input.environment.AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP,
          },
          input.options
        )
      ).toBeNull();
      expect(
        admitHostedLifecycleProductionOwner(
          {
            ...input.environment,
            HOSTED_LIFECYCLE_OWNER_ARTIFACT_DIGEST: ARTIFACT_DIGEST,
          },
          input.options
        )
      ).toBeNull();
    } finally {
      await input.close();
    }
  });

  it('rejects launcher public-key and key-id substitutions in either trust input', async () => {
    const input = await fixture();
    try {
      const substitutedManifestKey = structuredClone(input.payload);
      await input.writeSignedPayload(
        substitutedManifestKey,
        LAUNCHER_KEYS.privateKey,
        FOREIGN_LAUNCHER_KEY_ID
      );
      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toBeNull();

      await input.writeSignedPayload(input.payload);
      await input.writeReleasePin({
        ...RELEASE_PIN,
        launcherPublicKey: FOREIGN_LAUNCHER_PUBLIC_KEY,
      });
      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toBeNull();

      await input.writeReleasePin({
        ...RELEASE_PIN,
        launcherKeyId: FOREIGN_LAUNCHER_KEY_ID,
      });
      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toBeNull();
    } finally {
      await input.close();
    }
  });

  it('rejects a stale socket identity and unexpected authority-layout files or sockets', async () => {
    const input = await fixture();
    let unexpectedSocket: Server | null = null;
    try {
      const stale = structuredClone(input.payload);
      const ownerBinding = stale.ownerBinding as Record<string, unknown>;
      const socketIdentity = ownerBinding.socketIdentity as Record<string, unknown>;
      socketIdentity.inode = String(BigInt(String(socketIdentity.inode)) + 1n);
      await input.writeSignedPayload(stale);
      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toBeNull();

      await input.writeSignedPayload(input.payload);
      await writeFile(join(input.runDirectory, 'unexpected'), 'not-authority-state', {
        mode: 0o400,
      });
      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toBeNull();

      await rm(join(input.runDirectory, 'unexpected'));
      unexpectedSocket = createServer();
      const unexpectedSocketPath = join(input.runDirectory, 'auth-drain.sock');
      await listen(unexpectedSocket, unexpectedSocketPath);
      await chmod(unexpectedSocketPath, 0o600);
      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toBeNull();
    } finally {
      if (unexpectedSocket !== null) {
        const socket = unexpectedSocket;
        await new Promise<void>((resolve) => socket.close(() => resolve()));
      }
      await input.close();
    }
  });

  it('rejects mutable, mismatched, missing, and symlinked deployment release pins', async () => {
    const input = await fixture();
    try {
      await chmod(input.releasePinPath, 0o600);
      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toBeNull();

      const mismatchedPin = {
        ...RELEASE_PIN,
        artifactVersion: '1.4.3',
      } satisfies HostedLifecycleReleaseOwnerPin;
      await input.writeReleasePin(mismatchedPin);
      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toBeNull();

      await rm(input.releasePinPath);
      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toBeNull();

      const outside = join(input.root, 'self-attested-release-owner-pin.json');
      await writeFile(outside, releasePinDocument(RELEASE_PIN), { mode: 0o400 });
      await symlink(outside, input.releasePinPath);
      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toBeNull();
    } finally {
      await input.close();
    }
  });

  it('rejects a manifest symlink even when its bytes and launcher signature are otherwise valid', async () => {
    const input = await fixture();
    try {
      const outside = join(input.root, 'outside-manifest.json');
      await chmod(input.manifestPath, 0o600);
      const original = await readFile(input.manifestPath);
      await writeFile(outside, original, { mode: 0o400 });
      await rm(input.manifestPath);
      await symlink(outside, input.manifestPath);

      expect(admitHostedLifecycleProductionOwner(input.environment, input.options)).toBeNull();
    } finally {
      await input.close();
    }
  });
});
