import { parseDeploymentId, parseRunId, parseTeamId } from '@shared/contracts/hosted';
import { isTeamProviderId } from '@shared/utils/teamProvider';

import { parseLaneId, type Sha256Hash } from '../../../contracts';

import {
  compareRuntimeIngressIsoInstants,
  isExactRuntimeIngressCredentialScope,
  isRuntimeIngressIsoInstant,
  isRuntimeIngressVerb,
  parseRuntimeIngressCredentialId,
  parseRuntimeIngressSessionId,
  type RuntimeIngressCredentialId,
  type RuntimeIngressCredentialScope,
  type RuntimeIngressSessionId,
} from './RuntimeIngressProtocol';

export type RuntimeIngressCredentialPhase = 'active' | 'revoked';

export interface RuntimeIngressCredential {
  readonly credentialVersion: 1;
  readonly credentialId: RuntimeIngressCredentialId;
  readonly secretDigest: Sha256Hash;
  readonly secretDigestKeyVersion: number;
  readonly scope: RuntimeIngressCredentialScope;
  readonly sessionId: RuntimeIngressSessionId;
  readonly phase: RuntimeIngressCredentialPhase;
  readonly revision: number;
  readonly issuedAtIso: string;
  readonly revokedAtIso: string | null;
  readonly revocationReason: string | null;
}

export interface IssueRuntimeIngressCredentialInput {
  readonly credentialId: RuntimeIngressCredentialId;
  readonly secretDigest: Sha256Hash;
  readonly secretDigestKeyVersion: number;
  readonly scope: RuntimeIngressCredentialScope;
  readonly sessionId: RuntimeIngressSessionId;
  readonly issuedAtIso: string;
}

export type RevokeRuntimeIngressCredentialTransition =
  | { readonly status: 'revoked'; readonly next: RuntimeIngressCredential }
  | { readonly status: 'already_revoked'; readonly credential: RuntimeIngressCredential }
  | { readonly status: 'rejected'; readonly reason: 'invalid_time' | 'invalid_reason' };

export function issueRuntimeIngressCredential(
  input: IssueRuntimeIngressCredentialInput
): RuntimeIngressCredential {
  assertValidCredentialInput(input);
  return Object.freeze({
    credentialVersion: 1,
    credentialId: input.credentialId,
    secretDigest: input.secretDigest,
    secretDigestKeyVersion: input.secretDigestKeyVersion,
    scope: freezeScope(input.scope),
    sessionId: input.sessionId,
    phase: 'active',
    revision: 1,
    issuedAtIso: input.issuedAtIso,
    revokedAtIso: null,
    revocationReason: null,
  });
}

export function revokeRuntimeIngressCredential(
  credential: RuntimeIngressCredential,
  revokedAtIso: string,
  reason: string
): RevokeRuntimeIngressCredentialTransition {
  if (credential.phase === 'revoked') {
    return { status: 'already_revoked', credential };
  }
  const revokedAfterIssue = compareRuntimeIngressIsoInstants(revokedAtIso, credential.issuedAtIso);
  if (revokedAfterIssue === null || revokedAfterIssue < 0) {
    return { status: 'rejected', reason: 'invalid_time' };
  }
  if (typeof reason !== 'string' || reason.length === 0 || reason.length > 256) {
    return { status: 'rejected', reason: 'invalid_reason' };
  }
  return {
    status: 'revoked',
    next: Object.freeze({
      ...credential,
      phase: 'revoked',
      revision: credential.revision + 1,
      revokedAtIso,
      revocationReason: reason,
    }),
  };
}

export function areRuntimeIngressCredentialsExact(
  left: RuntimeIngressCredential,
  right: RuntimeIngressCredential
): boolean {
  return (
    left.credentialVersion === right.credentialVersion &&
    left.credentialId === right.credentialId &&
    left.secretDigest === right.secretDigest &&
    left.secretDigestKeyVersion === right.secretDigestKeyVersion &&
    isExactRuntimeIngressCredentialScope(left.scope, right.scope) &&
    left.sessionId === right.sessionId &&
    left.phase === right.phase &&
    left.revision === right.revision &&
    left.issuedAtIso === right.issuedAtIso &&
    left.revokedAtIso === right.revokedAtIso &&
    left.revocationReason === right.revocationReason
  );
}

