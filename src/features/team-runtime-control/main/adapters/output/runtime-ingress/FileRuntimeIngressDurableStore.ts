import { basename, isAbsolute } from 'node:path';

import {
  buildCommandFingerprintRecord,
  encodeCommandFingerprintPreimage,
  resolveCommandClaim,
  selectCommandFingerprintKeyVersion,
} from '@features/application-command-ledger';

import { RUNTIME_INGRESS_BEARER_MIN_LENGTH } from '../../../../contracts/runtime-ingress-http';
import {
  type ApplyRuntimeIngressAtomicallyRequest,
  type ApplyRuntimeIngressAtomicallyResult,
  type FingerprintRuntimeIngressCommandRequest,
  type LoadRuntimeIngressCommandRequest,
  type RevokeRuntimeIngressCredentialAtomicallyRequest,
  type RuntimeIngressDurableAntiRollbackFencePort,
  type RuntimeIngressDurableRecoveryPort,
  type RuntimeIngressRelayAuthority,
  type RuntimeIngressRelayBinding,
  type VerifyRuntimeIngressCredentialRequest,
} from '../../../../core/application/runtime-ingress';
import {
  areRuntimeIngressCredentialsExact,
  initializeRuntimeIngressSessionState,
  isRuntimeIngressCredentialRecoverable,
  isRuntimeIngressSessionStateRecoverable,
  isSessionBoundToCredential,
  issueRuntimeIngressCredential,
  type PresentedRuntimeIngressCredential,
  revokeRuntimeIngressCredential,
  revokeRuntimeIngressSessionState,
  type RuntimeIngressCredential,
  type RuntimeIngressCredentialId,
  type RuntimeIngressCredentialScope,
  type RuntimeIngressSessionId,
  type RuntimeIngressSessionState,
} from '../../../../core/domain/runtime-ingress';

import {
  areSessionsExact,
  areVerbSetsExact,
  assertRuntimeIngressStoreLimits,
  assertSnapshotRetention,
  commandClaimKey,
  compactRuntimeIngressSnapshot,
  constantTimeHexEqual,
  copyCredentialDigestKeys,
  copyFingerprintKeys,
  createCommittedCommand,
  doesFingerprintMatchDescriptor,
  emptySnapshot,
  findCommand,
  findCredential,
  findPlanBinding,
  findSession,
  hasActiveLaneCredential,
  hmacHex,
  isInvalidInputError,
  isRuntimePlanRefExact,
  isValidAtomicTransition,
  isValidRotationScope,
  type PersistedRuntimeIngressEffect,
  replaceById,
  replaceOrRemoveSession,
  retainActiveCredentialGenerationFences,
  type RuntimeIngressSnapshot,
  type RuntimeIngressSnapshotAuthentication,
  type RuntimeIngressSnapshotFile,
  type RuntimeIngressSnapshotRetentionLimits,
  sha256Hex,
  splitSnapshotFile,
  stableCanonicalJson,
  toAntiRollbackCheckpoint,
  upsertCredentialGenerationFence,
  validateSnapshot,
} from './runtimeIngressDurableState';
import {
  acquireStoreLock,
  publishSnapshotFile,
  readBoundedSnapshotFile,
  resolveStorePaths,
  type RuntimeIngressStoreLock,
  type RuntimeIngressStorePaths,
} from './runtimeIngressFileStoreIo';

import type { RuntimePlanRef } from '../../../../core/application/ports';
import type { MemberId } from '@shared/contracts/hosted';

const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const SHA256_PREFIX = 'sha256:';
const SNAPSHOT_AUTHENTICATION_PREFIX = 'runtime-ingress-snapshot-hmac-v1\u0000';
const SNAPSHOT_RECOVERY_SUFFIX = '.recovery';
const DEFAULT_STORE_LIMITS = Object.freeze({
  maxSnapshotBytes: MAX_SNAPSHOT_BYTES,
  maxCredentials: 1_024,
  maxSessions: 1_024,
  maxCommands: 4_096,
  maxEffects: 4_096,
  maxCompactedCommands: 4_096,
  lockAcquireTimeoutMs: 5_000,
  lockRetryDelayMs: 10,
});

