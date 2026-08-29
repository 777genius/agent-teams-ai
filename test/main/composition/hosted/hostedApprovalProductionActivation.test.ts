import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import { describe, expect, it, vi } from 'vitest';

import { OPENCODE_IDENTITIES } from '../../../../scripts/e2e/hosted-actual-owner/contracts';
import {
  createHostedApprovalProductionComposition,
  createOptionalHostedApprovalProductionComposition,
} from '../../../../src/main/composition/hosted/createHostedApprovalProductionComposition';
import { createHostedApprovalProductionCompositionFromEnvironment } from '../../../../src/main/composition/hosted/createHostedApprovalProductionCompositionFromEnvironment';
import {
  HOSTED_ACTUAL_OWNER_CANDIDATE_OPENCODE_SHA256,
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
  HostedApprovalRuntimeConnectedTransport,
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
  it('uses the frozen actual-owner OpenCode binary identity for candidate activation', () => {
    expect(HOSTED_ACTUAL_OWNER_CANDIDATE_OPENCODE_SHA256).toBe(
      OPENCODE_IDENTITIES.linuxX64BinarySha256
    );
  });

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

  it.each(['signing-key', 'admission-file', 'malformed-publication'] as const)(
    'destroys inherited FD5 and drains queued errors when %s loading rejects',
    async (failure) => {
      const fixture = await standalonePublicationFixture(
        failure === 'malformed-publication' ? 'not-json\n' : ADMISSION_DOCUMENT
      );
      try {
        const socket = new Socket();
        const input = {
          ...standaloneOptionalDependencies(),
          inheritedCandidateActivation: {
            transport: { socket },
            expectedOpenCodeExecutableSha256: HOSTED_ACTUAL_OWNER_CANDIDATE_OPENCODE_SHA256,
          },
        };
        const environment = { ...fixture.environment };
        if (failure === 'signing-key') {
          environment[HOSTED_APPROVAL_ACTIVATION_SIGNING_KEY_FILE_ENV] =
            environment[HOSTED_APPROVAL_ACTIVATION_ADMISSION_FILE_ENV];
        } else if (failure === 'admission-file') {
          environment[HOSTED_APPROVAL_ACTIVATION_ADMISSION_FILE_ENV] =
            `${environment[HOSTED_APPROVAL_ACTIVATION_ADMISSION_FILE_ENV]}.missing`;
        }
        await expect(
          createHostedApprovalProductionCompositionFromEnvironment(environment, input)
        ).rejects.toThrow();
        expect(socket.destroyed).toBe(true);
        expect(() =>
          socket.emit('error', new Error('queued-after-publication-rejection'))
        ).not.toThrow();
      } finally {
        await fixture.dispose();
      }
    }
  );

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

  it('waits for authenticated activation-v2 ready before constructing the mounted surface', async () => {
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
      activationCapability: 'agent-teams.hosted-approval-activation-v2',
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

  it('passes the immutable candidate pin and exact inherited transport through the narrow seam', async () => {
    const transport: HostedApprovalRuntimeConnectedTransport = {
      socket: { destroyed: false } as never,
    };
    const activation = vi.fn(
      async (
        options: HostedApprovalRuntimeActivationOptions,
        inherited?: HostedApprovalRuntimeConnectedTransport,
        expectedOpenCodeExecutableSha256?: string
      ) => {
        expect(inherited).not.toBe(transport);
        expect(inherited?.socket).toBe(transport.socket);
        expect(expectedOpenCodeExecutableSha256).toBe(
          HOSTED_ACTUAL_OWNER_CANDIDATE_OPENCODE_SHA256
        );
        return activationLease(options);
      }
    );
    const input = dependencies(activation);
    const candidateDocument = ADMISSION_DOCUMENT.replace(
      ARTIFACT_DIGEST,
      `sha256:${HOSTED_ACTUAL_OWNER_CANDIDATE_OPENCODE_SHA256}`
    );
    const composition = await createHostedApprovalProductionComposition({
      ...input,
      activationPublication: {
        ...input.activationPublication,
        admissionDocument: candidateDocument,
        admissionDocumentDigest: digest(candidateDocument),
      },
      inheritedCandidateActivation: {
        transport,
        expectedOpenCodeExecutableSha256: HOSTED_ACTUAL_OWNER_CANDIDATE_OPENCODE_SHA256,
      },
    });
    expect(activation).toHaveBeenCalledOnce();
    composition.close();
  });

  it('retains the inherited candidate transport and digest across suspended identity resolution', async () => {
    const originalSocket = { destroyed: false } as never;
    const replacementSocket = { destroyed: false } as never;
    const transport: HostedApprovalRuntimeConnectedTransport = { socket: originalSocket };
    const candidate = {
      transport,
      expectedOpenCodeExecutableSha256: HOSTED_ACTUAL_OWNER_CANDIDATE_OPENCODE_SHA256,
    };
    const activation = vi.fn(
      async (
        options: HostedApprovalRuntimeActivationOptions,
        inherited?: HostedApprovalRuntimeConnectedTransport,
        expectedOpenCodeExecutableSha256?: string
      ) => {
        expect(inherited?.socket).toBe(originalSocket);
        expect(expectedOpenCodeExecutableSha256).toBe(
          HOSTED_ACTUAL_OWNER_CANDIDATE_OPENCODE_SHA256
        );
        return activationLease(options);
      }
    );
    const input = dependencies(activation);
    const identityEntered = deferred<void>();
    const identityBarrier = deferred<void>();
    const originalGetTeamIdentity = input.teamIdentities.getTeamIdentity.bind(input.teamIdentities);
    input.teamIdentities.getTeamIdentity = vi.fn(async (teamId: string) => {
      identityEntered.resolve();
      await identityBarrier.promise;
      return originalGetTeamIdentity(teamId as never);
    });
    const candidateDocument = ADMISSION_DOCUMENT.replace(
      ARTIFACT_DIGEST,
      `sha256:${HOSTED_ACTUAL_OWNER_CANDIDATE_OPENCODE_SHA256}`
    );
    const mutableInput = {
      ...input,
      activationPublication: {
        ...input.activationPublication,
        admissionDocument: candidateDocument,
        admissionDocumentDigest: digest(candidateDocument),
      },
      inheritedCandidateActivation: candidate,
    };

    const creating = createHostedApprovalProductionComposition(mutableInput);
    await identityEntered.promise;
    (transport as { socket: typeof replacementSocket }).socket = replacementSocket;
    mutableInput.inheritedCandidateActivation = {
      transport: { socket: replacementSocket },
      expectedOpenCodeExecutableSha256: 'f'.repeat(64) as never,
    };
    expect(mutableInput.inheritedCandidateActivation.transport.socket).toBe(replacementSocket);
    identityBarrier.resolve();

    const composition = await creating;
    expect(activation).toHaveBeenCalledOnce();
    composition.close();
  });

  it('rejects candidate signed-route digest drift before invoking an injected activation seam', async () => {
    const activation = vi.fn(async (options: HostedApprovalRuntimeActivationOptions) =>
      activationLease(options)
    );
    const socket = new Socket();
    await expect(
      createHostedApprovalProductionComposition({
        ...dependencies(activation),
        inheritedCandidateActivation: {
          transport: { socket },
          expectedOpenCodeExecutableSha256: HOSTED_ACTUAL_OWNER_CANDIDATE_OPENCODE_SHA256,
        },
      })
    ).rejects.toThrow(/candidate-digest-mismatch/u);
    expect(activation).not.toHaveBeenCalled();
    expect(socket.destroyed).toBe(true);
    expect(() => socket.emit('error', new Error('queued-after-rejection'))).not.toThrow();
  });

  it.each(['route-count', 'admission-binding'] as const)(
    'closes inherited FD5 when the %s composition precheck rejects',
    async (failure) => {
      const activation = vi.fn(async (options: HostedApprovalRuntimeActivationOptions) =>
        activationLease(options)
      );
      const input = dependencies(activation);
      const candidateDocument = ADMISSION_DOCUMENT.replace(
        ARTIFACT_DIGEST,
        `sha256:${HOSTED_ACTUAL_OWNER_CANDIDATE_OPENCODE_SHA256}`
      );
      const socket = new Socket();
      const ownerAdmission =
        failure === 'route-count'
          ? { ...input.ownerAdmission, approvalRoutes: [] }
          : {
              ...input.ownerAdmission,
              bootstrapBinding: {
                ...input.ownerAdmission.bootstrapBinding,
                deploymentId: 'deployment_wrong',
              },
            };

      await expect(
        createHostedApprovalProductionComposition({
          ...input,
          ownerAdmission,
          activationPublication: {
            ...input.activationPublication,
            admissionDocument: candidateDocument,
            admissionDocumentDigest: digest(candidateDocument),
          },
          inheritedCandidateActivation: {
            transport: { socket },
            expectedOpenCodeExecutableSha256: HOSTED_ACTUAL_OWNER_CANDIDATE_OPENCODE_SHA256,
          },
        })
      ).rejects.toThrow(/route-count-invalid|admission-binding-invalid/u);
      expect(activation).not.toHaveBeenCalled();
      expect(socket.destroyed).toBe(true);
      expect(() => socket.emit('error', new Error('queued-after-rejection'))).not.toThrow();
    }
  );

  it('preflights every normal route before the first activation can create a socket', async () => {
    const activation = vi.fn(async (options: HostedApprovalRuntimeActivationOptions) =>
      activationLease(options)
    );
    const input = dependencies(activation);
    const firstRoute = input.ownerAdmission.approvalRoutes[0];
    if (firstRoute === undefined) throw new Error('test route missing');

    await expect(
      createHostedApprovalProductionComposition({
        ...input,
        ownerAdmission: {
          ...input.ownerAdmission,
          approvalRoutes: [firstRoute, { ...firstRoute, socketPath: 'relative.sock' }],
        },
      })
    ).rejects.toThrow(/activation-binding-invalid/u);
    expect(activation).not.toHaveBeenCalled();
  });

  it('rejects an invalid operator deployment binding before the first activation', async () => {
    const connect = vi.fn(() => new Socket());
    const activation = vi.fn(async (options: HostedApprovalRuntimeActivationOptions) => {
      connect();
      return activationLease(options);
    });
    const input = dependencies(activation);
    await expect(
      createHostedApprovalProductionComposition({
        ...input,
        expectedDeploymentId: 'deployment_wrong',
      })
    ).rejects.toThrow(/operator-production-binding-invalid/u);
    expect(activation).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects duplicate route teams before the first activation', async () => {
    const connect = vi.fn(() => new Socket());
    const activation = vi.fn(async (options: HostedApprovalRuntimeActivationOptions) => {
      connect();
      return activationLease(options);
    });
    const input = dependencies(activation);
    const route = input.ownerAdmission.approvalRoutes[0];
    if (route === undefined) throw new Error('test route missing');
    await expect(
      createHostedApprovalProductionComposition({
        ...input,
        ownerAdmission: {
          ...input.ownerAdmission,
          approvalRoutes: [route, { ...route, socketPath: '/run/duplicate-team.sock' }],
        },
      })
    ).rejects.toThrow(/operator-production-team-routes-invalid/u);
    expect(activation).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
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

  it('rolls back every ready lease when any route in a multi-route activation batch fails', async () => {
    const secondTeamId = `team_${'2'.repeat(32)}`;
    const publisherBinding = globalPublisherBinding(secondTeamId);
    const admissionDocument = serializeHostedApprovalRuntimeAdmissionDocument(
      publisherBinding,
      3,
      7
    );
    const approvalSnapshot = {
      schemaVersion: 1,
      approvalGeneration: 3,
      authorities: publisherBinding.routes.map((route) => route.authority),
    };
    const approvalDigest = digest(JSON.stringify(approvalSnapshot));
    const firstLease = vi.fn();
    const activation = vi.fn(async (options: HostedApprovalRuntimeActivationOptions) => {
      if (options.binding.teamId === secondTeamId) throw new Error('second-route-rejected');
      const lease = activationLease(options);
      firstLease.mockImplementation(lease.invalidate);
      return { ...lease, invalidate: firstLease };
    });
    const input = dependencies(activation);
    const firstRoute = input.ownerAdmission.approvalRoutes[0]!;

    await expect(
      createHostedApprovalProductionComposition({
        ...input,
        activationPublication: {
          ...input.activationPublication,
          admissionDocument,
          admissionDocumentDigest: digest(admissionDocument),
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
      })
    ).rejects.toThrow('second-route-rejected');
    expect(activation).toHaveBeenCalledTimes(2);
    expect(firstLease).toHaveBeenCalledOnce();
  });

  it('binds the identity resolver before activation and never resolves identity afterward', async () => {
    const input = dependencies(async (options) => {
      Object.defineProperty(input.teamIdentities, 'getTeamIdentity', {
        value: vi.fn(() => {
          throw new Error('post-preflight-identity-rebind');
        }),
      });
      return activationLease(options);
    });
    const originalResolver = input.teamIdentities.getTeamIdentity as ReturnType<typeof vi.fn>;
    const composition = await createHostedApprovalProductionComposition(input);
    expect(originalResolver).toHaveBeenCalledOnce();
    composition.close();
  });

  it('keeps the preflight signing identity bound across async identity resolution', async () => {
    const activation = vi.fn(async (options: HostedApprovalRuntimeActivationOptions) => {
      expect(options.binding.ownerBinding.socketIdentity.inode).toBe('12');
      expect(options.signingIdentity.publicKeyDigest).toBe(ACTIVATION_PUBLIC_KEY_DIGEST);
      expect(options.signingIdentity.publicKeySpkiDer[0]).not.toBe(0);
      return activationLease(options);
    });
    const input = dependencies(activation);
    const signingBytes = new Uint8Array(
      input.activationPublication.signingIdentity.publicKeySpkiDer
    );
    Object.defineProperty(input.activationPublication, 'signingIdentity', {
      value: {
        ...input.activationPublication.signingIdentity,
        publicKeySpkiDer: signingBytes,
      },
    });
    Object.defineProperty(input.teamIdentities, 'getTeamIdentity', {
      value: vi.fn(async (teamId: string) => {
        signingBytes.fill(0);
        (
          input.activationPublication.signingIdentity as { publicKeyDigest: `sha256:${string}` }
        ).publicKeyDigest = `sha256:${'0'.repeat(64)}`;
        return {
          teamId,
          state: 'active',
          workspaceBinding: { workspaceId: WORKSPACE_ID, generation: 9 },
        } as never;
      }),
    });

    const composition = await createHostedApprovalProductionComposition(input);
    expect(activation).toHaveBeenCalledOnce();
    composition.close();
  });

  it.each([
    'mount-generation',
    'mount-nested-hash',
    'mount-replacement',
    'restore-generation',
  ] as const)(
    'uses one immutable mount/restore authority epoch across %s mutation during identity await',
    async (mutation) => {
      const observedBindings: HostedApprovalRuntimeActivationOptions['binding'][] = [];
      const input = dependencies(async (options) => {
        observedBindings.push(options.binding);
        return activationLease(options);
      });
      const claims = vi.fn(async () => Object.freeze([]));
      input.approvalStorage.hostedTeamApprovalClaimDeliveries = claims;
      Object.defineProperty(input.teamIdentities, 'getTeamIdentity', {
        value: vi.fn(async (teamId: string) => {
          const mutable = input as unknown as {
            mountBinding: CreateHostedApprovalProductionCompositionDependencies['mountBinding'];
            restoreGeneration: number;
          };
          if (mutation === 'mount-generation') {
            (mutable.mountBinding as { mountGeneration: number }).mountGeneration = 10;
          } else if (mutation === 'mount-nested-hash') {
            (mutable.mountBinding as { declaredRootHash: string }).declaredRootHash = 'f'.repeat(
              64
            );
          } else if (mutation === 'mount-replacement') {
            mutable.mountBinding = {
              ...mutable.mountBinding,
              mountGeneration: 10,
              declaredRootHash: 'e'.repeat(64),
            } as unknown as CreateHostedApprovalProductionCompositionDependencies['mountBinding'];
          } else {
            mutable.restoreGeneration = 5;
          }
          return Object.freeze({
            teamId,
            state: 'active',
            workspaceBinding: Object.freeze({ workspaceId: WORKSPACE_ID, generation: 9 }),
          });
        }),
      });

      const composition = await createHostedApprovalProductionComposition(input);
      await vi.waitFor(() => expect(composition.isReady()).toBe(true));
      expect(observedBindings).toHaveLength(1);
      expect(observedBindings[0]).toMatchObject({
        restoreGeneration: 4,
        mountBinding: { mountGeneration: 9, declaredRootHash: '2'.repeat(64) },
      });
      expect(claims).toHaveBeenCalledWith(
        expect.objectContaining({ authorityGeneration: 'generation_mount-9', restoreGeneration: 4 })
      );
      composition.close();
    }
  );

  it.each([
    ['authentication', 'top-level'],
    ['authentication', 'nested-method'],
    ['storage', 'top-level'],
    ['storage', 'nested-method'],
  ] as const)(
    'fails closed on route binding across suspended %s %s replacement',
    async (gateway, replacement) => {
      const identityStarted = deferred<void>();
      const identityBarrier = deferred<void>();
      const activation = vi.fn(async (options: HostedApprovalRuntimeActivationOptions) =>
        activationLease(options)
      );
      const input = dependencies(activation);
      Object.defineProperty(input.teamIdentities, 'getTeamIdentity', {
        value: vi.fn(async (teamId: string) => {
          identityStarted.resolve();
          await identityBarrier.promise;
          return Object.freeze({
            teamId,
            state: 'active',
            workspaceBinding: Object.freeze({ workspaceId: WORKSPACE_ID, generation: 9 }),
          });
        }),
      });
      const originalAuthentication = vi.fn(() => null);
      input.authentication.authenticatedPrincipalFor = originalAuthentication;
      const replacementAuthentication = vi.fn(() => null);
      const originalAudit = vi.fn(async () => ({ resolvedCount: 0, nextAuditTimeMs: null }));
      input.approvalStorage.hostedTeamApprovalAuditTimeouts = originalAudit;
      const replacementAudit = vi.fn(async () => ({ resolvedCount: 0, nextAuditTimeMs: null }));
      const compositionPromise = createHostedApprovalProductionComposition(input);
      await identityStarted.promise;
      const mutable = input as unknown as {
        authentication: typeof input.authentication;
        approvalStorage: typeof input.approvalStorage;
      };
      if (gateway === 'authentication') {
        if (replacement === 'top-level') {
          mutable.authentication = { authenticatedPrincipalFor: replacementAuthentication };
        } else {
          input.authentication.authenticatedPrincipalFor = replacementAuthentication;
        }
      } else if (replacement === 'top-level') {
        mutable.approvalStorage = {
          ...input.approvalStorage,
          hostedTeamApprovalAuditTimeouts: replacementAudit,
        };
      } else {
        input.approvalStorage.hostedTeamApprovalAuditTimeouts = replacementAudit;
      }
      identityBarrier.resolve();
      await expect(compositionPromise).rejects.toThrow(
        'hosted-approval-production-route-binding-invalid'
      );
      expect(activation).not.toHaveBeenCalled();
      expect(originalAuthentication).not.toHaveBeenCalled();
      expect(replacementAuthentication).not.toHaveBeenCalled();
      expect(originalAudit).not.toHaveBeenCalled();
      expect(replacementAudit).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['authentication', 'top-level'],
    ['authentication', 'nested-method'],
    ['storage', 'top-level'],
    ['storage', 'nested-method'],
  ] as const)(
    'rolls back the acquired lease on suspended activation after %s %s replacement',
    async (gateway, replacement) => {
      const activationStarted = deferred<void>();
      const activationBarrier = deferred<void>();
      let acquiredLease: ReturnType<typeof activationLease> | null = null;
      const activation = vi.fn(async (options: HostedApprovalRuntimeActivationOptions) => {
        acquiredLease = activationLease(options);
        activationStarted.resolve();
        await activationBarrier.promise;
        return acquiredLease;
      });
      const input = dependencies(activation);
      const originalAuthentication = vi.fn(() => null);
      input.authentication.authenticatedPrincipalFor = originalAuthentication;
      const replacementAuthentication = vi.fn(() => null);
      const originalAudit = vi.fn(async () => ({ resolvedCount: 0, nextAuditTimeMs: null }));
      input.approvalStorage.hostedTeamApprovalAuditTimeouts = originalAudit;
      const replacementAudit = vi.fn(async () => ({ resolvedCount: 0, nextAuditTimeMs: null }));

      const compositionPromise = createHostedApprovalProductionComposition(input);
      await activationStarted.promise;
      const mutable = input as unknown as {
        authentication: typeof input.authentication;
        approvalStorage: typeof input.approvalStorage;
      };
      if (gateway === 'authentication') {
        if (replacement === 'top-level') {
          mutable.authentication = { authenticatedPrincipalFor: replacementAuthentication };
        } else {
          input.authentication.authenticatedPrincipalFor = replacementAuthentication;
        }
      } else if (replacement === 'top-level') {
        mutable.approvalStorage = {
          ...input.approvalStorage,
          hostedTeamApprovalAuditTimeouts: replacementAudit,
        };
      } else {
        input.approvalStorage.hostedTeamApprovalAuditTimeouts = replacementAudit;
      }
      activationBarrier.resolve();

      await expect(compositionPromise).rejects.toThrow(
        'hosted-approval-production-route-binding-invalid'
      );
      expect(activation).toHaveBeenCalledOnce();
      expect(acquiredLease).not.toBeNull();
      expect(acquiredLease!.isReady()).toBe(false);
      expect(originalAuthentication).not.toHaveBeenCalled();
      expect(replacementAuthentication).not.toHaveBeenCalled();
      expect(originalAudit).not.toHaveBeenCalled();
      expect(replacementAudit).not.toHaveBeenCalled();
    }
  );

  it.each(['replacement', 'reorder', 'truncation', 'socket-drift', 'owner-drift'] as const)(
    'fails closed on route binding during suspended %s mutation',
    async (mutation) => {
      const secondTeamId = `team_${'2'.repeat(32)}`;
      const publisherBinding = globalPublisherBinding(secondTeamId);
      const admissionDocument = serializeHostedApprovalRuntimeAdmissionDocument(
        publisherBinding,
        3,
        7
      );
      const approvalSnapshot = {
        schemaVersion: 1,
        approvalGeneration: 3,
        authorities: publisherBinding.routes.map((route) => route.authority),
      };
      const approvalDigest = digest(JSON.stringify(approvalSnapshot));
      const observedBindings: HostedApprovalRuntimeActivationOptions['binding'][] = [];
      const leases: ReturnType<typeof activationLease>[] = [];
      const activationBarrier = deferred<void>();
      const allActivationCallsStarted = deferred<void>();
      const activation = vi.fn(async (options: HostedApprovalRuntimeActivationOptions) => {
        observedBindings.push(options.binding);
        const lease = activationLease(options);
        leases.push(lease);
        if (activation.mock.calls.length === 2) {
          allActivationCallsStarted.resolve();
        }
        await activationBarrier.promise;
        return lease;
      });
      const input = dependencies(activation);
      const firstRoute = input.ownerAdmission.approvalRoutes[0]!;
      const ownerAdmission = {
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
      } as never as CreateHostedApprovalProductionCompositionDependencies['ownerAdmission'] & {
        approvalRoutes: Array<typeof firstRoute>;
        expectedOwnerBinding: { ownerGeneration: number; ownerSessionId: string };
      };
      const getTeamIdentity = vi.fn(async (teamId: string) => {
        return Object.freeze({
          teamId,
          state: 'active',
          workspaceBinding: Object.freeze({ workspaceId: WORKSPACE_ID, generation: 9 }),
        });
      });
      const teamIdentities = {
        getTeamIdentity,
      } as never;

      const compositionPromise = createHostedApprovalProductionComposition({
        ...input,
        teamIdentities,
        ownerAdmission,
        activationPublication: {
          ...input.activationPublication,
          admissionDocument,
          admissionDocumentDigest: digest(admissionDocument),
        },
      });
      await allActivationCallsStarted.promise;
      if (mutation === 'replacement') {
        ownerAdmission.approvalRoutes = [
          { ...ownerAdmission.approvalRoutes[1]!, socketPath: '/run/replaced.sock' },
        ];
        expect(ownerAdmission.approvalRoutes.map(({ socketPath }) => socketPath)).toEqual([
          '/run/replaced.sock',
        ]);
      } else if (mutation === 'reorder') {
        ownerAdmission.approvalRoutes.reverse();
        expect(ownerAdmission.approvalRoutes.map(({ teamId }) => teamId)).toEqual([
          secondTeamId,
          firstRoute.teamId,
        ]);
      } else if (mutation === 'truncation') {
        ownerAdmission.approvalRoutes.length = 0;
        expect(ownerAdmission.approvalRoutes).toEqual([]);
      } else if (mutation === 'socket-drift') {
        (ownerAdmission.approvalRoutes[0]! as { socketPath: string }).socketPath =
          '/run/drifted.sock';
        expect(ownerAdmission.approvalRoutes[0]!.socketPath).toBe('/run/drifted.sock');
      } else {
        const mutableOwner = ownerAdmission.expectedOwnerBinding as {
          ownerGeneration: number;
          ownerSessionId: string;
        };
        mutableOwner.ownerGeneration = 999;
        mutableOwner.ownerSessionId = 'owner-session_drifted-owner';
        expect(mutableOwner).toEqual({
          ...mutableOwner,
          ownerGeneration: 999,
          ownerSessionId: 'owner-session_drifted-owner',
        });
      }
      expect(getTeamIdentity).toHaveBeenCalledTimes(2);
      expect(activation).toHaveBeenCalledTimes(2);
      activationBarrier.resolve();
      await expect(compositionPromise).rejects.toThrow(
        'hosted-approval-production-route-binding-invalid'
      );
      expect(observedBindings).toHaveLength(2);
      expect(leases).toHaveLength(2);
      expect(leases.every((lease) => lease.isReady() === false)).toBe(true);
    }
  );

  it('rejects route binding drift after suspended identity resolution and before activation', async () => {
    const identityStarted = deferred<void>();
    const identityBarrier = deferred<void>();
    const activation = vi.fn(async (options: HostedApprovalRuntimeActivationOptions) =>
      activationLease(options)
    );
    const input = dependencies(activation);
    const originalGetTeamIdentity = input.teamIdentities.getTeamIdentity.bind(input.teamIdentities);
    input.teamIdentities.getTeamIdentity = vi.fn(async (teamId: string) => {
      identityStarted.resolve();
      await identityBarrier.promise;
      return originalGetTeamIdentity(teamId as never);
    });
    const creating = createHostedApprovalProductionComposition(input);
    await identityStarted.promise;
    (input.ownerAdmission.approvalRoutes[0]! as { socketPath: string }).socketPath =
      '/run/identity-boundary-drift.sock';
    identityBarrier.resolve();

    await expect(creating).rejects.toThrow('hosted-approval-production-route-binding-invalid');
    expect(activation).not.toHaveBeenCalled();
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
    teamIdentities: {
      getTeamIdentity: vi.fn(async (teamId: string) =>
        Object.freeze({
          teamId,
          state: 'active',
          workspaceBinding: Object.freeze({ workspaceId: WORKSPACE_ID, generation: 9 }),
        })
      ),
    } as never,
    approvalStorage: {
      hostedTeamApprovalObserve: vi.fn(),
      hostedTeamApprovalReadPending: vi.fn(),
      hostedTeamApprovalReadPreview: vi.fn(),
      hostedTeamApprovalDecide: vi.fn(),
      hostedTeamApprovalAuditTimeouts: vi.fn(async () => ({
        resolvedCount: 0,
        nextAuditTimeMs: null,
      })),
      hostedTeamApprovalClaimDeliveries: vi.fn(async () => Object.freeze([])),
      hostedTeamApprovalAcknowledgeDelivery: vi.fn(),
      hostedTeamApprovalMarkDeliveryOperatorRequired: vi.fn(),
      hostedTeamApprovalReadDeliveryReconciliation: vi.fn(async () => ({
        kind: 'not_found' as const,
      })),
      hostedTeamApprovalSettleDeliveryReconciliation: vi.fn(),
    },
    producerProvenance: {
      role: 'product-producer',
      controllerNonce: 'controller_activation-test',
      runId: 'run_activation-test',
      emit: vi.fn(),
      bindInvalidation: vi.fn(),
      poison: vi.fn((reason: string) => { throw new Error(reason); }),
      close: vi.fn(),
    },
    createApprovalRuntimeAuthority: (options) => ({
      claimPermissionApprovalIngressEffects: vi.fn(async () => {
        if (options.lease.currentBinding() === null) {
          throw new Error('test-route-binding-unavailable');
        }
        return Object.freeze([]);
      }),
      acknowledgePermissionApprovalIngressEffect: vi.fn(async () => ({
        status: 'acknowledged' as const,
      })),
      resolvePersistedIngressAuthority: vi.fn(async () => ({ status: 'unavailable' as const })),
      deliverRuntimePermissionDecision: vi.fn(async (request) => ({
        status: 'delivered' as const,
        reconciliationRef: request.reconciliationRef,
      })),
      reconcileRuntimePermissionDecision: vi.fn(async () => ({ status: 'delivered' as const })),
      close: vi.fn(),
    }),
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
    mode: 0o600,
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
