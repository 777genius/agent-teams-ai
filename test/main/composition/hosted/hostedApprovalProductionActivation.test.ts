import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import { describe, expect, it, vi } from 'vitest';

import {
  createHostedApprovalProductionComposition,
  createOptionalHostedApprovalProductionComposition,
} from '../../../../src/main/composition/hosted/createHostedApprovalProductionComposition';
import { createHostedApprovalProductionCompositionFromEnvironment } from '../../../../src/main/composition/hosted/createHostedApprovalProductionCompositionFromEnvironment';
import {
  HOSTED_APPROVAL_ACTIVATION_ADMISSION_FILE_ENV,
  HOSTED_APPROVAL_ACTIVATION_CONTRACT_DIGEST_ENV,
  HOSTED_APPROVAL_ACTIVATION_PUBLIC_KEY_DIGEST_ENV,
  HOSTED_APPROVAL_ACTIVATION_SIGNING_KEY_FILE_ENV,
} from '../../../../src/main/services/team/provisioning/HostedApprovalRuntimeActivationEnvelope';
import { serializeHostedApprovalRuntimeAdmissionDocument } from '../../../../src/main/services/team/provisioning/HostedApprovalRuntimeAdmissionPublisher';

import type { CreateHostedApprovalProductionCompositionDependencies } from '../../../../src/main/composition/hosted/createHostedApprovalProductionComposition';
import type {
  HostedApprovalRuntimeActivationLease,
  HostedApprovalRuntimeActivationOptions,
} from '../../../../src/main/services/team/provisioning/HostedApprovalRuntimeActivationEnvelope';
import type { AuthoritativeHostedApprovalRuntimeBinding } from '../../../../src/main/services/team/provisioning/HostedApprovalRuntimeAdmissionPublisher';

const TEAM_ID = `team_${'1'.repeat(32)}`;
const WORKSPACE_ID = 'workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ARTIFACT_DIGEST = `sha256:${'4'.repeat(64)}` as const;
const WIRE_DIGEST = `sha256:${'5'.repeat(64)}` as const;
const PROOF_KEY = '00'.repeat(32) as never;
const SNAPSHOT = Object.freeze({
  schemaVersion: 1,
  approvalGeneration: 3,
  authorities: Object.freeze([
    Object.freeze({
      deploymentId: 'deployment_activation-test',
      teamId: TEAM_ID,
      runId: `run_${'9'.repeat(32)}`,
      planGeneration: 7,
      laneId: 'primary',
      providerId: 'opencode',
      credentialGeneration: 5,
      credentialId: 'credential_activation-test',
      sessionId: 'session_activation-test',
      runtimeInstanceId: `runtime_instance_${'a'.repeat(32)}`,
      deliveryOwnerId: `member_${'b'.repeat(32)}`,
    }),
  ]),
});
const APPROVAL_DIGEST = `sha256:${createHash('sha256')
  .update(JSON.stringify(SNAPSHOT))
  .digest('hex')}` as const;
const ADMISSION_DOCUMENT = `${JSON.stringify({
  schemaVersion: 1,
  admissionGeneration: 'approval-admission-generation_3_owner_7',
  outerAuthority: {
    deploymentId: 'deployment_activation-test',
    bootId: 'boot_activation-test',
    workspaceId: WORKSPACE_ID,
    teamId: TEAM_ID,
    restoreGeneration: 4,
    mountBinding: { mountGeneration: 9, declaredRootHash: '2'.repeat(64) },
  },
  routes: [
    {
      routeId: 'route_activation-test',
      authority: SNAPSHOT.authorities[0],
      scope: {
        principalId: 'actor_activation-test',
        workspaceId: WORKSPACE_ID,
        teamId: TEAM_ID,
        authorityGeneration: 'generation_activation-test',
        restoreGeneration: 4,
      },
      memberName: 'member-activation-test',
      openCodeBinding: {
        toolApprovalMode: 'manual',
        planGeneration: 7,
        credentialGeneration: 5,
        credentialId: 'credential_activation-test',
        runtimeInstanceId: `runtime_instance_${'a'.repeat(32)}`,
        deliveryOwnerId: `member_${'b'.repeat(32)}`,
        openCodeArtifactDigest: ARTIFACT_DIGEST,
        sessionRecordFingerprint: 'c'.repeat(64),
        liveEffectFingerprint: 'd'.repeat(64),
      },
    },
  ],
  actorMembers: { 'actor_activation-test': `member_${'b'.repeat(32)}` },
})}\n`;
const ADMISSION_DOCUMENT_DIGEST = `sha256:${createHash('sha256')
  .update(ADMISSION_DOCUMENT)
  .digest('hex')}` as const;
