import {
  COMMAND_IDEMPOTENCY_SCOPE,
  type CommandClaimScope,
  type CommandDescriptor,
  type CommandFingerprintRecord,
  createCommandClaimScope,
  type EffectDescriptor,
  HMAC_SHA256_LD_V1,
  type NormalizedCommandIntent,
  prepareCommandFingerprint,
} from '@features/application-command-ledger';
import { type MemberId, parseMemberId } from '@shared/contracts/hosted';

import {
  doBodyIdentityAssertionsMatchAuthority,
  isCredentialScopeAuthorizedFor,
  isRuntimeIngressCredentialRecoverable,
  isRuntimeIngressIsoInstant,
  isRuntimeIngressSequence,
  isRuntimeIngressSessionStateRecoverable,
  isRuntimeIngressVerb,
  isSessionBoundToCredential,
  parseRuntimeIngressAcknowledgementId,
  parseRuntimeIngressCommandId,
  parseRuntimeIngressCredentialId,
  parseRuntimeIngressEffectRef,
  parseRuntimeIngressRuntimeInstanceId,
  parseRuntimeIngressSessionId,
  prepareRuntimeIngressAcceptance,
  type PresentedRuntimeIngressCredential,
  RUNTIME_INGRESS_VERBS,
  type RuntimeIngressAuthority,
  type RuntimeIngressBodyIdentityAssertions,
  type RuntimeIngressCanonicalEffect,
  type RuntimeIngressCommandId,
  type RuntimeIngressCredential,
  type RuntimeIngressEffectAcknowledgement,
  type RuntimeIngressReplayKey,
  type RuntimeIngressRuntimeInstanceId,
  type RuntimeIngressSessionId,
  type RuntimeIngressSessionState,
  type RuntimeIngressVerb,
} from '../../domain/runtime-ingress';

import { readCommittedAcknowledgement } from './RuntimeIngressReplayEvidence';

import type {
  ApplyRuntimeIngressAtomicallyResult,
  FingerprintRuntimeIngressCommandResult,
  LoadRuntimeIngressCommandResult,
  RuntimeIngressClockPort,
  RuntimeIngressDurableRecoveryPort,
  VerifyRuntimeIngressCredentialResult,
} from './ports';

const RUNTIME_INGRESS_RECONCILE_LIMIT = 3;
const RUNTIME_INGRESS_EFFECTS = Object.freeze([
  Object.freeze({
    effectId: 'commit-runtime-ingress-acceptance',
    effectVersion: 1,
    recoveryClass: 'transactional_local',
    evidenceSchemaVersion: 1,
  }),
]) as readonly [EffectDescriptor];

export interface RuntimeIngressCommandIntent {
  readonly authority: RuntimeIngressAuthority;
  readonly credentialId: string;
  readonly sessionId: string;
  readonly runtimeInstanceId: string;
  readonly deliveryOwnerId: string;
  readonly commandId: string;
  readonly sequence: number;
  readonly observedAtIso: string;
  readonly payloadJson: string;
}

export const RUNTIME_INGRESS_COMMAND_DESCRIPTORS: readonly CommandDescriptor<
  RuntimeIngressCommandIntent,
  RuntimeIngressVerb
>[] = Object.freeze(
  RUNTIME_INGRESS_VERBS.map((verb) =>
    Object.freeze({
      descriptorId: `team-runtime-control.${verb}`,
      descriptorVersion: 1,
      commandKind: verb,
      inputSchemaVersion: 1,
      fingerprintVersion: HMAC_SHA256_LD_V1,
      effectPlanVersion: 1,
      idempotencyScope: COMMAND_IDEMPOTENCY_SCOPE,
      retentionClass: 'runtime-ingress-receipt',
      normalizedIntentProjection: projectRuntimeIngressCommandIntent,
      effects: RUNTIME_INGRESS_EFFECTS,
    })
  )
);

