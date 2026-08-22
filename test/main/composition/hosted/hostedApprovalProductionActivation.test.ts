import { createHash } from 'node:crypto';

import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import { describe, expect, it, vi } from 'vitest';

import { createHostedApprovalProductionComposition } from '../../../../src/main/composition/hosted/createHostedApprovalProductionComposition';

import type {
  HostedApprovalRuntimeActivationLease,
  HostedApprovalRuntimeActivationOptions,
} from '../../../../src/main/services/team/provisioning/HostedApprovalRuntimeActivationEnvelope';

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

describe('hosted approval production activation', () => {
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
      approvalDigest: APPROVAL_DIGEST,
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
    expect(options.admission).toBe(SNAPSHOT);

    const lease = activationLease(options);
    ready.resolve(lease);
    const composition = await creating;
    expect(resolved).toBe(true);
    expect(activation).toHaveBeenCalledOnce();
    composition.close();
    expect(lease.isReady()).toBe(false);
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
) {
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
    activateApprovalRuntime,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
