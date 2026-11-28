import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  canonicalManagementValue,
  deriveSecretFingerprint,
  secretFingerprintsEqual,
} from '@agent-teams/legacy-agent-host/management/secret-fingerprint';

import { validOAuthOperationId } from '../../infrastructure/FileProviderOAuthIntentStore';
import {
  getCopyableOAuthAuthorizationUrl,
  isSafeOAuthAuthorizationUrl,
  sanitizeOAuthInstructions,
} from '../../infrastructure/runtimeProviderOAuthPresentation';

import { managementValue } from './capturedManagementCatalog';

import type * as Dto from '../../../contracts';
import type {
  ProviderOAuthIntent,
  ProviderOAuthIntentStore,
} from '../../infrastructure/FileProviderOAuthIntentStore';
import type { ProviderOAuthSnapshot } from '@agent-teams/legacy-agent-host/management/contracts';
import type { CapturedProviderManagement } from '@features/agent-backend/main';

export interface CapturedProviderOAuthDependencies {
  intents: ProviderOAuthIntentStore;
  restore(targetId: string): Promise<CapturedProviderManagement>;
  openExternal(url: string): Promise<void>;
  emitProgress?(event: Dto.RuntimeProviderOAuthProgressDto): void;
}
type OAuthPresentation = Pick<
  Dto.RuntimeProviderOAuthProgressDto,
  'authorizationUrl' | 'instructions'
>;

interface OAuthConnectInput {
  operationId: string;
  runtimeId?: Dto.RuntimeProviderManagementRuntimeId;
  providerId: string;
  methodIndex: number;
  displayName: string;
  authOptionId: string;
  fields?: Record<string, string>;
}
type PreparedOAuth = { target: CapturedProviderManagement; input: OAuthConnectInput };
type PreparedOAuthOutcome = { value: PreparedOAuth | null } | { error: unknown };
interface PendingOAuth {
  operationId: string;
  identity: string;
  cancelled: boolean;
  result: Promise<CapturedProviderManagement | null>;
  original: Promise<ProviderOAuthIntent | null>;
  target?: CapturedProviderManagement;
  candidate?: ProviderOAuthIntent;
  creation?: Promise<boolean>;
  createAttempted: boolean;
  startAttempted: boolean;
}
const captureIntent = (value: ProviderOAuthIntent | null): ProviderOAuthIntent | null =>
  value === null
    ? null
    : Object.freeze({
        ...value,
        ...(value.fingerprintKdf === undefined
          ? {}
          : {
              fingerprintKdf: Object.freeze({ ...value.fingerprintKdf }),
            }),
      });
const sameIntent = (left: ProviderOAuthIntent | null, right: ProviderOAuthIntent): boolean =>
  left !== null && canonicalManagementValue(left) === canonicalManagementValue(right);
const captureConnectInput = (input: OAuthConnectInput): OAuthConnectInput => {
  const captured = { ...input, ...(input.fields ? { fields: { ...input.fields } } : {}) };
  if (
    !validOAuthOperationId(captured.operationId) ||
    !Number.isSafeInteger(captured.methodIndex) ||
    captured.methodIndex < 0
  )
    throw new Error('OAuth intent invalid');
  return captured;
};

const failed = () => ({ ok: false, error: 'Unable to confirm the original sign-in operation.' });
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('OAuth state unavailable');
  return value as Record<string, unknown>;
};

/** Main owns original routing and browser opening; Host owns native OAuth lifecycle and credentials. */
export class CapturedProviderOAuth {
  private readonly active = new Map<string, PendingOAuth>();
  private readonly listeners = new Set<(event: Dto.RuntimeProviderOAuthProgressDto) => void>();
  constructor(private readonly deps: CapturedProviderOAuthDependencies) {}