export interface ExecuteRuntimeIngressRequest {
  /** Fixed relay/route authority. It must not be populated from provider JSON. */
  readonly authority: RuntimeIngressAuthority;
  readonly presentedCredential: PresentedRuntimeIngressCredential;
  readonly sessionId: RuntimeIngressSessionId;
  readonly runtimeInstanceId: RuntimeIngressRuntimeInstanceId;
  /** Persisted session owner selected by server-side roster/lane state. */
  readonly deliveryOwnerId: MemberId;
  readonly commandId: RuntimeIngressCommandId;
  readonly sequence: number;
  readonly observedAtIso: string;
  readonly effect: RuntimeIngressCanonicalEffect;
  readonly bodyIdentityAssertions?: RuntimeIngressBodyIdentityAssertions;
}

export type ExecuteRuntimeIngressOutcome =
  | {
      readonly status: 'accepted' | 'replayed';
      readonly acknowledgement: RuntimeIngressEffectAcknowledgement;
    }
  | {
      readonly status: 'rejected';
      readonly reason:
        | 'credential_invalid'
        | 'credential_unavailable'
        | 'credential_scope_mismatch'
        | 'body_authority_mismatch'
        | 'session_unavailable'
        | 'session_invalid'
        | 'session_scope_mismatch'
        | 'delivery_owner_mismatch'
        | 'bootstrap_required'
        | 'bootstrap_already_accepted'
        | 'runtime_instance_mismatch'
        | 'event_not_fresh'
        | 'event_out_of_order'
        | 'sequence_out_of_order'
        | 'replay_conflict'
        | 'recovery_required'
        | 'concurrency_conflict'
        | 'storage_unavailable'
        | 'protocol_invalid';
    };

export class ExecuteRuntimeIngress {
  constructor(
    private readonly recovery: RuntimeIngressDurableRecoveryPort,
    private readonly clock: RuntimeIngressClockPort
  ) {}