export interface RuntimeIngressStoreLimits extends RuntimeIngressSnapshotRetentionLimits {
  readonly maxSnapshotBytes: number;
  readonly lockAcquireTimeoutMs: number;
  readonly lockRetryDelayMs: number;
}

export interface RuntimeIngressCredentialDigestKey {
  readonly version: number;
  readonly key: Uint8Array;
}

export interface RuntimeIngressFingerprintKey {
  readonly version: string;
  readonly key: Uint8Array;
}

export interface RuntimeIngressStoreKeyring {
  readonly activeCredentialDigestKeyVersion: number;
  readonly credentialDigestKeys: readonly RuntimeIngressCredentialDigestKey[];
  readonly activeFingerprintKeyVersion: string;
  readonly fingerprintKeys: readonly RuntimeIngressFingerprintKey[];
}

export interface IssueRuntimeIngressCredentialRequest {
  readonly credentialId: RuntimeIngressCredentialId;
  readonly presentedSecret: PresentedRuntimeIngressCredential['secret'];
  readonly scope: RuntimeIngressCredentialScope;
  readonly planRef: RuntimePlanRef;
  readonly sessionId: RuntimeIngressSessionId;
  readonly deliveryOwnerId: MemberId;
  readonly issuedAtIso: string;
}

export type IssueRuntimeIngressCredentialResult =
  | {
      readonly status: 'issued' | 'already_issued';
      readonly credential: RuntimeIngressCredential;
      readonly session: RuntimeIngressSessionState;
    }
  | { readonly status: 'conflict' | 'invalid' | 'unavailable' };

export interface RotateRuntimeIngressCredentialRequest extends IssueRuntimeIngressCredentialRequest {
  readonly previousCredentialId: RuntimeIngressCredentialId;
  readonly revocationReason: string;
}

export type RotateRuntimeIngressCredentialResult =
  | {
      readonly status: 'rotated';
      readonly credential: RuntimeIngressCredential;
      readonly session: RuntimeIngressSessionState;
    }
  | { readonly status: 'conflict' | 'invalid' | 'unavailable' };

export interface FindRuntimeIngressRelayBindingRequest {
  readonly authority: RuntimeIngressRelayAuthority;
}

export class FileRuntimeIngressDurableStore implements RuntimeIngressDurableRecoveryPort {
  private readonly credentialKeys = new Map<number, Uint8Array>();
  private readonly fingerprintKeys = new Map<string, Uint8Array>();
  private readonly activeCredentialKeyVersion: number;
  private readonly activeFingerprintKeyVersion: string;
  private readonly limits: RuntimeIngressStoreLimits;
  private paths: Promise<RuntimeIngressStorePaths> | undefined;
  private operations: Promise<void> = Promise.resolve();
  private currentLock: RuntimeIngressStoreLock | undefined;

  constructor(
    private readonly snapshotPath: string,
    keyring: RuntimeIngressStoreKeyring,
    private readonly antiRollbackFence: RuntimeIngressDurableAntiRollbackFencePort,
    limits: Partial<RuntimeIngressStoreLimits> = {}
  ) {
    if (!isAbsolute(snapshotPath) || basename(snapshotPath) !== 'runtime-ingress-state.json') {
      throw new TypeError('runtime-ingress-snapshot-path-invalid');
    }
    this.activeCredentialKeyVersion = keyring.activeCredentialDigestKeyVersion;
    this.activeFingerprintKeyVersion = keyring.activeFingerprintKeyVersion;
    this.limits = Object.freeze({ ...DEFAULT_STORE_LIMITS, ...limits });
    assertRuntimeIngressStoreLimits(this.limits, MAX_SNAPSHOT_BYTES);
    copyCredentialDigestKeys(keyring.credentialDigestKeys, this.credentialKeys);
    copyFingerprintKeys(keyring.fingerprintKeys, this.fingerprintKeys);
    if (
      !this.credentialKeys.has(this.activeCredentialKeyVersion) ||
      !this.fingerprintKeys.has(this.activeFingerprintKeyVersion)
    ) {
      throw new TypeError('runtime-ingress-active-key-missing');
    }
  }