  subscribe(listener: (event: Dto.RuntimeProviderOAuthProgressDto) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  connect(target: CapturedProviderManagement, input: OAuthConnectInput): Promise<void> {
    try {
      const captured = captureConnectInput(input);
      return this.enter(captured.operationId, ['direct', target.targetId, captured], async () => ({
        target,
        input: captured,
      })).then(() => undefined);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  connectPrepared(
    input: Dto.RuntimeProviderManagementConnectInput,
    prepare: (assertCurrent: () => void) => Promise<PreparedOAuth | null>
  ): Promise<CapturedProviderManagement | null> {
    try {
      const captured = {
        ...input,
        metadata: input.metadata ? { ...input.metadata } : input.metadata,
      };
      if (!validOAuthOperationId(captured.oauthOperationId))
        throw new Error('OAuth intent invalid');
      return this.enter(captured.oauthOperationId, ['prepared', captured], prepare);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private enter(
    operationId: string,
    request: unknown,
    prepare: (assertCurrent: () => void) => Promise<PreparedOAuth | null>
  ): Promise<CapturedProviderManagement | null> {
    // Compare only this live captured request; never retain a fast secret fingerprint.
    const identity = canonicalManagementValue(request);
    const running = this.active.get(operationId);
    if (running) {
      if (running.identity !== identity) throw new Error('OAuth intent conflict');
      return running.result;
    }
    const completion = Promise.withResolvers<CapturedProviderManagement | null>();
    const pending: PendingOAuth = {
      operationId,
      identity,
      cancelled: false,
      result: completion.promise,
      original: Promise.resolve().then(async () =>
        captureIntent(await this.deps.intents.read(operationId))
      ),
      createAttempted: false,
      startAttempted: false,
    };
    this.active.set(operationId, pending);
    // Capture the caller's original context now, before the journal read can yield.
    // Observe early preparation failures while original discovery is still pending.
    let preparation: Promise<PreparedOAuthOutcome>;
    try {
      preparation = Promise.resolve(prepare(() => this.assertPending(pending))).then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      );
    } catch (error) {
      preparation = Promise.resolve({ error });
    }
    const retire = () => {
      if (this.active.get(operationId) === pending) this.active.delete(operationId);
    };
    void this.admit(pending, preparation).then(
      (target) => {
        retire();
        completion.resolve(target);
      },
      (error: unknown) => {
        retire();
        completion.reject(error);
      }
    );
    return pending.result;
  }

  private assertPending(pending: PendingOAuth): void {
    if (pending.cancelled || this.active.get(pending.operationId) !== pending)
      throw new Error('Original sign-in operation cancelled');
  }

  private values(targetId: string, input: OAuthConnectInput): unknown[] {
    return [
      ...(input.runtimeId === 'claude' ? ['claude'] : []),
      targetId,
      input.providerId,
      input.methodIndex,
      input.authOptionId,
      Object.entries(input.fields ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    ];
  }

  private async replay(
    pending: PendingOAuth,
    target: CapturedProviderManagement,
    input: OAuthConnectInput,
    saved: ProviderOAuthIntent
  ): Promise<CapturedProviderManagement> {
    if (
      saved.operationId !== input.operationId ||
      saved.targetId !== target.targetId ||
      (saved.runtimeId ?? 'opencode') !== (input.runtimeId ?? 'opencode') ||
      saved.providerId !== input.providerId ||
      saved.methodIndex !== input.methodIndex ||
      saved.authOptionId !== input.authOptionId
    )
      throw new Error('OAuth intent conflict');
    const values = this.values(saved.targetId, input);
    const fingerprint =
      saved.fingerprintKdf === undefined
        ? createHash('sha256').update(JSON.stringify(values)).digest('hex')
        : (await deriveSecretFingerprint(values, saved.fingerprintKdf)).fingerprint;
    this.assertPending(pending);
    if (
      !secretFingerprintsEqual(saved.fingerprint, fingerprint) ||
      !sameIntent(captureIntent(await this.deps.intents.read(saved.operationId)), saved)
    )
      throw new Error('OAuth intent conflict');
    this.assertPending(pending);
    const original = await this.deps.restore(saved.targetId);
    this.assertPending(pending);
    if (original.targetId !== saved.targetId) throw new Error('OAuth intent conflict');
    const snapshot = this.snapshot(
      await original.request('oauth.read', { operationId: saved.operationId }),
      saved,
      original
    );
    this.assertPending(pending);
    if (snapshot.phase !== 'completed')
      throw new Error('Original OAuth operation remains unconfirmed');
    return original;
  }

  private async admit(
    pending: PendingOAuth,
    preparation: Promise<PreparedOAuthOutcome>
  ): Promise<CapturedProviderManagement | null> {
    try {
      const previous = await pending.original;
      this.assertPending(pending);
      const outcome = await preparation;
      this.assertPending(pending);
      if ('error' in outcome) throw outcome.error;
      const prepared = outcome.value;
      if (!prepared) return null;
      const input = captureConnectInput(prepared.input),
        target = prepared.target;
      if (input.operationId !== pending.operationId) throw new Error('OAuth intent conflict');
      pending.target = target;
      if (previous) return await this.replay(pending, target, input, previous);
      if (!target.isCurrent()) throw new Error('OAuth context changed');
      const derived = await deriveSecretFingerprint(this.values(target.targetId, input));
      this.assertPending(pending);
      if (!target.isCurrent()) throw new Error('OAuth context changed');
      const intent: ProviderOAuthIntent = Object.freeze({
        schemaVersion: 1,
        ...(input.runtimeId === 'claude' ? { runtimeId: 'claude' as const } : {}),
        operationId: input.operationId,
        targetId: target.targetId,
        providerId: input.providerId,
        methodIndex: input.methodIndex,
        authOptionId: input.authOptionId,
        displayName: input.displayName,
        fingerprint: derived.fingerprint,
        fingerprintKdf: Object.freeze({ ...derived.fingerprintKdf }),
      });
      pending.candidate = intent;
      pending.createAttempted = true;
      const created = await (pending.creation = this.deps.intents.create(intent));
      this.assertPending(pending);
      if (!created) {
        const winner = captureIntent(await this.deps.intents.read(intent.operationId));
        this.assertPending(pending);
        if (!winner) throw new Error('OAuth intent conflict');
        return await this.replay(pending, target, input, winner);
      }
      if (!target.isCurrent()) throw new Error('OAuth context changed');
      await this.run(target, intent, pending, input.fields);
      this.assertPending(pending);
      return target;
    } catch (error) {
      if (pending.startAttempted && pending.target && pending.candidate) {
        try {
          await pending.target.request('oauth.cancel', { operationId: pending.operationId });
        } catch {
          /* Original routing remains available for explicit reconciliation. */
        }
        throw new Error('Original sign-in operation unconfirmed');
      }
      throw error;
    }
  }

  private snapshot(
    value: unknown,
    intent: ProviderOAuthIntent,
    target: CapturedProviderManagement
  ): ProviderOAuthSnapshot {
    const snapshot = object(managementValue(value));
    if (
      snapshot.operationId !== intent.operationId ||
      snapshot.providerId !== intent.providerId ||
      snapshot.profileId !== target.profileId ||
      snapshot.configRevision !== target.configRevision ||
      snapshot.methodIndex !== intent.methodIndex ||
      ![
        'authorizing',
        'waiting-for-code',
        'waiting-for-browser',
        'completing',
        'cancelling',
        'completed',
        'cancelled',
        'failed',
        'held',
      ].includes(String(snapshot.phase)) ||
      ![null, 'code', 'auto'].includes(snapshot.completionMethod as string | null) ||
      !Number.isSafeInteger(snapshot.sequence) ||
      Number(snapshot.sequence) < 1 ||
      !Number.isSafeInteger(snapshot.expiresAt) ||
      Number(snapshot.expiresAt) <= 0
    )
      throw new Error('OAuth state unavailable');
    return snapshot as unknown as ProviderOAuthSnapshot;
  }

  private emit(
    intent: ProviderOAuthIntent,
    snapshot: ProviderOAuthSnapshot,
    presentation?: OAuthPresentation
  ): void {
    const phase: Dto.RuntimeProviderOAuthProgressPhaseDto =
      snapshot.phase === 'held'
        ? 'failed'
        : snapshot.phase === 'cancelling' || snapshot.phase === 'cancelled'
          ? 'cancelled'
          : snapshot.phase === 'completed'
            ? 'completing'
            : snapshot.phase === 'completing' &&
                snapshot.completionMethod === 'auto' &&
                intent.runtimeId !== 'claude'
              ? 'waiting-for-browser'
              : snapshot.phase;
    const waiting = phase === 'waiting-for-code' || phase === 'waiting-for-browser';
    const event: Dto.RuntimeProviderOAuthProgressDto = {
      operationId: intent.operationId,
      runtimeId: intent.runtimeId ?? 'opencode',
      providerId: intent.providerId,
      displayName: intent.displayName,
      authOptionId: intent.authOptionId,
      methodIndex: intent.methodIndex,
      phase,
      completionMethod: snapshot.completionMethod,
      ...(waiting && presentation?.authorizationUrl
        ? { authorizationUrl: presentation.authorizationUrl }
        : {}),
      instructions: waiting
        ? (presentation?.instructions ??
          (snapshot.phase === 'waiting-for-code'
            ? 'Complete sign-in in your browser and enter the returned code.'
            : null))
        : null,
      message: null,
    };
    // Only canonical, sanitized presentation leaves Main; private replies and journals stay separate.
    for (const listener of [this.deps.emitProgress, ...this.listeners]) {
      try {
        listener?.({ ...event });
      } catch {
        /* A renderer listener cannot alter native auth ownership. */
      }
    }
  }

  private async run(
    target: CapturedProviderManagement,
    intent: ProviderOAuthIntent,
    pending: PendingOAuth,
    fields?: Record<string, string>
  ): Promise<void> {
    this.assertPending(pending);
    pending.startAttempted = true;
    let snapshot = this.snapshot(
      await target.request('oauth.start', {
        operationId: intent.operationId,
        providerId: intent.providerId,
        methodIndex: intent.methodIndex,
        ...(fields ? { fields } : {}),
      }),
      intent,
      target
    );
    this.assertPending(pending);
    const presentNativeInstructions = intent.runtimeId !== 'claude';
    const expiresAt = snapshot.expiresAt;
    const assertPresentationCurrent = () => {
      this.assertPending(pending);
      if (!target.isCurrent()) throw new Error('OAuth context changed');
      if (Date.now() >= expiresAt) throw new Error('OAuth expired');
    };
    let presentation: OAuthPresentation | undefined;
    let opened = false,
      autoSubmitted = false,
      sequence = 0;
    for (;;) {
      this.assertPending(pending);
      if (!target.isCurrent()) {
        // Control is retained against the old owner even after the foreground context switched.
        await target.request('oauth.cancel', { operationId: intent.operationId });
        throw new Error('OAuth context changed');
      }
      if (snapshot.sequence < sequence) throw new Error('OAuth progress regressed');
      if (
        !['waiting-for-code', 'waiting-for-browser'].includes(snapshot.phase) &&
        !(snapshot.phase === 'completing' && snapshot.completionMethod === 'auto')
      )
        presentation = undefined;
      if (presentation) assertPresentationCurrent();
      if (snapshot.sequence > sequence) {
        this.emit(intent, snapshot, presentation);
        sequence = snapshot.sequence;
      }
      if (snapshot.phase === 'completed') return;
      if (
        snapshot.phase === 'held' ||
        snapshot.phase === 'cancelled' ||
        snapshot.phase === 'failed'
      )
        throw new Error('OAuth outcome unconfirmed');
      if (Date.now() >= snapshot.expiresAt) {
        await target.request('oauth.cancel', { operationId: intent.operationId });
        throw new Error('OAuth expired');
      }
      if (!opened && ['waiting-for-code', 'waiting-for-browser'].includes(snapshot.phase)) {
        assertPresentationCurrent();
        const privateReply = managementValue(
          await target.request('oauth.authorization', { operationId: intent.operationId })
        );
        assertPresentationCurrent();
        if (privateReply === null) {
          // A code/cancel may have won between progress and this private read.
          snapshot = this.snapshot(
            await target.request('oauth.read', { operationId: intent.operationId }),
            intent,
            target
          );
          continue;
        }
        const authorization = object(privateReply);
        if (
          typeof authorization.authorizationUrl !== 'string' ||
          authorization.authorizationUrl.length > 16384
        )
          throw new Error('OAuth authorization unavailable');
        const url = new URL(authorization.authorizationUrl);
        if (
          url.username ||
          url.password ||
          !(
            url.protocol === 'https:' ||
            (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
          )
        )
          throw new Error('OAuth authorization unavailable');
        if (
          presentNativeInstructions &&
          (typeof authorization.instructions !== 'string' ||
            authorization.instructions.length > 16384)
        )
          throw new Error('OAuth authorization unavailable');
        if (!target.isCurrent()) continue;
        assertPresentationCurrent();
        opened = true; // Never repeat an uncertain external-open effect.
        if (authorization.browserOwner !== undefined && authorization.browserOwner !== 'native')
          throw new Error('OAuth browser owner unavailable');
        if (authorization.browserOwner !== 'native') await this.deps.openExternal(url.href);
        this.assertPending(pending);
        if (presentNativeInstructions) {
          // An opener may outlive cancellation or a context switch. Re-read this exact operation
          // before exposing any sanitized native presentation, within its original expiry.
          assertPresentationCurrent();
          const observed = this.snapshot(
            await target.request('oauth.read', { operationId: intent.operationId }),
            intent,
            target
          );
          assertPresentationCurrent();
          if (
            observed.sequence < snapshot.sequence ||
            (observed.sequence === snapshot.sequence && observed.phase !== snapshot.phase) ||
            observed.completionMethod !== snapshot.completionMethod ||
            observed.expiresAt !== expiresAt
          )
            throw new Error('OAuth progress changed');
          snapshot = observed;
          if (snapshot.phase === 'waiting-for-code' || snapshot.phase === 'waiting-for-browser') {
            presentation = {
              instructions: sanitizeOAuthInstructions(authorization.instructions as string),
              authorizationUrl: isSafeOAuthAuthorizationUrl(authorization.authorizationUrl)
                ? getCopyableOAuthAuthorizationUrl(
                    intent.providerId,
                    authorization.authorizationUrl
                  )
                : null,
            };
            this.emit(intent, snapshot, presentation);
            sequence = snapshot.sequence;
          }
          continue;
        }
      }
      if (snapshot.phase === 'waiting-for-browser' && !autoSubmitted) {
        assertPresentationCurrent();
        autoSubmitted = true;
        snapshot = this.snapshot(
          await target.request('oauth.complete', {
            operationId: intent.operationId,
            commandId: `${intent.operationId}:auto`,
          }),
          intent,
          target
        );
        continue;
      }
      await delay(100);
      this.assertPending(pending);
      snapshot = this.snapshot(
        await target.request('oauth.read', { operationId: intent.operationId }),
        intent,
        target
      );
    }
  }

  async submitCode(
    input: Dto.RuntimeProviderManagementSubmitOAuthCodeInput
  ): Promise<Dto.RuntimeProviderManagementOAuthControlResponse> {
    const { operationId, code } = input;
    try {
      if (typeof code !== 'string' || !code.trim() || code.length > 16384) return failed();
      const intent = await this.deps.intents.read(operationId);
      if (!intent) return failed();
      const target = await this.deps.restore(intent.targetId);
      if (!target.isCurrent()) return failed();
      const result = this.snapshot(
        await target.request('oauth.complete', {
          operationId,
          commandId: `${operationId}:code`,
          code,
        }),
        intent,
        target
      );
      return ['completing', 'completed'].includes(result.phase) ? { ok: true } : failed();
    } catch {
      return failed();
    }
  }

  async cancel(
    input: Dto.RuntimeProviderManagementCancelOAuthInput
  ): Promise<Dto.RuntimeProviderManagementOAuthControlResponse> {
    const { operationId } = input;
    const pending = this.active.get(operationId);
    if (pending) pending.cancelled = true;
    const assertOriginalToken = () => {
      const current = this.active.get(operationId);
      if (pending && current && current !== pending) throw new Error('OAuth operation replaced');
    };
    try {
      let intent = await (pending?.original ?? this.deps.intents.read(operationId));
      assertOriginalToken();
      if (pending?.createAttempted) {
        let created: boolean | undefined;
        try {
          created = await pending.creation;
        } catch {
          /* Reconcile the uncertain original only. */
        }
        assertOriginalToken();
        const retained = captureIntent(await this.deps.intents.read(operationId));
        assertOriginalToken();
        if (created === true && pending.candidate) {
          intent = pending.candidate;
          if (!pending.startAttempted)
            return sameIntent(retained, intent) ? { ok: true } : failed();
        } else if (created === false) {
          intent = retained;
        } else {
          if (!pending.candidate || !sameIntent(retained, pending.candidate)) return failed();
          intent = pending.candidate;
        }
      } else if (!intent && pending) {
        // A settled no-write attempt cannot authorize a late control of a successor.
        if (this.active.get(operationId) !== pending) return { ok: true };
        intent = captureIntent(await this.deps.intents.read(operationId));
        assertOriginalToken();
        if (this.active.get(operationId) !== pending) return intent ? failed() : { ok: true };
        if (!intent) return { ok: true };
      }
      if (!intent) return failed();
      const target =
        pending?.target?.targetId === intent.targetId
          ? pending.target
          : await this.deps.restore(intent.targetId);
      assertOriginalToken();
      if (target.targetId !== intent.targetId) return failed();
      const snapshot = this.snapshot(
        await target.request('oauth.cancel', { operationId }),
        intent,
        target
      );
      assertOriginalToken();
      // Cancellation fences polling; publish the observed original cleanup without presentation.
      if (['cancelled', 'completed', 'held', 'failed', 'cancelling'].includes(snapshot.phase))
        this.emit(intent, snapshot);
      // A confirmed completion wins; cancelling never deletes those credentials.
      return snapshot.phase === 'cancelled' ? { ok: true } : failed();
    } catch {
      return failed();
    }
  }
}