  async execute(request: ExecuteRuntimeIngressRequest): Promise<ExecuteRuntimeIngressOutcome> {
    if (!isValidRequestEnvelope(request)) {
      return { status: 'rejected', reason: 'protocol_invalid' };
    }
    if (
      !doBodyIdentityAssertionsMatchAuthority(request.bodyIdentityAssertions, request.authority)
    ) {
      return { status: 'rejected', reason: 'body_authority_mismatch' };
    }

    const verification = await this.verifyCredential(request);
    if (verification.status !== 'verified') {
      return {
        status: 'rejected',
        reason:
          verification.status === 'unavailable' ? 'credential_unavailable' : 'credential_invalid',
      };
    }
    const credential = verification.credential;
    if (
      !isRuntimeIngressCredentialRecoverable(credential) ||
      credential.phase !== 'active' ||
      credential.credentialId !== request.presentedCredential.credentialId
    ) {
      return { status: 'rejected', reason: 'credential_invalid' };
    }
    if (
      credential.sessionId !== request.sessionId ||
      !isCredentialScopeAuthorizedFor(credential.scope, request.authority)
    ) {
      return { status: 'rejected', reason: 'credential_scope_mismatch' };
    }

    const descriptor = descriptorFor(request.authority.verb);
    const intent = createRuntimeIngressCommandIntent(request, credential.credentialId);
    const claimScope = createRuntimeIngressClaimScope(request);
    const prepared = prepareCommandFingerprint(descriptor, intent);
    const fingerprinted = await this.fingerprintCommand({ scope: claimScope, prepared });
    if (fingerprinted.status !== 'fingerprinted') {
      return { status: 'rejected', reason: 'storage_unavailable' };
    }
    const fingerprint = fingerprinted.fingerprint;
    const replayKey = createReplayKey(request, credential.credentialId);

    let loaded = await this.loadActiveSession(request.sessionId, credential);
    if (loaded.status !== 'found') {
      return loaded.outcome;
    }

    const persisted = await this.loadCommand({
      scope: claimScope,
      fingerprint,
      expectedCredential: credential,
      expectedSession: loaded.session,
    });
    if (persisted.status === 'credential_inactive') {
      return { status: 'rejected', reason: 'credential_invalid' };
    }
    if (persisted.status === 'session_conflict') {
      return { status: 'rejected', reason: 'session_scope_mismatch' };
    }
    if (persisted.status === 'fingerprint_conflict') {
      return { status: 'rejected', reason: 'replay_conflict' };
    }
    if (persisted.status === 'unavailable') {
      return { status: 'rejected', reason: 'storage_unavailable' };
    }
    if (persisted.status === 'found') {
      const acknowledgement = readCommittedAcknowledgement(
        persisted.command,
        descriptor,
        claimScope,
        fingerprint,
        replayKey
      );
      return acknowledgement
        ? { status: 'replayed', acknowledgement }
        : { status: 'rejected', reason: 'recovery_required' };
    }

    for (let attempt = 0; attempt < RUNTIME_INGRESS_RECONCILE_LIMIT; attempt += 1) {
      if (attempt > 0) {
        loaded = await this.loadActiveSession(request.sessionId, credential);
        if (loaded.status !== 'found') {
          return loaded.outcome;
        }
        const reconciled = await this.loadCommand({
          scope: claimScope,
          fingerprint,
          expectedCredential: credential,
          expectedSession: loaded.session,
        });
        switch (reconciled.status) {
          case 'found': {
            const acknowledgement = readCommittedAcknowledgement(
              reconciled.command,
              descriptor,
              claimScope,
              fingerprint,
              replayKey
            );
            return acknowledgement
              ? { status: 'replayed', acknowledgement }
              : { status: 'rejected', reason: 'recovery_required' };
          }
          case 'fingerprint_conflict':
            return { status: 'rejected', reason: 'replay_conflict' };
          case 'credential_inactive':
            return { status: 'rejected', reason: 'credential_invalid' };
          case 'unavailable':
            return { status: 'rejected', reason: 'storage_unavailable' };
          case 'session_conflict':
            continue;
          case 'missing':
            break;
        }
      }

      const acceptedAtIso = this.clock.nowIso();
      if (!isRuntimeIngressIsoInstant(acceptedAtIso)) {
        return { status: 'rejected', reason: 'protocol_invalid' };
      }
      const acknowledgement = createAcknowledgement(replayKey, acceptedAtIso, fingerprint);
      const transition = prepareRuntimeIngressAcceptance({
        session: loaded.session,
        credential,
        replayKey,
        acknowledgement,
      });
      if (transition.status === 'rejected') {
        return {
          status: 'rejected',
          reason: mapSessionTransitionReason(transition.reason),
        };
      }

      const applied = await this.applyAtomically({
        descriptor,
        claimScope,
        fingerprint,
        expectedCredential: credential,
        expectedSession: loaded.session,
        nextSession: transition.next,
        effect: request.effect,
        acknowledgement,
      });
      switch (applied.status) {
        case 'applied':
        case 'duplicate': {
          const committed = readCommittedAcknowledgement(
            applied.command,
            descriptor,
            claimScope,
            fingerprint,
            replayKey
          );
          if (!committed) return { status: 'rejected', reason: 'recovery_required' };
          return {
            status: applied.status === 'applied' ? 'accepted' : 'replayed',
            acknowledgement: committed,
          };
        }
        case 'fingerprint_conflict':
        case 'sequence_conflict':
          return { status: 'rejected', reason: 'replay_conflict' };
        case 'credential_inactive':
          return { status: 'rejected', reason: 'credential_invalid' };
        case 'recovery_required':
          return { status: 'rejected', reason: 'recovery_required' };
        case 'unavailable':
          return { status: 'rejected', reason: 'storage_unavailable' };
        case 'session_conflict':
          break;
      }
    }
    return { status: 'rejected', reason: 'concurrency_conflict' };
  }

  private async verifyCredential(
    request: ExecuteRuntimeIngressRequest
  ): Promise<VerifyRuntimeIngressCredentialResult> {
    try {
      return await this.recovery.verifyCredential({
        presented: request.presentedCredential,
      });
    } catch {
      return { status: 'unavailable' as const };
    }
  }