  async issueCredential(
    request: IssueRuntimeIngressCredentialRequest
  ): Promise<IssueRuntimeIngressCredentialResult> {
    return this.exclusive(async () => {
      try {
        const current = await this.loadSnapshot();
        const credential = this.buildCredential(request);
        const session = initializeRuntimeIngressSessionState(credential, request.deliveryOwnerId);
        const existingCredential = findCredential(current, credential.credentialId);
        const existingSession = findSession(current, session.sessionId);
        const existingPlan = findPlanBinding(current, credential.credentialId);
        if (existingCredential || existingSession) {
          return existingCredential &&
            existingSession &&
            existingPlan &&
            areRuntimeIngressCredentialsExact(existingCredential, credential) &&
            areSessionsExact(existingSession, session) &&
            isRuntimePlanRefExact(existingPlan.planRef, request.planRef)
            ? { status: 'already_issued', credential: existingCredential, session: existingSession }
            : { status: 'conflict' };
        }
        if (hasActiveLaneCredential(current, credential.scope)) return { status: 'conflict' };
        const next = {
          ...current,
          credentials: [...current.credentials, credential],
          sessions: [...current.sessions, session],
          planBindings: [
            ...current.planBindings,
            Object.freeze({ credentialId: credential.credentialId, planRef: request.planRef }),
          ],
          credentialGenerationFences: upsertCredentialGenerationFence(
            current.credentialGenerationFences,
            credential,
            request.planRef
          ),
        } satisfies RuntimeIngressSnapshot;
        await this.persistSnapshot(next);
        return { status: 'issued', credential, session };
      } catch (error) {
        return isInvalidInputError(error) ? { status: 'invalid' } : { status: 'unavailable' };
      }
    });
  }

  async rotateCredential(
    request: RotateRuntimeIngressCredentialRequest
  ): Promise<RotateRuntimeIngressCredentialResult> {
    return this.exclusive(async () => {
      try {
        const current = await this.loadSnapshot();
        const previous = findCredential(current, request.previousCredentialId);
        const previousPlan = previous
          ? findPlanBinding(current, previous.credentialId)?.planRef
          : undefined;
        if (
          !previous ||
          !previousPlan ||
          previous.phase !== 'active' ||
          previous.credentialId === request.credentialId ||
          !isValidRotationScope(previous.scope, request.scope) ||
          findCredential(current, request.credentialId) ||
          findSession(current, request.sessionId) ||
          !isRuntimePlanRefExact(previousPlan, request.planRef)
        ) {
          return { status: 'conflict' };
        }
        const revoked = revokeRuntimeIngressCredential(
          previous,
          request.issuedAtIso,
          request.revocationReason
        );
        if (revoked.status !== 'revoked') return { status: 'invalid' };
        const credential = this.buildCredential(request);
        const session = initializeRuntimeIngressSessionState(credential, request.deliveryOwnerId);
        const previousSession = findSession(current, previous.sessionId);
        const revokedSession = previousSession
          ? revokeRuntimeIngressSessionState(previousSession, revoked.next)
          : null;
        const next = {
          ...current,
          credentials: replaceById(
            current.credentials,
            previous.credentialId,
            revoked.next,
            (value) => value.credentialId
          ).concat(credential),
          sessions: replaceOrRemoveSession(
            current.sessions,
            previous.sessionId,
            revokedSession
          ).concat(session),
          planBindings: current.planBindings.concat(
            Object.freeze({ credentialId: credential.credentialId, planRef: request.planRef })
          ),
          credentialGenerationFences: upsertCredentialGenerationFence(
            upsertCredentialGenerationFence(
              current.credentialGenerationFences,
              revoked.next,
              previousPlan
            ),
            credential,
            request.planRef
          ),
        } satisfies RuntimeIngressSnapshot;
        await this.persistSnapshot(next);
        return { status: 'rotated', credential, session };
      } catch (error) {
        return isInvalidInputError(error) ? { status: 'invalid' } : { status: 'unavailable' };
      }
    });
  }