export function isRuntimeIngressCredentialRecoverable(
  value: unknown
): value is RuntimeIngressCredential {
  if (!isRecord(value) || !isRecord(value.scope)) return false;
  try {
    parseRuntimeIngressCredentialId(value.credentialId);
    parseRuntimeIngressSessionId(value.sessionId);
    parseDeploymentId(value.scope.deploymentId);
    parseTeamId(value.scope.teamId);
    parseRunId(value.scope.runId);
    parseLaneId(value.scope.laneId);
  } catch {
    return false;
  }
  const allowedVerbs = value.scope.allowedVerbs;
  return (
    value.credentialVersion === 1 &&
    typeof value.secretDigest === 'string' &&
    /^sha256:[0-9a-f]{64}$/.test(value.secretDigest) &&
    isPositiveSafeInteger(value.secretDigestKeyVersion) &&
    isPositiveSafeInteger(value.scope.planGeneration) &&
    isTeamProviderId(value.scope.providerId) &&
    isPositiveSafeInteger(value.scope.credentialGeneration) &&
    Array.isArray(allowedVerbs) &&
    allowedVerbs.length > 0 &&
    new Set(allowedVerbs).size === allowedVerbs.length &&
    allowedVerbs.every(isRuntimeIngressVerb) &&
    (value.phase === 'active' || value.phase === 'revoked') &&
    isPositiveSafeInteger(value.revision) &&
    isRuntimeIngressIsoInstant(value.issuedAtIso) &&
    ((value.phase === 'active' && value.revokedAtIso === null && value.revocationReason === null) ||
      (value.phase === 'revoked' &&
        isRuntimeIngressIsoInstant(value.revokedAtIso) &&
        typeof value.revocationReason === 'string' &&
        value.revocationReason.length > 0 &&
        value.revocationReason.length <= 256 &&
        (compareRuntimeIngressIsoInstants(value.revokedAtIso, value.issuedAtIso) ?? -1) >= 0))
  );
}

function assertValidCredentialInput(input: IssueRuntimeIngressCredentialInput): void {
  parseRuntimeIngressCredentialId(input.credentialId);
  parseRuntimeIngressSessionId(input.sessionId);
  if (!/^sha256:[0-9a-f]{64}$/.test(input.secretDigest)) {
    throw new TypeError('runtime-ingress-secret-digest-invalid');
  }
  if (!Number.isSafeInteger(input.secretDigestKeyVersion) || input.secretDigestKeyVersion < 1) {
    throw new TypeError('runtime-ingress-secret-digest-key-version-invalid');
  }
  if (!isRuntimeIngressIsoInstant(input.issuedAtIso)) {
    throw new TypeError('runtime-ingress-issued-at-invalid');
  }
  assertValidScope(input.scope);
}

function assertValidScope(scope: RuntimeIngressCredentialScope): void {
  parseDeploymentId(scope.deploymentId);
  parseTeamId(scope.teamId);
  parseRunId(scope.runId);
  parseLaneId(scope.laneId);
  if (!Number.isSafeInteger(scope.planGeneration) || scope.planGeneration < 1) {
    throw new TypeError('runtime-ingress-plan-generation-invalid');
  }
  if (!isTeamProviderId(scope.providerId)) {
    throw new TypeError('runtime-ingress-provider-id-invalid');
  }
  if (!Number.isSafeInteger(scope.credentialGeneration) || scope.credentialGeneration < 1) {
    throw new TypeError('runtime-ingress-credential-generation-invalid');
  }
  if (
    scope.allowedVerbs.length === 0 ||
    new Set(scope.allowedVerbs).size !== scope.allowedVerbs.length ||
    scope.allowedVerbs.some((verb) => !isRuntimeIngressVerb(verb))
  ) {
    throw new TypeError('runtime-ingress-allowed-verbs-invalid');
  }
}

function freezeScope(scope: RuntimeIngressCredentialScope): RuntimeIngressCredentialScope {
  return Object.freeze({
    ...scope,
    allowedVerbs: Object.freeze([...scope.allowedVerbs]),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