  private async loadActiveSession(
    sessionId: RuntimeIngressSessionId,
    credential: RuntimeIngressCredential
  ): Promise<
    | { readonly status: 'found'; readonly session: RuntimeIngressSessionState }
    | { readonly status: 'rejected'; readonly outcome: ExecuteRuntimeIngressOutcome }
  > {
    try {
      const loaded = await this.recovery.loadSession(sessionId);
      if (loaded.status !== 'found') {
        return {
          status: 'rejected',
          outcome: {
            status: 'rejected',
            reason: loaded.status === 'missing' ? 'session_unavailable' : 'storage_unavailable',
          },
        };
      }
      if (!isRuntimeIngressSessionStateRecoverable(loaded.session)) {
        return {
          status: 'rejected',
          outcome: { status: 'rejected', reason: 'session_invalid' },
        };
      }
      if (!isSessionBoundToCredential(loaded.session, credential)) {
        return {
          status: 'rejected',
          outcome: { status: 'rejected', reason: 'session_scope_mismatch' },
        };
      }
      return { status: 'found', session: loaded.session };
    } catch {
      return {
        status: 'rejected',
        outcome: { status: 'rejected', reason: 'storage_unavailable' },
      };
    }
  }

  private async fingerprintCommand(
    request: Parameters<RuntimeIngressDurableRecoveryPort['fingerprintCommand']>[0]
  ): Promise<FingerprintRuntimeIngressCommandResult> {
    try {
      return await this.recovery.fingerprintCommand(request);
    } catch {
      return { status: 'unavailable' as const };
    }
  }

  private async loadCommand(
    request: Parameters<RuntimeIngressDurableRecoveryPort['loadCommand']>[0]
  ): Promise<LoadRuntimeIngressCommandResult> {
    try {
      return await this.recovery.loadCommand(request);
    } catch {
      return { status: 'unavailable' as const };
    }
  }

  private async applyAtomically(
    request: Parameters<RuntimeIngressDurableRecoveryPort['applyAtomically']>[0]
  ): Promise<ApplyRuntimeIngressAtomicallyResult> {
    try {
      return await this.recovery.applyAtomically(request);
    } catch {
      return { status: 'unavailable' as const };
    }
  }
}

function projectRuntimeIngressCommandIntent(
  input: RuntimeIngressCommandIntent
): NormalizedCommandIntent {
  return {
    deploymentId: input.authority.deploymentId,
    teamId: input.authority.teamId,
    runId: input.authority.runId,
    planGeneration: input.authority.planGeneration,
    laneId: input.authority.laneId,
    providerId: input.authority.providerId,
    credentialGeneration: input.authority.credentialGeneration,
    verb: input.authority.verb,
    credentialId: input.credentialId,
    sessionId: input.sessionId,
    runtimeInstanceId: input.runtimeInstanceId,
    deliveryOwnerId: input.deliveryOwnerId,
    commandId: input.commandId,
    sequence: input.sequence,
    observedAtIso: input.observedAtIso,
    payloadJson: input.payloadJson,
  };
}

function createRuntimeIngressCommandIntent(
  request: ExecuteRuntimeIngressRequest,
  credentialId: string
): RuntimeIngressCommandIntent {
  return {
    authority: request.authority,
    credentialId,
    sessionId: request.sessionId,
    runtimeInstanceId: request.runtimeInstanceId,
    deliveryOwnerId: request.deliveryOwnerId,
    commandId: request.commandId,
    sequence: request.sequence,
    observedAtIso: request.observedAtIso,
    payloadJson: request.effect.payloadJson,
  };
}

function createRuntimeIngressClaimScope(
  request: ExecuteRuntimeIngressRequest
): CommandClaimScope<RuntimeIngressVerb> {
  return createCommandClaimScope({
    deploymentId: request.authority.deploymentId,
    stableActorId: JSON.stringify([
      request.authority.teamId,
      request.authority.runId,
      request.authority.laneId,
      request.authority.providerId,
      request.sessionId,
    ]),
    commandKind: request.authority.verb,
    idempotencyKey: request.commandId,
  });
}