  async resolveCredentialContext(presented: PresentedRuntimeIngressCredential): Promise<
    | {
        readonly status: 'resolved';
        readonly context: {
          readonly credential: RuntimeIngressCredential;
          readonly session: RuntimeIngressSessionState;
        };
      }
    | { readonly status: 'rejected' | 'unavailable' }
  > {
    return this.exclusive(async () => {
      try {
        const current = await this.loadSnapshot();
        const credential = this.verifyPresentedCredential(current, presented);
        if (!credential || credential.phase !== 'active') return { status: 'rejected' };
        const session = findSession(current, credential.sessionId);
        if (
          !session ||
          !isRuntimeIngressSessionStateRecoverable(session) ||
          !isSessionBoundToCredential(session, credential)
        ) {
          return { status: 'rejected' };
        }
        return { status: 'resolved', context: { credential, session } };
      } catch {
        return { status: 'unavailable' };
      }
    });
  }

  async findRelayBinding(
    request: FindRuntimeIngressRelayBindingRequest
  ): Promise<
    | { readonly status: 'found'; readonly binding: RuntimeIngressRelayBinding }
    | { readonly status: 'missing' | 'ambiguous' | 'unavailable' }
  > {
    return this.exclusive(async () => {
      try {
        const current = await this.loadSnapshot();
        const matches = current.credentials.filter(
          (credential) =>
            credential.phase === 'active' &&
            credential.scope.deploymentId === request.authority.deploymentId &&
            credential.scope.teamId === request.authority.planRef.teamId &&
            credential.scope.runId === request.authority.planRef.runId &&
            credential.scope.planGeneration === request.authority.planRef.generation &&
            credential.scope.laneId === request.authority.laneId &&
            credential.scope.providerId === request.authority.providerId &&
            credential.scope.credentialGeneration === request.authority.credentialGeneration &&
            areVerbSetsExact(credential.scope.allowedVerbs, request.authority.allowedVerbs)
        );
        if (matches.length !== 1) {
          return { status: matches.length === 0 ? 'missing' : 'ambiguous' };
        }
        const credential = matches[0];
        const session = findSession(current, credential.sessionId);
        const planBinding = findPlanBinding(current, credential.credentialId);
        if (
          !session ||
          !planBinding ||
          !isRuntimePlanRefExact(planBinding.planRef, request.authority.planRef) ||
          !request.authority.memberIds.includes(session.deliveryOwnerId) ||
          !isSessionBoundToCredential(session, credential)
        ) {
          return { status: 'missing' };
        }
        return { status: 'found', binding: { credential, session, planRef: planBinding.planRef } };
      } catch {
        return { status: 'unavailable' };
      }
    });
  }

  async verifyCredential(request: VerifyRuntimeIngressCredentialRequest) {
    return this.exclusive(async () => {
      try {
        const credential = this.verifyPresentedCredential(
          await this.loadSnapshot(),
          request.presented
        );
        return credential
          ? { status: 'verified' as const, credential }
          : { status: 'rejected' as const };
      } catch {
        return { status: 'unavailable' as const };
      }
    });
  }

  async loadCredential(credentialId: RuntimeIngressCredentialId) {
    return this.exclusive(async () => {
      try {
        const credential = findCredential(await this.loadSnapshot(), credentialId);
        return credential
          ? { status: 'found' as const, credential }
          : { status: 'missing' as const };
      } catch {
        return { status: 'unavailable' as const };
      }
    });
  }