const ACTIVATION_KEYS = generateKeyPairSync('ed25519');
const ACTIVATION_SPKI = createPublicKey(ACTIVATION_KEYS.privateKey).export({
  format: 'der',
  type: 'spki',
});
const ACTIVATION_PUBLIC_KEY_DIGEST = `sha256:${createHash('sha256')
  .update(ACTIVATION_SPKI)
  .digest('hex')}` as const;

describe('hosted approval production activation', () => {
  it.each([
    ['malformed', 'not-json\n'],
    [
      'wrong-schema',
      `${JSON.stringify({
        schemaVersion: 2,
        admissionGeneration: 'approval-admission-generation_1_owner_1',
        outerAuthority: {},
        routes: [],
        actorMembers: {},
      })}\n`,
    ],
  ])(
    'fails the standalone loading/composition seam for a %s admission with no owner admission',
    async (_case, admissionDocument) => {
      const fixture = await standalonePublicationFixture(admissionDocument);
      try {
        const input = standaloneOptionalDependencies();
        expect(input.ownerAdmission).toBeNull();
        await expect(
          createHostedApprovalProductionCompositionFromEnvironment(fixture.environment, input)
        ).rejects.toThrow(/admission-file-invalid/u);
      } finally {
        await fixture.dispose();
      }
    }
  );

  it('returns null through the standalone loading/composition seam when publication is absent', async () => {
    const input = standaloneOptionalDependencies();
    expect(input.ownerAdmission).toBeNull();
    await expect(
      createHostedApprovalProductionCompositionFromEnvironment({}, input)
    ).resolves.toBeNull();
  });

  it('loads a canonical publication then returns null composition when owner admission is null', async () => {
    const fixture = await standalonePublicationFixture(ADMISSION_DOCUMENT);
    try {
      const input = standaloneOptionalDependencies();
      expect(input.ownerAdmission).toBeNull();
      await expect(
        createHostedApprovalProductionCompositionFromEnvironment(fixture.environment, input)
      ).resolves.toBeNull();
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps the production surface gated until the product signing identity is pinned', async () => {
    const activation = vi.fn(async (options: HostedApprovalRuntimeActivationOptions) =>
      activationLease(options)
    );
    const direct = dependencies(activation);
    const optional = {
      ...direct,
      routeDependencies: {
        runtimeInstance: direct.runtimeInstance,
        mountBinding: direct.mountBinding,
        teamIdentities: direct.teamIdentities,
      },
    };

    await expect(
      createOptionalHostedApprovalProductionComposition({
        ...optional,
        activationPublication: null,
      })
    ).resolves.toBeNull();
    expect(activation).not.toHaveBeenCalled();

    const composition = await createOptionalHostedApprovalProductionComposition(optional);
    expect(composition).not.toBeNull();
    expect(activation).toHaveBeenCalledOnce();
    composition?.close();
  });

  it('waits for authenticated activation-v1 ready before constructing the mounted surface', async () => {
    const entered = deferred<HostedApprovalRuntimeActivationOptions>();
    const ready = deferred<HostedApprovalRuntimeActivationLease>();
    const activation = vi.fn(async (options: HostedApprovalRuntimeActivationOptions) => {
      entered.resolve(options);
      return ready.promise;
    });
    let resolved = false;
    const creating = createHostedApprovalProductionComposition(dependencies(activation)).then(
      (value) => {
        resolved = true;
        return value;
      }
    );

    const options = await entered.promise;
    expect(resolved).toBe(false);
    expect(options.binding).toMatchObject({
      deploymentId: 'deployment_activation-test',
      bootId: 'boot_activation-test',
      workspaceId: WORKSPACE_ID,
      teamId: TEAM_ID,
      restoreGeneration: 4,
      approvalGeneration: 3,
      admissionOwnerGeneration: 7,
      approvalDigest: APPROVAL_DIGEST,
      admissionDocumentDigest: ADMISSION_DOCUMENT_DIGEST,
      artifactDigest: ARTIFACT_DIGEST,
      activationCapability: 'agent-teams.hosted-approval-activation-v1',
      wireCapabilityDigest: WIRE_DIGEST,
      signedManifest: {
        format: 'agent-teams.hosted-lifecycle-owner-admission/v4',
        manifestDigest: `sha256:${'6'.repeat(64)}`,
        releasePinDigest: `sha256:${'7'.repeat(64)}`,
        launcherKeyId: '8'.repeat(64),
      },
    });
    expect(options.admissionDocument).toBe(ADMISSION_DOCUMENT);

    const lease = activationLease(options);
    ready.resolve(lease);
    const composition = await creating;
    expect(resolved).toBe(true);
    expect(activation).toHaveBeenCalledOnce();
    composition.close();
    expect(lease.isReady()).toBe(false);
  });

  it('carries one canonical publisher admission through signed-v4 routes for two teams', async () => {
    const secondTeamId = `team_${'2'.repeat(32)}`;
    const publisherBinding = globalPublisherBinding(secondTeamId);
    const admissionDocument = serializeHostedApprovalRuntimeAdmissionDocument(
      publisherBinding,
      3,
      7
    );
    const authorities = publisherBinding.routes.map((route) => route.authority);
    const approvalSnapshot = { schemaVersion: 1, approvalGeneration: 3, authorities };
    const approvalDigest = digest(JSON.stringify(approvalSnapshot));
    const admissionDocumentDigest = digest(admissionDocument);
    const activation = vi.fn(async (options: HostedApprovalRuntimeActivationOptions) =>
      activationLease(options)
    );
    const input = dependencies(activation);
    const firstRoute = input.ownerAdmission.approvalRoutes[0]!;
    const composition = await createHostedApprovalProductionComposition({
      ...input,
      activationPublication: {
        ...input.activationPublication,
        admissionDocument,
        admissionDocumentDigest,
      },
      ownerAdmission: {
        ...input.ownerAdmission,
        approvalAdmission: {
          state: 'active',
          approvalGeneration: 3,
          approvalDigest,
          ownerGeneration: 7,
        },
        approvalSnapshot,
        approvalRoutes: [
          { ...firstRoute, approvalDigest },
          {
            ...firstRoute,
            teamId: secondTeamId,
            ownerGeneration: 8,
            ownerSessionId: 'owner-session_activation-test-second',
            socketPath: '/run/agent-teams-orchestrator/approval-test-second.sock',
            socketIdentity: { device: '11', inode: '13', uid: 1000, gid: 1000, mode: 0o600 },
            approvalDigest,
          },
        ],
      } as never,
    });

    expect(activation).toHaveBeenCalledTimes(2);
    expect(activation.mock.calls.map(([options]) => options.admissionDocument)).toEqual([
      admissionDocument,
      admissionDocument,
    ]);
    expect(activation.mock.calls.map(([options]) => options.binding.approvalDigest)).toEqual([
      approvalDigest,
      approvalDigest,
    ]);
    composition.close();
  });

  it('revokes the mounted route lease synchronously on owner loss before later effects', async () => {
    let options: HostedApprovalRuntimeActivationOptions | null = null;
    let lease: ReturnType<typeof activationLease> | null = null;
    const onFatal = vi.fn();
    const composition = await createHostedApprovalProductionComposition({
      ...dependencies(async (candidate) => {
        options = candidate;
        lease = activationLease(candidate);
        return lease;
      }),
      onApprovalOwnerLoss: onFatal,
    });

    expect(options).not.toBeNull();
    options!.onOwnerLoss();
    expect(lease!.isReady()).toBe(false);
    expect(() => composition.register({} as never)).toThrow(/activation-unavailable/u);
    expect(onFatal).toHaveBeenCalledOnce();
  });

  it('fails closed without exact ready and never mounts a legacy or stale lease', async () => {
    const invalid = vi.fn(async (options: HostedApprovalRuntimeActivationOptions) => ({
      isReady: () => false,
      currentBinding: () => ({
        ...options.binding.ownerBinding,
        ownerGeneration: options.binding.ownerBinding.ownerGeneration + 1,
      }),
      invalidate: vi.fn(),
    }));

    await expect(createHostedApprovalProductionComposition(dependencies(invalid))).rejects.toThrow(
      /activation-ready-invalid/u
    );
  });
});

function dependencies(
  activateApprovalRuntime: (
    options: HostedApprovalRuntimeActivationOptions
  ) => Promise<HostedApprovalRuntimeActivationLease>
): CreateHostedApprovalProductionCompositionDependencies {
  return {
    authentication: { authenticatedPrincipalFor: () => null },
    runtimeInstance: createRuntimeInstanceContext({
      deploymentId: 'deployment_activation-test',
      bootId: 'boot_activation-test',
      claudeRoot: { kind: 'claude', reference: 'isolated:claude' },
      appDataRoot: { kind: 'app-data', reference: 'isolated:app-data' },
      workspaceRoots: [{ kind: 'workspace', reference: 'isolated:workspace' }],
      tempRoot: { kind: 'temp', reference: 'isolated:temp' },
      logsRoot: { kind: 'logs', reference: 'isolated:logs' },
    }),
    expectedDeploymentId: 'deployment_activation-test',
    actorId: 'actor_activation-test',
    mountBinding: {
      workspaceId: WORKSPACE_ID,
      bootId: 'boot_activation-test',
      mountGeneration: 9,
      declaredRootHash: '2'.repeat(64),
    } as never,
    restoreGeneration: 4,
    teamIdentities: {} as never,
    approvalStorage: {} as never,
    routeAdmissionBinding: {} as never,
    ownerAdmission: {
      artifactDigest: ARTIFACT_DIGEST,
      imageReference: `example.invalid/owner@${ARTIFACT_DIGEST}`,
      artifactVersion: '1.0.0',
      protocolVersion: 2,
      launcherPublicKey: 'x'.repeat(43),
      launcherKeyId: '8'.repeat(64),
      ownerAuthority: 'owner-authority_activation-test',
      expectedOwnerBinding: {
        ownerAuthority: 'owner-authority_activation-test',
        ownerGeneration: 7,
        ownerSessionId: 'owner-session_activation-test',
        socketIdentity: { device: '11', inode: '12', uid: 1000, gid: 1000, mode: 0o600 },
      },
      bootstrapBinding: {
        deploymentId: 'deployment_activation-test',
        bootId: 'boot_activation-test',
        workspaceId: WORKSPACE_ID,
        mountGeneration: 9,
        bootstrapDigest: '1'.repeat(64),
        ownerArtifactDigest: ARTIFACT_DIGEST,
        proofKeyId: '0'.repeat(64),
      },
      manifestDigest: `sha256:${'6'.repeat(64)}`,
      releasePinDigest: `sha256:${'7'.repeat(64)}`,
      approvalAdmission: {
        state: 'active',
        approvalGeneration: 3,
        approvalDigest: APPROVAL_DIGEST,
        ownerGeneration: 7,
      },
      approvalSnapshot: SNAPSHOT,
      approvalRoutes: [
        {
          teamId: TEAM_ID,
          workspaceId: WORKSPACE_ID,
          ownerGeneration: 7,
          ownerSessionId: 'owner-session_activation-test',
          socketPath: '/run/agent-teams-orchestrator/approval-test.sock',
          socketIdentity: { device: '11', inode: '12', uid: 1000, gid: 1000, mode: 0o600 },
          artifactDigest: ARTIFACT_DIGEST,
          approvalGeneration: 3,
          approvalDigest: APPROVAL_DIGEST,
          wireCapabilityDigest: WIRE_DIGEST,
        },
      ],
    } as never,
    ownerProofKey: PROOF_KEY,
    activationPublication: {
      admissionDocument: ADMISSION_DOCUMENT,
      admissionDocumentDigest: ADMISSION_DOCUMENT_DIGEST,
      signingIdentity: {
        privateKey: ACTIVATION_KEYS.privateKey,
        publicKeySpkiDer: ACTIVATION_SPKI,
        publicKeyDigest: ACTIVATION_PUBLIC_KEY_DIGEST,
        contractDigest: `sha256:${'9'.repeat(64)}` as const,
      },
    },
    activateApprovalRuntime,
  };
}

function standaloneOptionalDependencies() {
  const direct = dependencies(async (options) => activationLease(options));
  return {
    authentication: direct.authentication,
    expectedDeploymentId: direct.expectedDeploymentId,
    restoreGeneration: direct.restoreGeneration,
    actorId: null,
    routeDependencies: null,
    approvalStorage: direct.approvalStorage,
    routeAdmissionBinding: direct.routeAdmissionBinding,
    ownerAdmission: null,
    ownerProofKey: null,
  };
}

async function standalonePublicationFixture(admissionDocument: string) {
  const root = await mkdtemp(join(tmpdir(), 'hosted-activation-standalone-'));
  const keyPath = join(root, 'product-activation.pkcs8.pem');
  const admissionPath = join(root, 'admission.json');
  await writeFile(keyPath, ACTIVATION_KEYS.privateKey.export({ format: 'pem', type: 'pkcs8' }), {
    mode: 0o400,
  });
  await writeFile(admissionPath, admissionDocument, { mode: 0o600 });
  return {
    environment: {
      [HOSTED_APPROVAL_ACTIVATION_SIGNING_KEY_FILE_ENV]: keyPath,
      [HOSTED_APPROVAL_ACTIVATION_PUBLIC_KEY_DIGEST_ENV]: ACTIVATION_PUBLIC_KEY_DIGEST,
      [HOSTED_APPROVAL_ACTIVATION_CONTRACT_DIGEST_ENV]: `sha256:${'9'.repeat(64)}`,
      [HOSTED_APPROVAL_ACTIVATION_ADMISSION_FILE_ENV]: admissionPath,
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

function activationLease(options: HostedApprovalRuntimeActivationOptions) {
  let ready = true;
  return {
    isReady: () => ready,
    currentBinding: () => (ready ? options.binding.ownerBinding : null),
    invalidate: () => {
      ready = false;
    },
  } satisfies HostedApprovalRuntimeActivationLease;
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function globalPublisherBinding(secondTeamId: string): AuthoritativeHostedApprovalRuntimeBinding {
  const route = (teamId: string, suffix: string, laneId: string) => ({
    routeId: `route_activation-test${suffix}`,
    authority: {
      ...SNAPSHOT.authorities[0],
      teamId,
      runId: `run_${(suffix ? '8' : '9').repeat(32)}`,
      laneId,
      sessionId: `session_activation-test${suffix}`,
    },
    scope: {
      principalId: 'actor_activation-test',
      workspaceId: WORKSPACE_ID,
      teamId,
      authorityGeneration: 'generation_activation-test',
      restoreGeneration: 4,
    },
    memberName: 'member-activation-test',
    openCodeBinding: {
      toolApprovalMode: 'manual',
      planGeneration: 7,
      credentialGeneration: 5,
      credentialId: 'credential_activation-test',
      runtimeInstanceId: `runtime_instance_${'a'.repeat(32)}`,
      deliveryOwnerId: `member_${'b'.repeat(32)}`,
      openCodeArtifactDigest: ARTIFACT_DIGEST,
      sessionRecordFingerprint: 'c'.repeat(64),
      liveEffectFingerprint: 'd'.repeat(64),
    },
  });
  return {
    outerAuthority: {
      deploymentId: 'deployment_activation-test',
      bootId: 'boot_activation-test',
      workspaceId: WORKSPACE_ID,
      teamId: TEAM_ID,
      restoreGeneration: 4,
      mountBinding: { mountGeneration: 9, declaredRootHash: '2'.repeat(64) },
    },
    routes: [route(TEAM_ID, '', 'primary'), route(secondTeamId, '-second', 'secondary')] as never,
    memberIdsByName: { 'member-activation-test': `member_${'b'.repeat(32)}` },
    actorMembers: { 'actor_activation-test': `member_${'b'.repeat(32)}` },
    owner: {
      teamId: TEAM_ID,
      ownerAuthority: 'owner-authority_activation-test',
      ownerGeneration: 7,
      ownerSessionId: 'owner-session_activation-test',
      socketPath: '/run/agent-teams-orchestrator/approval-test.sock',
      socketIdentity: { device: '11', inode: '12', uid: 1000, gid: 1000, mode: 0o600 },
      processIdentity: { pid: 123, startIdentity: 'process-start_activation-test' },
    },
    capability: {
      schemaVersion: 2,
      protocol: 'agent-teams-hosted-approval-v2',
      authentication: 'opencode-basic',
      runtimeInstanceId: `runtime_instance_${'a'.repeat(32)}`,
      configGeneration: `config_generation_${'e'.repeat(32)}`,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
