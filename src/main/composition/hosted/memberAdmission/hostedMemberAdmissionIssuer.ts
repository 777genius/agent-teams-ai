import { createHash, createPublicKey, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  parseBootId,
  parseDeploymentId,
  parseRunId,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';

import {
  createMemberAdmissionSigner,
  type FrozenMemberAdmissionRecord,
  type MemberAdmissionPrivateKeyProvider,
} from './hostedMemberAdmission';
import { memberStartOperationId } from './hostedMemberStartResolution';

import type { KeyObject } from 'node:crypto';

const SHA = /^[0-9a-f]{64}$/u;
const OWNER_SESSION = /^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const POLICY_ID = 'hosted-opencode-member-v1';

/** Captured only from trusted launch configuration; no field comes from HTTP or an agent. */
export interface HostedMemberIssuerBinding {
  readonly runId: string;
  readonly deploymentId: string;
  readonly bootId: string;
  readonly workspaceId: string;
  readonly runtimeWorkspaceId: string;
  readonly teamId: string;
  readonly restoreGeneration: number;
  readonly mountGeneration: number;
  readonly ownerGeneration: number;
  readonly ownerSessionId: string;
  readonly planSha256: string;
  /** SHA-256 of the Product Ed25519 public key's DER SPKI bytes. */
  readonly spkiSha256: string;
}

/** Same shape as the private Product worker client, without a cross-feature private import. */
export interface HostedCurrentMemberReader {
  resolve(
    runId: string,
    memberId: string
  ): Promise<null | Readonly<{
    kind: 'admitted';
    runId: string;
    deploymentId: string;
    bootId: string;
    workspaceId: string;
    runtimeWorkspaceId: string;
    teamId: string;
    memberId: string;
    laneId: string;
    memberOrdinal: number;
    memberName: string;
    model: string;
    promptSha256: string;
    planSha256: string;
    grantRevision: string;
    restoreGeneration: number;
    mountGeneration: number;
  }>>;
}

/** Must read current Owner state and fail on revoked session, changed generation or run. */
export interface HostedCurrentOwnerBindingAuthority {
  assertCurrent(binding: HostedMemberIssuerBinding): Promise<void>;
}

function validGeneration(value: number, minimum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum;
}

function validBinding(binding: HostedMemberIssuerBinding): void {
  parseRunId(binding.runId);
  parseDeploymentId(binding.deploymentId);
  parseBootId(binding.bootId);
  parseWorkspaceId(binding.workspaceId);
  parseWorkspaceId(binding.runtimeWorkspaceId);
  parseTeamId(binding.teamId);
  if (
    !validGeneration(binding.restoreGeneration, 0) ||
    !validGeneration(binding.mountGeneration, 1) ||
    !validGeneration(binding.ownerGeneration, 1) ||
    !OWNER_SESSION.test(binding.ownerSessionId) ||
    !SHA.test(binding.planSha256) ||
    !SHA.test(binding.spkiSha256)
  ) {
    throw new Error('member-admission-trusted-binding-invalid');
  }
}

/**
 * Inactive Product issuer. Its signature records a current point-in-time decision only.
 * Root must revalidate Owner/Product fences at the effect boundary before starting a member.
 */
export function createHostedMemberAdmissionIssuer(input: {
  readonly trustedBinding: HostedMemberIssuerBinding;
  readonly memberReader: HostedCurrentMemberReader;
  readonly ownerAuthority: HostedCurrentOwnerBindingAuthority;
  /** Supply the inherited-FD provider from trusted Product composition. */
  readonly privateKeyProvider: MemberAdmissionPrivateKeyProvider & { dispose(): void };
  readonly now?: () => number;
  readonly randomAdmissionId?: () => string;
}): { issue(runId: string, memberId: string): Promise<Buffer>; dispose(): void } {
  if (
    !input ||
    !input.trustedBinding ||
    typeof input.memberReader?.resolve !== 'function' ||
    typeof input.ownerAuthority?.assertCurrent !== 'function' ||
    typeof input.privateKeyProvider?.loadPrivateKey !== 'function' ||
    typeof input.privateKeyProvider.dispose !== 'function'
  ) {
    throw new Error('member-admission-issuer-ports-invalid');
  }
  validBinding(input.trustedBinding);
  const binding = Object.freeze({ ...input.trustedBinding });
  const resolveMember = input.memberReader.resolve.bind(input.memberReader);
  const assertCurrentOwner = input.ownerAuthority.assertCurrent.bind(input.ownerAuthority);
  const loadPrivateKey = input.privateKeyProvider.loadPrivateKey.bind(input.privateKeyProvider);
  const disposeKey = input.privateKeyProvider.dispose.bind(input.privateKeyProvider);
  const expectedPin = Buffer.from(binding.spkiSha256, 'hex');

  async function resolveRecord(
    runId: string,
    memberId: string
  ): Promise<FrozenMemberAdmissionRecord> {
    if (runId !== binding.runId) throw new Error('member-admission-run-mismatch');
    const current = await resolveMember(runId, memberId);
    if (
      current?.kind !== 'admitted' ||
      current.runId !== runId ||
      current.memberId !== memberId ||
      current.deploymentId !== binding.deploymentId ||
      current.bootId !== binding.bootId ||
      current.workspaceId !== binding.workspaceId ||
      current.runtimeWorkspaceId !== binding.runtimeWorkspaceId ||
      current.teamId !== binding.teamId ||
      current.restoreGeneration !== binding.restoreGeneration ||
      current.mountGeneration !== binding.mountGeneration ||
      current.planSha256 !== binding.planSha256 ||
      typeof current.grantRevision !== 'string' ||
      !SHA.test(current.grantRevision)
    ) {
      throw new Error('member-admission-current-member-unavailable');
    }
    return Object.freeze({
      operationId: memberStartOperationId(runId, memberId, current.planSha256),
      deploymentId: binding.deploymentId,
      bootId: binding.bootId,
      restoreGeneration: binding.restoreGeneration,
      ownerGeneration: binding.ownerGeneration,
      ownerSessionId: binding.ownerSessionId,
      workspaceId: binding.workspaceId,
      mountGeneration: binding.mountGeneration,
      grantRevision: current.grantRevision,
      planSha256: current.planSha256,
      planGeneration: `plan-generation_${current.planSha256}`,
      teamId: binding.teamId,
      runId,
      laneId: current.laneId,
      memberId,
      memberName: current.memberName,
      memberOrdinal: current.memberOrdinal,
      model: current.model,
      promptSha256: current.promptSha256,
      policyId: POLICY_ID,
    });
  }

  const privateKeyProvider = Object.freeze({
    async loadPrivateKey(): Promise<KeyObject> {
      const key = await loadPrivateKey();
      if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
        throw new Error('member-admission-key-invalid');
      }
      const actualPin = createHash('sha256')
        .update(createPublicKey(key).export({ format: 'der', type: 'spki' }))
        .digest();
      if (!timingSafeEqual(actualPin, expectedPin)) {
        throw new Error('member-admission-key-pin-mismatch');
      }
      return key;
    },
  });
  const signer = createMemberAdmissionSigner({
    productAuthority: {
      resolveFrozenMember: resolveRecord,
      async assertCurrent(record): Promise<void> {
        await assertCurrentOwner(binding);
        const current = await resolveRecord(record.runId, record.memberId);
        if (!isDeepStrictEqual(current, record)) {
          throw new Error('member-admission-current-member-changed');
        }
      },
    },
    privateKeyProvider,
    now: input.now,
    randomAdmissionId: input.randomAdmissionId,
  });
  return Object.freeze({
    async issue(runId: string, memberId: string): Promise<Buffer> {
      try {
        return await signer.issue(runId, memberId);
      } catch (error) {
        disposeKey();
        throw error;
      }
    },
    dispose(): void {
      disposeKey();
    },
  });
}