  async loadSession(sessionId: RuntimeIngressSessionId) {
    return this.exclusive(async () => {
      try {
        const session = findSession(await this.loadSnapshot(), sessionId);
        return session ? { status: 'found' as const, session } : { status: 'missing' as const };
      } catch {
        return { status: 'unavailable' as const };
      }
    });
  }

  async fingerprintCommand(request: FingerprintRuntimeIngressCommandRequest) {
    return this.exclusive(async () => {
      try {
        if (
          encodeCommandFingerprintPreimage(request.prepared.preimage) !==
          request.prepared.encodedPreimage
        ) {
          return { status: 'unavailable' as const };
        }
        const current = await this.loadSnapshot();
        const existing = findCommand(current, commandClaimKey(request.scope));
        const keyVersion = selectCommandFingerprintKeyVersion(
          existing?.claim ?? null,
          this.activeFingerprintKeyVersion
        );
        const key = this.fingerprintKeys.get(keyVersion);
        if (!key) return { status: 'unavailable' as const };
        return {
          status: 'fingerprinted' as const,
          fingerprint: buildCommandFingerprintRecord(
            request.prepared.preimage,
            keyVersion,
            hmacHex(key, request.prepared.encodedPreimage)
          ),
        };
      } catch {
        return { status: 'unavailable' as const };
      }
    });
  }

  async loadCommand(request: LoadRuntimeIngressCommandRequest) {
    return this.exclusive(async () => {
      try {
        const current = await this.loadSnapshot();
        const credential = findCredential(current, request.expectedCredential.credentialId);
        if (
          credential?.phase !== 'active' ||
          !areRuntimeIngressCredentialsExact(credential, request.expectedCredential)
        ) {
          return { status: 'credential_inactive' as const };
        }
        const session = findSession(current, request.expectedSession.sessionId);
        if (!session || !areSessionsExact(session, request.expectedSession)) {
          return { status: 'session_conflict' as const };
        }
        const command = findCommand(current, commandClaimKey(request.scope));
        if (!command) return { status: 'missing' as const };
        const resolution = resolveCommandClaim(command.claim, {
          scope: request.scope,
          fingerprint: request.fingerprint,
        });
        return resolution.outcome === 'idempotency_mismatch'
          ? { status: 'fingerprint_conflict' as const }
          : { status: 'found' as const, command };
      } catch {
        return { status: 'unavailable' as const };
      }
    });
  }

  async applyAtomically(
    request: ApplyRuntimeIngressAtomicallyRequest
  ): Promise<ApplyRuntimeIngressAtomicallyResult> {
    return this.exclusive(async () => {
      try {
        const current = await this.loadSnapshot();
        const credential = findCredential(current, request.expectedCredential.credentialId);
        if (
          credential?.phase !== 'active' ||
          !areRuntimeIngressCredentialsExact(credential, request.expectedCredential)
        ) {
          return { status: 'credential_inactive' };
        }
        const session = findSession(current, request.expectedSession.sessionId);
        if (!session || !areSessionsExact(session, request.expectedSession)) {
          return { status: 'session_conflict' };
        }
        if (!isValidAtomicTransition(request) || !doesFingerprintMatchDescriptor(request)) {
          return { status: 'unavailable' };
        }
        const key = commandClaimKey(request.claimScope);
        const existing = findCommand(current, key);
        if (existing) {
          const resolution = resolveCommandClaim(existing.claim, {
            scope: request.claimScope,
            fingerprint: request.fingerprint,
          });
          if (resolution.outcome === 'idempotency_mismatch') {
            return { status: 'fingerprint_conflict' };
          }
          if (existing.state !== 'committed') return { status: 'recovery_required' };
          return { status: 'duplicate', command: existing, session };
        }

        const command = createCommittedCommand(request);
        const effect: PersistedRuntimeIngressEffect = Object.freeze({
          claimKey: key,
          authority: Object.freeze({
            deploymentId: credential.scope.deploymentId,
            teamId: credential.scope.teamId,
            runId: credential.scope.runId,
            planGeneration: credential.scope.planGeneration,
            laneId: credential.scope.laneId,
            providerId: credential.scope.providerId,
            credentialGeneration: credential.scope.credentialGeneration,
            verb: request.claimScope.commandKind,
          }),
          acknowledgementId: request.acknowledgement.acknowledgementId,
          payloadJson: request.effect.payloadJson,
          appliedAtIso: request.acknowledgement.acceptedAtIso,
        });
        const next = {
          ...current,
          sessions: replaceById(
            current.sessions,
            request.nextSession.sessionId,
            request.nextSession,
            (value) => value.sessionId
          ),
          commands: [...current.commands, command],
          effects: [...current.effects, effect],
        } satisfies RuntimeIngressSnapshot;
        await this.persistSnapshot(next);
        return {
          status: 'applied',
          command,
          session: request.nextSession,
        };
      } catch {
        return { status: 'unavailable' };
      }
    });
  }

