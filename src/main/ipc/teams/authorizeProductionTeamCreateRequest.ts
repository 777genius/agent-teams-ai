import {
  bindAuthoritativeModelExecutionProof,
  verifyAuthoritativeModelExecutionProofForRequest,
} from '@main/services/team/TeamLaunchExecutionProofAuthority';
import { TeamRosterAuthorizationTransactionService } from '@main/services/team/TeamRosterAuthorizationTransactionService';
import { randomUUID } from 'crypto';

import type { TeamCreateRequest, TeamLaunchRequest, TeamMember } from '@shared/types';

const productionLaunchAdmissionBrand: unique symbol = Symbol('production-launch-admission');

export interface ProductionLaunchAdmissionLease {
  readonly [productionLaunchAdmissionBrand]: true;
  readonly executionProof: NonNullable<TeamLaunchRequest['executionProof']>;
  readonly launchRequestFingerprint: string;
}

interface PendingProductionLaunchAdmission {
  requestFingerprint: string;
  lease: ProductionLaunchAdmissionLease;
}

const pendingAdmissions = new WeakMap<object, PendingProductionLaunchAdmission>();
const claimedAdmissions = new WeakSet<ProductionLaunchAdmissionLease>();

function omitUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitUndefined);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, omitUndefined(item)])
  );
}

export function fingerprintProductionLaunchRequest(
  request: TeamCreateRequest | TeamLaunchRequest,
  members: readonly TeamMember[]
): string {
  const {
    executionProof: _executionProof,
    rosterLaunchBinding: _rosterLaunchBinding,
    rosterTransactionId: _rosterTransactionId,
    ...semanticRequest
  } = request;
  return TeamRosterAuthorizationTransactionService.requestFingerprint(
    omitUndefined({
      ...semanticRequest,
      // Production assigns this only after proof verification. The durable roster
      // ledger and binding carry transaction identity separately.
      rosterTransactionId: null,
      providerId: request.providerId ?? 'anthropic',
      providerBackendId: request.providerBackendId ?? null,
      model: request.model ?? null,
      effort: request.effort ?? null,
      leadRuntimeSelectionProvenance: request.leadRuntimeSelectionProvenance ?? null,
      allowExperimentalLocalModels: request.allowExperimentalLocalModels === true,
      members: [...members].sort((left, right) => {
        const byName = left.name
          .trim()
          .toLowerCase()
          .localeCompare(right.name.trim().toLowerCase());
        return (
          byName ||
          TeamRosterAuthorizationTransactionService.requestFingerprint(
            omitUndefined(left)
          ).localeCompare(
            TeamRosterAuthorizationTransactionService.requestFingerprint(omitUndefined(right))
          )
        );
      }),
    })
  );
}

function authorizeProductionRequest<T extends TeamCreateRequest | TeamLaunchRequest>(
  request: T,
  members: readonly TeamMember[],
  required: boolean
): T {
  if (!required) return request;
  const proof = request.executionProof;
  if (!proof || !verifyAuthoritativeModelExecutionProofForRequest(proof, request, members)) {
    throw new Error('Fresh authoritative launch authorization is required');
  }
  const fingerprint = fingerprintProductionLaunchRequest(request, members);
  const executionProof = bindAuthoritativeModelExecutionProof(proof, fingerprint, fingerprint);
  pendingAdmissions.set(executionProof, {
    requestFingerprint: fingerprint,
    lease: Object.freeze({
      [productionLaunchAdmissionBrand]: true as const,
      executionProof,
      launchRequestFingerprint: fingerprint,
    }),
  });
  return {
    ...request,
    executionProof,
  };
}

export function assignProductionRosterTransactionId<
  T extends TeamCreateRequest | TeamLaunchRequest,
>(request: T, required: boolean): T {
  if (!required || request.rosterTransactionId) return request;
  return { ...request, rosterTransactionId: randomUUID() };
}

export function claimProductionLaunchAdmission(
  request: TeamCreateRequest | TeamLaunchRequest,
  members: readonly TeamMember[],
  required: boolean
): ProductionLaunchAdmissionLease | undefined {
  if (!required) return undefined;
  const proof = request.executionProof;
  if (!proof) throw new Error('Fresh authoritative launch authorization is required');
  const pending = pendingAdmissions.get(proof);
  const fingerprint = fingerprintProductionLaunchRequest(request, members);
  if (!pending || pending.requestFingerprint !== fingerprint) {
    throw new Error('Fresh authoritative launch authorization is required');
  }
  pendingAdmissions.delete(proof);
  claimedAdmissions.add(pending.lease);
  return pending.lease;
}

export function consumeProductionLaunchAdmission(
  admission: ProductionLaunchAdmissionLease
): ProductionLaunchAdmissionLease {
  if (!claimedAdmissions.has(admission)) {
    throw new Error('Production launch admission is stale or already used');
  }
  claimedAdmissions.delete(admission);
  return admission;
}

export function authorizeProductionTeamCreateRequest(
  request: TeamCreateRequest,
  required: boolean
): TeamCreateRequest {
  return authorizeProductionRequest(request, request.members, required);
}

/** Read-only admission check used before create can open its durable roster transaction. */
export function verifyProductionTeamCreateRequest(
  request: TeamCreateRequest,
  required: boolean
): boolean {
  return (
    !required ||
    (request.executionProof !== undefined &&
      verifyAuthoritativeModelExecutionProofForRequest(
        request.executionProof,
        request,
        request.members
      ))
  );
}

export function verifyProductionTeamLaunchRequest(
  request: TeamLaunchRequest,
  members: readonly TeamMember[],
  required: boolean
): boolean {
  return (
    !required ||
    (request.executionProof !== undefined &&
      verifyAuthoritativeModelExecutionProofForRequest(request.executionProof, request, members))
  );
}

export function authorizeProductionTeamLaunchRequest(
  request: TeamLaunchRequest,
  members: readonly TeamMember[],
  required: boolean
): TeamLaunchRequest {
  return authorizeProductionRequest(request, members, required);
}