function descriptorFor(
  verb: RuntimeIngressVerb
): CommandDescriptor<RuntimeIngressCommandIntent, RuntimeIngressVerb> {
  const descriptor = RUNTIME_INGRESS_COMMAND_DESCRIPTORS.find(
    (candidate) => candidate.commandKind === verb
  );
  if (!descriptor) throw new TypeError('runtime-ingress-command-descriptor-missing');
  return descriptor;
}

function createReplayKey(
  request: ExecuteRuntimeIngressRequest,
  credentialId: RuntimeIngressReplayKey['credentialId']
): RuntimeIngressReplayKey {
  return Object.freeze({
    authority: request.authority,
    credentialId,
    sessionId: request.sessionId,
    runtimeInstanceId: request.runtimeInstanceId,
    deliveryOwnerId: request.deliveryOwnerId,
    commandId: request.commandId,
    sequence: request.sequence,
    observedAtIso: request.observedAtIso,
  });
}

function createAcknowledgement(
  replayKey: RuntimeIngressReplayKey,
  acceptedAtIso: string,
  fingerprint: CommandFingerprintRecord
): RuntimeIngressEffectAcknowledgement {
  return Object.freeze({
    acknowledgementVersion: 1,
    acknowledgementId: acknowledgementIdFor(fingerprint),
    effectRef: effectRefFor(fingerprint),
    replayKey,
    acceptedAtIso,
  });
}

function acknowledgementIdFor(
  fingerprint: CommandFingerprintRecord
): RuntimeIngressEffectAcknowledgement['acknowledgementId'] {
  return parseRuntimeIngressAcknowledgementId(`ack:${fingerprint.digest}`);
}

function effectRefFor(
  fingerprint: CommandFingerprintRecord
): RuntimeIngressEffectAcknowledgement['effectRef'] {
  return parseRuntimeIngressEffectRef(`effect:${fingerprint.digest}`);
}

function isValidRequestEnvelope(request: ExecuteRuntimeIngressRequest): boolean {
  try {
    parseRuntimeIngressCredentialId(request.presentedCredential.credentialId);
    parseRuntimeIngressSessionId(request.sessionId);
    parseRuntimeIngressCommandId(request.commandId);
    parseRuntimeIngressRuntimeInstanceId(request.runtimeInstanceId);
    parseMemberId(request.deliveryOwnerId);
  } catch {
    return false;
  }
  return (
    isRuntimeIngressVerb(request.authority.verb) &&
    isRuntimeIngressSequence(request.sequence) &&
    isRuntimeIngressIsoInstant(request.observedAtIso) &&
    isCanonicalEffect(request.effect)
  );
}

function isCanonicalEffect(effect: RuntimeIngressCanonicalEffect): boolean {
  if (typeof effect.payloadJson !== 'string') return false;
  try {
    const value = JSON.parse(effect.payloadJson) as unknown;
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      JSON.stringify(value) === effect.payloadJson
    );
  } catch {
    return false;
  }
}

function mapSessionTransitionReason(
  reason:
    | 'session_revoked'
    | 'credential_mismatch'
    | 'authority_mismatch'
    | 'delivery_owner_mismatch'
    | 'bootstrap_required'
    | 'bootstrap_already_accepted'
    | 'runtime_instance_mismatch'
    | 'event_not_fresh'
    | 'event_out_of_order'
    | 'sequence_out_of_order'
): Extract<ExecuteRuntimeIngressOutcome, { status: 'rejected' }>['reason'] {
  switch (reason) {
    case 'delivery_owner_mismatch':
    case 'bootstrap_required':
    case 'bootstrap_already_accepted':
    case 'runtime_instance_mismatch':
    case 'event_not_fresh':
    case 'event_out_of_order':
    case 'sequence_out_of_order':
      return reason;
    case 'session_revoked':
    case 'credential_mismatch':
    case 'authority_mismatch':
      return 'session_scope_mismatch';
  }
}