  async revokeCredentialAtomically(request: RevokeRuntimeIngressCredentialAtomicallyRequest) {
    return this.exclusive(async () => {
      try {
        const current = await this.loadSnapshot();
        const credential = findCredential(current, request.expectedCredential.credentialId);
        if (!credential) return { status: 'missing' as const };
        const planRef = findPlanBinding(current, credential.credentialId)?.planRef;
        if (!planRef) return { status: 'unavailable' as const };
        if (credential.phase === 'revoked') {
          return { status: 'already_revoked' as const, credential };
        }
        if (!areRuntimeIngressCredentialsExact(credential, request.expectedCredential)) {
          return { status: 'conflict' as const };
        }
        if (
          !isRuntimeIngressCredentialRecoverable(request.nextCredential) ||
          request.nextCredential.phase !== 'revoked' ||
          request.nextCredential.revision !== credential.revision + 1
        ) {
          return { status: 'unavailable' as const };
        }
        const session = findSession(current, credential.sessionId);
        const revokedSession = session
          ? revokeRuntimeIngressSessionState(session, request.nextCredential)
          : null;
        const next = {
          ...current,
          credentials: replaceById(
            current.credentials,
            credential.credentialId,
            request.nextCredential,
            (value) => value.credentialId
          ),
          sessions: replaceOrRemoveSession(current.sessions, credential.sessionId, revokedSession),
          credentialGenerationFences: upsertCredentialGenerationFence(
            current.credentialGenerationFences,
            request.nextCredential,
            planRef
          ),
        } satisfies RuntimeIngressSnapshot;
        await this.persistSnapshot(next);
        return { status: 'revoked' as const, credential: request.nextCredential };
      } catch {
        return { status: 'unavailable' as const };
      }
    });
  }

  private buildCredential(request: IssueRuntimeIngressCredentialRequest): RuntimeIngressCredential {
    if (
      request.planRef.teamId !== request.scope.teamId ||
      request.planRef.runId !== request.scope.runId ||
      request.planRef.generation !== request.scope.planGeneration ||
      !/^sha256:[a-f0-9]{64}$/.test(request.planRef.planHash)
    ) {
      throw new TypeError('runtime-ingress-trusted-plan-binding-invalid');
    }
    if (request.presentedSecret.length < RUNTIME_INGRESS_BEARER_MIN_LENGTH) {
      throw new TypeError('runtime-ingress-presented-secret-entropy-invalid');
    }
    const key = this.credentialKeys.get(this.activeCredentialKeyVersion);
    if (!key) throw new Error('runtime-ingress-credential-key-unavailable');
    return issueRuntimeIngressCredential({
      credentialId: request.credentialId,
      secretDigest: `${SHA256_PREFIX}${hmacHex(key, request.presentedSecret)}`,
      secretDigestKeyVersion: this.activeCredentialKeyVersion,
      scope: request.scope,
      sessionId: request.sessionId,
      issuedAtIso: request.issuedAtIso,
    });
  }

  private verifyPresentedCredential(
    snapshot: RuntimeIngressSnapshot,
    presented: PresentedRuntimeIngressCredential
  ): RuntimeIngressCredential | null {
    const credential = findCredential(snapshot, presented.credentialId);
    const keyVersion = credential?.secretDigestKeyVersion ?? this.activeCredentialKeyVersion;
    const key = this.credentialKeys.get(keyVersion);
    if (!key) throw new Error('runtime-ingress-credential-key-unavailable');
    const presentedDigest = hmacHex(key, presented.secret);
    const expectedDigest = credential?.secretDigest.slice(SHA256_PREFIX.length) ?? '0'.repeat(64);
    const matches = constantTimeHexEqual(presentedDigest, expectedDigest);
    return matches && credential ? credential : null;
  }

  private async loadSnapshot(): Promise<RuntimeIngressSnapshot> {
    const paths = await this.resolvePaths();
    const persisted = await this.readAuthenticatedSnapshot(paths);
    let current = persisted?.snapshot ?? emptySnapshot();
    let recoverySerialized: string | undefined;
    const validation = await this.antiRollbackFence.validate(toAntiRollbackCheckpoint(current));
    if (validation.status === 'accepted') {
      await this.advanceFence(current);
    } else if (validation.status === 'unavailable') {
      throw new Error('runtime-ingress-anti-rollback-unavailable');
    } else {
      const recovery = await this.readAuthenticatedSnapshot(this.recoveryPaths(paths));
      if (!recovery || recovery.snapshot.generation <= current.generation) {
        throw new Error('runtime-ingress-anti-rollback-rejected');
      }
      await this.validateAndAdvanceFence(recovery.snapshot);
      current = recovery.snapshot;
      recoverySerialized = recovery.serialized;
    }

    const normalized = compactRuntimeIngressSnapshot(current, this.limits, sha256Hex);
    if (stableCanonicalJson(normalized) !== stableCanonicalJson(current)) {
      const durable = this.compactSnapshot(
        Object.freeze({ ...normalized, generation: normalized.generation + 1 })
      );
      await this.publishSnapshot(durable);
      return retainActiveCredentialGenerationFences(durable);
    }
    if (recoverySerialized) await this.publishSerializedSnapshot(paths, recoverySerialized);
    return retainActiveCredentialGenerationFences(current);
  }

  private async readAuthenticatedSnapshot(
    paths: RuntimeIngressStorePaths
  ): Promise<{ readonly snapshot: RuntimeIngressSnapshot; readonly serialized: string } | null> {
    const bytes = await readBoundedSnapshotFile(paths, this.limits.maxSnapshotBytes);
    if (bytes === null) return null;
    const serialized = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = JSON.parse(serialized) as unknown;
    const { snapshot, authentication } = splitSnapshotFile(value);
    const key = this.fingerprintKeys.get(authentication.keyVersion);
    if (
      !key ||
      !constantTimeHexEqual(
        hmacHex(key, SNAPSHOT_AUTHENTICATION_PREFIX + stableCanonicalJson(snapshot)),
        authentication.mac
      )
    ) {
      throw new Error('runtime-ingress-snapshot-authentication-invalid');
    }
    return { snapshot: validateSnapshot(snapshot), serialized };
  }

  private async persistSnapshot(next: RuntimeIngressSnapshot): Promise<void> {
    const current = await this.loadSnapshot();
    if (current.generation !== next.generation) {
      throw new Error('runtime-ingress-snapshot-generation-conflict');
    }
    const published = this.compactSnapshot(
      Object.freeze({ ...next, generation: next.generation + 1 })
    );
    await this.publishSnapshot(published);
  }
  private compactSnapshot(snapshot: RuntimeIngressSnapshot): RuntimeIngressSnapshot {
    return compactRuntimeIngressSnapshot(snapshot, this.limits, sha256Hex, (candidate) => {
      return (
        Buffer.byteLength(this.serializeSnapshot(candidate), 'utf8') <= this.limits.maxSnapshotBytes
      );
    });
  }
  private async publishSnapshot(published: RuntimeIngressSnapshot): Promise<void> {
    assertSnapshotRetention(published, this.limits);
    const checkpoint = toAntiRollbackCheckpoint(published);
    const validation = await this.antiRollbackFence.validate(checkpoint);
    if (validation.status !== 'accepted') {
      throw new Error('runtime-ingress-anti-rollback-rejected');
    }
    const serialized = this.serializeSnapshot(published);
    if (Buffer.byteLength(serialized, 'utf8') > this.limits.maxSnapshotBytes) {
      throw new Error('runtime-ingress-snapshot-size-limit');
    }
    const paths = await this.resolvePaths();
    await this.publishSerializedSnapshot(this.recoveryPaths(paths), serialized);
    const advanced = await this.antiRollbackFence.advance(checkpoint);
    if (advanced.status !== 'accepted') {
      throw new Error('runtime-ingress-anti-rollback-advance-failed');
    }
    await this.publishSerializedSnapshot(paths, serialized);
  }
  private serializeSnapshot(snapshot: RuntimeIngressSnapshot): string {
    const key = this.fingerprintKeys.get(this.activeFingerprintKeyVersion);
    if (!key) throw new Error('runtime-ingress-snapshot-authentication-key-unavailable');
    const authentication: RuntimeIngressSnapshotAuthentication = Object.freeze({
      algorithm: 'hmac-sha256',
      keyVersion: this.activeFingerprintKeyVersion,
      mac: hmacHex(key, SNAPSHOT_AUTHENTICATION_PREFIX + stableCanonicalJson(snapshot)),
    });
    return stableCanonicalJson({
      ...snapshot,
      authentication,
    } satisfies RuntimeIngressSnapshotFile);
  }

  private async publishSerializedSnapshot(
    paths: RuntimeIngressStorePaths,
    serialized: string
  ): Promise<void> {
    if (!this.currentLock) throw new Error('runtime-ingress-store-lock-required');
    await this.currentLock.assertOwned();
    await publishSnapshotFile(paths, serialized, this.currentLock);
  }

  private async validateAndAdvanceFence(snapshot: RuntimeIngressSnapshot): Promise<void> {
    const checkpoint = toAntiRollbackCheckpoint(snapshot);
    const validation = await this.antiRollbackFence.validate(checkpoint);
    if (validation.status !== 'accepted') {
      throw new Error('runtime-ingress-anti-rollback-rejected');
    }
    await this.advanceFence(snapshot);
  }

  private async advanceFence(snapshot: RuntimeIngressSnapshot): Promise<void> {
    const checkpoint = toAntiRollbackCheckpoint(snapshot);
    const advanced = await this.antiRollbackFence.advance(checkpoint);
    if (advanced.status !== 'accepted') {
      throw new Error('runtime-ingress-anti-rollback-advance-failed');
    }
  }

  private resolvePaths(): Promise<RuntimeIngressStorePaths> {
    this.paths ??= resolveStorePaths(this.snapshotPath);
    return this.paths;
  }

  private recoveryPaths(paths: RuntimeIngressStorePaths): RuntimeIngressStorePaths {
    return { ...paths, snapshot: `${paths.snapshot}${SNAPSHOT_RECOVERY_SUFFIX}` };
  }

  private exclusive<T extends { readonly status: string }>(
    operation: () => Promise<T>
  ): Promise<T> {
    const lockedOperation = async (): Promise<T> => {
      const lock = await acquireStoreLock(await this.resolvePaths(), this.limits);
      this.currentLock = lock;
      try {
        return await operation();
      } finally {
        this.currentLock = undefined;
        await lock.release();
      }
    };
    const result = this.operations.then(lockedOperation, lockedOperation);
    this.operations = result.then(
      () => undefined,
      () => undefined
    );
    return result.catch(() => ({ status: 'unavailable' }) as T);
  }
}
