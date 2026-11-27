import { z } from 'zod';

import { assertManagementTarget, ManagementCommandError } from './commandRecords.js';
import { managementDigest, managementValuesEqual } from './identity.js';
import { deriveSecretFingerprint, SecretFingerprintError, secretFingerprintsEqual } from './secretFingerprint.js';
import type { SecretFingerprintKdf } from './secretFingerprint.js';

import type {
  ManagementCommandStore,
  ManagementTarget,
  StoredOAuthCommand,
} from './commandRecords.js';
import type { ProviderOAuthAuthorization, ProviderOAuthSnapshot } from './contracts.js';
import type { ManagementResourceFence } from './ManagementResourceFence.js';

const id = z.string().min(1).max(256);
const identity = z.object({ operationId: id, profileId: id, configRevision: id }).strict();
const startSchema = identity
  .extend({
    providerId: id,
    methodIndex: z.number().int().min(0).max(10000),
    fields: z.record(id, z.string().max(8192)).optional(),
  })
  .strict();
type OAuthStart = z.infer<typeof startSchema>;
const completeSchema = identity
  .extend({ commandId: id, code: z.string().trim().min(1).max(16384).optional() })
  .strict();
type OAuthComplete = z.infer<typeof completeSchema>;
type CompletionInput = { commandId: string; code: string | null };

/** Captured native conversation. prepare() does not allocate; close seals even pending allocation. */
export interface OAuthNativeConversation {
  readonly timeoutMs: number;
  /** Native browser callbacks may complete while the optional paste-code UI remains open. */
  readonly nativeCompletion?: Promise<boolean>;
  /** Finite native failure witness, independent of whether original cleanup succeeds. */
  readonly nativeRejectionConfirmed?: boolean;
  authorize(
    fields: Record<string, string> | undefined,
    signal: AbortSignal
  ): Promise<
    ProviderOAuthAuthorization & {
      completionMethod: 'auto' | 'code';
    }
  >;
  complete(code: string | undefined, signal: AbortSignal): Promise<boolean>;
  close(): Promise<boolean>;
}

interface ActiveOAuth {
  saved: StoredOAuthCommand;
  native: OAuthNativeConversation;
  abort: AbortController;
  authorization?: ProviderOAuthAuthorization;
  timer?: NodeJS.Timeout;
  closing?: Promise<void>;
  pendingCompletion?: {
    input: CompletionInput;
    result: Promise<ProviderOAuthSnapshot>;
    settled: Promise<void>;
  };
  completionPublicationUnknown?: true;
  receiptConflict?: true;
  retired: boolean;
}

/** One flow per auth namespace. Reconnect, code submission and cancel never reselect a native host. */
export class OAuthOperationOwner {
  private readonly active = new Map<string, ActiveOAuth>();
  private readonly cleanupDebt = new Set<string>();
  private sealed = false;

  constructor(
    private readonly options: {
      store: ManagementCommandStore;
      fence: ManagementResourceFence;
      assertWriter(): void;
      select(profileId: string, configRevision: string): ManagementTarget;
      prepare(input: OAuthStart): OAuthNativeConversation;
      onProgress?(snapshot: ProviderOAuthSnapshot): void;
    }
  ) {}

  start(raw: unknown): ProviderOAuthSnapshot {
    const input = startSchema.parse(raw);
    this.assertAdmission();
    const target = this.options.select(input.profileId, input.configRevision);
    const fingerprint = managementDigest(input);
    const previous = this.options.store.read(input.operationId);
    if (previous) {
      if (previous.kind !== 'oauth') throw new ManagementCommandError('conflict');
      assertManagementTarget(previous, target);
      if (previous.fingerprint !== fingerprint) throw new ManagementCommandError('conflict');
      return this.snapshot(previous);
    }
    this.options.fence.reserve(target.resourceId, input.operationId);
    let native: OAuthNativeConversation;
    let entry: ActiveOAuth;
    let claimWriteAttempted = false;
    try {
      native = this.options.prepare(input); // Construction only, no native allocation.
      if (
        !Number.isSafeInteger(native.timeoutMs) ||
        native.timeoutMs < 1 ||
        native.timeoutMs > 17 * 60_000
      )
        throw new ManagementCommandError('invalid');
      const saved: StoredOAuthCommand = {
        schemaVersion: 1,
        ...target,
        commandId: input.operationId,
        kind: 'oauth',
        providerId: input.providerId,
        methodIndex: input.methodIndex,
        fingerprint,
        phase: 'authorizing',
        completionMethod: null,
        resourceHeld: true,
        sequence: 1,
        expiresAt: Date.now() + native.timeoutMs,
      };
      claimWriteAttempted = true;
      this.options.store.write(saved);
      entry = { saved, native, abort: new AbortController(), retired: false };
      this.active.set(input.operationId, entry);
    } catch (error) {
      this.options.fence.release(target.resourceId, input.operationId, !claimWriteAttempted);
      throw error;
    }
    entry.timer = setTimeout(() => {
      void this.stop(entry, 'expired');
    }, native.timeoutMs);
    entry.timer.unref();
    this.emit(entry);
    void this.authorize(entry, input.fields);
    return this.snapshot(entry.saved);
  }

  read(raw: unknown): ProviderOAuthSnapshot | null {
    const input = identity.parse(raw);
    this.assertAdmission();
    const saved = this.readOriginal(input);
    return saved ? this.snapshot(saved) : null;
  }

  /** Private Host→Main reply. Never emit this payload as public progress or journal it. */
  authorization(raw: unknown): ProviderOAuthAuthorization | null {
    const input = identity.parse(raw);
    this.assertAdmission();
    const saved = this.readOriginal(input);
    if (!saved) return null;
    const entry = this.active.get(saved.commandId);
    if (
      !entry ||
      entry.retired ||
      !['waiting-for-code', 'waiting-for-browser'].includes(entry.saved.phase)
    )
      return null;
    this.assertBound(entry);
    return entry.authorization ? { ...entry.authorization } : null;
  }

  complete(raw: unknown): Promise<ProviderOAuthSnapshot> {
    try {
      const input = completeSchema.parse(raw);
      this.assertAdmission();
      const entry = this.active.get(input.operationId);
      const captured = entry && entry.saved.profileId === input.profileId &&
        entry.saved.configRevision === input.configRevision ? entry : undefined;
      const closeChanged = captured !== undefined && !captured.retired && !captured.saved.completionCommandId;
      let saved: StoredOAuthCommand | undefined;
      try { saved = this.readOriginal(input); }
      catch (error) { this.fenceChangedReceipt(captured, closeChanged); throw error; }
      if (!saved) {
        this.fenceChangedReceipt(captured, closeChanged);
        throw new ManagementCommandError(captured ? 'conflict' : 'invalid');
      }
      if (saved.completionCommandId) return this.replayCompletion(input, saved);
      if (!entry || entry.retired) return Promise.resolve(this.snapshot(saved));
      this.assertCompletionCurrent(entry);
      if (!['waiting-for-code', 'waiting-for-browser'].includes(entry.saved.phase) ||
          (entry.saved.completionMethod === 'code') !== (input.code !== undefined))
        throw new ManagementCommandError('invalid');
      const value = { commandId: input.commandId, code: input.code ?? null };
      if (entry.pendingCompletion) {
        if (!managementValuesEqual(entry.pendingCompletion.input, value))
          throw new ManagementCommandError('conflict');
        return entry.pendingCompletion.result;
      }
      if (input.code === undefined) {
        this.publishCompletion(entry, input.commandId, { fingerprint: managementDigest(value) });
        void this.finish(entry, undefined);
        return Promise.resolve(this.snapshot(entry.saved));
      }
      const result = Promise.withResolvers<ProviderOAuthSnapshot>();
      const settled = Promise.withResolvers<void>();
      const pending = { input: value, result: result.promise, settled: settled.promise };
      entry.pendingCompletion = pending;
      const clear = () => { if (entry.pendingCompletion === pending) delete entry.pendingCompletion; };
      void this.prepareCompletion(entry, input, saved).then(
        snapshot => { clear(); result.resolve(snapshot); settled.resolve(); },
        error => { clear(); result.reject(error); settled.resolve(); },
      );
      return pending.result;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private async fingerprint(input: OAuthComplete, original?: SecretFingerprintKdf) {
    try {
      return await deriveSecretFingerprint({ commandId: input.commandId, code: input.code ?? null }, original);
    } catch (error) {
      if (error instanceof SecretFingerprintError)
        throw new ManagementCommandError(error.code === 'failed' ? 'held' : error.code);
      throw error;
    }
  }

  private completionIdentity(saved: StoredOAuthCommand) {
    const { phase: _phase, sequence: _sequence, reason: _reason, resourceHeld: _held, ...original } = saved;
    return structuredClone(original);
  }

  private async replayCompletion(input: OAuthComplete, saved: StoredOAuthCommand): Promise<ProviderOAuthSnapshot> {
    const original = this.completionIdentity(saved);
    if (original.completionCommandId !== input.commandId || !original.completionFingerprint)
      throw new ManagementCommandError('conflict');
    const active = this.active.get(saved.commandId);
    const same = active && managementValuesEqual(original, this.completionIdentity(active.saved));
    if (active && !active.retired && !same) {
      this.fenceChangedReceipt(active, false);
      throw new ManagementCommandError('conflict');
    }
    const captured = same ? active : undefined;
    const fingerprint = original.completionFingerprintKdf === undefined
      ? managementDigest({ commandId: input.commandId, code: input.code ?? null })
      : (await this.fingerprint(input, original.completionFingerprintKdf)).fingerprint;
    this.assertAdmission();
    let latest: StoredOAuthCommand | undefined;
    try { latest = this.readOriginal(input); }
    catch (error) { this.fenceChangedReceipt(captured, false); throw error; }
    if (!latest || !managementValuesEqual(original, this.completionIdentity(latest))) {
      this.fenceChangedReceipt(captured, false);
      throw new ManagementCommandError('conflict');
    }
    if (!secretFingerprintsEqual(original.completionFingerprint, fingerprint))
      throw new ManagementCommandError('conflict');
    return this.snapshot(latest, false);
  }

  private async prepareCompletion(
    entry: ActiveOAuth, input: OAuthComplete, saved: StoredOAuthCommand
  ): Promise<ProviderOAuthSnapshot> {
    const original = structuredClone(saved);
    const proof = await this.fingerprint(input);
    this.assertBound(entry);
    if (!managementValuesEqual(original, entry.saved)) {
      this.fenceChangedReceipt(entry, true);
      throw new ManagementCommandError('conflict');
    }
    this.assertCompletionCurrent(entry);
    this.publishCompletion(entry, input.commandId, proof);
    void this.finish(entry, input.code);
    return this.snapshot(entry.saved);
  }

  /** Synchronous read/write custody gate: no await between original comparison and publication. */
  private storedOriginalMatches(entry: ActiveOAuth): boolean {
    try {
      const stored = this.options.store.read(entry.saved.commandId);
      return stored?.kind === 'oauth' && managementValuesEqual(stored, entry.saved);
    } catch {
      return false;
    }
  }

  private assertStoredOriginal(entry: ActiveOAuth): void {
    if (!this.storedOriginalMatches(entry)) {
      this.fenceChangedReceipt(entry, true);
      throw new ManagementCommandError('conflict');
    }
  }

  private assertCompletionCurrent(entry: ActiveOAuth): void {
    this.assertBound(entry);
    this.assertStoredOriginal(entry);
    if (Date.now() >= entry.saved.expiresAt) {
      void this.stop(entry, 'expired');
      throw new ManagementCommandError('held');
    }
  }

  private fenceChangedReceipt(entry: ActiveOAuth | undefined, close: boolean): void {
    if (!entry || this.active.get(entry.saved.commandId) !== entry) return;
    entry.receiptConflict = true;
    if (close) void this.stop(entry, 'native-outcome-unknown');
  }

  private publishCompletion(
    entry: ActiveOAuth, commandId: string,
    proof: { fingerprint: string; fingerprintKdf?: SecretFingerprintKdf }
  ): void {
    this.assertBound(entry);
    this.assertStoredOriginal(entry);
    const next: StoredOAuthCommand = { ...entry.saved, phase: 'completing', sequence: entry.saved.sequence + 1,
      completionCommandId: commandId, completionFingerprint: proof.fingerprint,
      ...(proof.fingerprintKdf ? { completionFingerprintKdf: proof.fingerprintKdf } : {}) };
    try { this.options.store.write(next); }
    catch (error) {
      entry.completionPublicationUnknown = true;
      void this.stop(entry, 'native-outcome-unknown');
      throw error;
    }
    entry.saved = next;
    this.emit(entry);
  }

  async cancel(raw: unknown): Promise<ProviderOAuthSnapshot> {
    const input = identity.parse(raw);
    this.assertAdmission();
    const entry = this.active.get(input.operationId);
    const captured = entry && entry.saved.profileId === input.profileId &&
      entry.saved.configRevision === input.configRevision ? entry : undefined;
    let saved: StoredOAuthCommand | undefined;
    try { saved = this.readOriginal(input); }
    catch (error) { this.fenceChangedReceipt(captured, true); throw error; }
    if (!saved) {
      this.fenceChangedReceipt(captured, true);
      throw new ManagementCommandError(captured ? 'conflict' : 'invalid');
    }
    if (captured && !managementValuesEqual(captured.saved, saved)) {
      this.fenceChangedReceipt(captured, true);
      throw new ManagementCommandError('conflict');
    }
    if (!entry) return this.snapshot(saved);
    // Close only the original capture; never reselect a replacement after conflict.
    await this.stop(entry, 'cancelled');
    return this.snapshot(entry.saved);
  }

  seal(): void {
    this.sealed = true;
    for (const entry of this.active.values()) {
      entry.retired = true;
      entry.abort.abort();
      if (entry.timer) clearTimeout(entry.timer);
    }
  }

  async close(): Promise<void> {
    this.seal();
    const entries = [...this.active.values()];
    await Promise.allSettled(entries.map((entry) => this.stop(entry, 'cancelled')));
    if (this.cleanupDebt.size || entries.some((entry) => entry.saved.resourceHeld))
      throw new ManagementCommandError('held');
  }

  private assertAdmission(): void {
    this.options.assertWriter();
    if (this.sealed) throw new ManagementCommandError('held');
  }

  private assertBound(entry: ActiveOAuth): void {
    this.assertAdmission();
    if (entry.retired || entry.receiptConflict || this.active.get(entry.saved.commandId) !== entry)
      throw new ManagementCommandError('held');
    assertManagementTarget(
      entry.saved,
      this.options.select(entry.saved.profileId, entry.saved.configRevision)
    );
  }

  private readOriginal(input: z.infer<typeof identity>): StoredOAuthCommand | undefined {
    const saved = this.options.store.read(input.operationId);
    if (!saved) return undefined;
    if (
      saved.kind !== 'oauth' ||
      saved.profileId !== input.profileId ||
      saved.configRevision !== input.configRevision
    )
      throw new ManagementCommandError('conflict');
    return saved;
  }

  private snapshot(saved: StoredOAuthCommand, preferLive = true): ProviderOAuthSnapshot {
    const active = this.active.get(saved.commandId);
    const current = (preferLive ? active?.saved : undefined) ?? saved;
    const unavailable =
      (!active || !preferLive && active.retired) &&
      !['completed', 'cancelled', 'failed', 'held'].includes(current.phase);
    return {
      operationId: current.commandId,
      profileId: current.profileId,
      configRevision: current.configRevision,
      providerId: current.providerId,
      methodIndex: current.methodIndex,
      phase: unavailable ? 'held' : current.phase,
      completionMethod: current.completionMethod,
      sequence: current.sequence,
      expiresAt: current.expiresAt,
      ...(unavailable
        ? { reason: 'native-outcome-unknown' as const }
        : current.reason
          ? { reason: current.reason }
          : {}),
    };
  }

  private emit(entry: ActiveOAuth): void {
    if (this.sealed) return;
    try {
      this.options.assertWriter();
      this.options.onProgress?.(this.snapshot(entry.saved));
    } catch {
      /* Original snapshot/sequence remains available after a delivery gap. */
    }
  }

  private publish(
    entry: ActiveOAuth,
    phase: StoredOAuthCommand['phase'],
    patch: Partial<StoredOAuthCommand> = {}
  ): void {
    this.assertBound(entry);
    this.assertStoredOriginal(entry);
    const next = { ...entry.saved, ...patch, phase, sequence: entry.saved.sequence + 1 };
    try {
      this.options.store.write(next);
    } catch (error) {
      entry.completionPublicationUnknown = true;
      void this.stop(entry, 'native-outcome-unknown');
      throw error;
    }
    entry.saved = next;
    this.emit(entry);
  }

  private async authorize(
    entry: ActiveOAuth,
    fields: Record<string, string> | undefined
  ): Promise<void> {
    try {
      this.assertBound(entry);
      const result = await entry.native.authorize(fields, entry.abort.signal);
      this.assertBound(entry);
      const url = new URL(result.authorizationUrl);
      if (
        url.username ||
        url.password ||
        !(
          url.protocol === 'https:' ||
          (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
        ) ||
        result.authorizationUrl.length > 16384 ||
        typeof result.instructions !== 'string' ||
        result.instructions.length > 16384 ||
        !['auto', 'code'].includes(result.completionMethod) ||
        (result.browserOwner !== undefined && result.browserOwner !== 'native') ||
        (result.userCode !== undefined &&
          (typeof result.userCode !== 'string' ||
            !result.userCode.trim() ||
            result.userCode.length > 256 ||
            Array.from(result.userCode).some((character) => {
              const code = character.charCodeAt(0);
              return code < 32 || code === 127;
            })))
      )
        throw new ManagementCommandError('invalid');
      entry.authorization = {
        authorizationUrl: url.href,
        instructions: result.instructions,
        ...(result.browserOwner ? { browserOwner: result.browserOwner } : {}),
        ...(result.userCode === undefined ? {} : { userCode: result.userCode }),
      };
      this.publish(
        entry,
        result.completionMethod === 'code' ? 'waiting-for-code' : 'waiting-for-browser',
        { completionMethod: result.completionMethod }
      );
      if (entry.native.nativeCompletion) void this.observeNativeCompletion(entry);
    } catch {
      if (!entry.retired) await this.stop(entry, 'native-outcome-unknown');
    }
  }

  private async observeNativeCompletion(entry: ActiveOAuth): Promise<void> {
    try {
      const ok = await entry.native.nativeCompletion;
      this.assertCompletionCurrent(entry);
      while (entry.pendingCompletion) {
        await entry.pendingCompletion.settled;
        this.assertCompletionCurrent(entry);
      }
      // An explicit code submission owns its original completion command and native outcome.
      if (entry.saved.completionCommandId) return;
      if (!ok) {
        await this.stop(entry, entry.native.nativeRejectionConfirmed === true
          ? 'native-rejected' : 'native-outcome-unknown');
        return;
      }
      if (!['waiting-for-code', 'waiting-for-browser'].includes(entry.saved.phase)) return;
      const commandId = `native:${managementDigest({ operationId: entry.saved.commandId })}`;
      this.publishCompletion(entry, commandId, { fingerprint: managementDigest({ commandId, code: null }) });
      await this.finish(entry, undefined);
    } catch {
      if (!entry.retired) await this.stop(entry, 'native-outcome-unknown');
    }
  }

  private async finish(entry: ActiveOAuth, code: string | undefined): Promise<void> {
    try {
      this.assertBound(entry);
      const ok = await entry.native.complete(code, entry.abort.signal);
      this.assertBound(entry);
      if (!ok) {
        await this.stop(entry, 'native-outcome-unknown');
        return;
      }
      this.publish(entry, 'completed', { resourceHeld: false });
      this.retire(entry, true);
    } catch {
      if (!entry.retired) await this.stop(entry, 'native-outcome-unknown');
    }
  }

  private stop(
    entry: ActiveOAuth,
    reason: NonNullable<StoredOAuthCommand['reason']>
  ): Promise<void> {
    if (entry.closing) return entry.closing;
    entry.retired = true; // Fence before abort/await; late native replies cannot publish.
    entry.closing = Promise.resolve().then(async () => {
      let clean = false;
      try {
        clean = await entry.native.close();
      } catch {
        /* Retain unknown writer custody. */
      }
      if (entry.completionPublicationUnknown || entry.receiptConflict) clean = false;
      const final: StoredOAuthCommand = {
        ...entry.saved,
        phase: !clean ? 'held'
          : reason === 'native-rejected' ? 'failed'
            : reason === 'cancelled' || reason === 'expired' ? 'cancelled' : 'held',
        resourceHeld: !clean,
        sequence: entry.saved.sequence + 1,
      };
      if (!entry.completionPublicationUnknown && !entry.receiptConflict) {
        try {
          this.options.assertWriter();
          if (!this.storedOriginalMatches(entry)) {
            entry.receiptConflict = true;
            clean = false;
          } else {
            // No await between the second durable comparison and final write.
            this.options.store.write(final);
            entry.saved = final;
          }
        } catch {
          entry.completionPublicationUnknown = true;
          clean = false;
        }
      }
      if (!clean) {
        entry.saved = { ...entry.saved, phase: 'held', resourceHeld: true };
      }
      this.emit(entry);
      this.retire(entry, clean);
    });
    entry.abort.abort();
    delete entry.authorization;
    if (entry.timer) clearTimeout(entry.timer);

    const cancelling: StoredOAuthCommand = {
      ...entry.saved,
      phase: 'cancelling',
      reason,
      sequence: entry.saved.sequence + 1,
      resourceHeld: true,
    };
    if (!entry.completionPublicationUnknown && !entry.receiptConflict) {
      try {
        this.options.assertWriter();
        if (!this.storedOriginalMatches(entry)) {
          entry.receiptConflict = true;
        } else {
          // First cancellation write is also synchronous and original-bound.
          this.options.store.write(cancelling);
          entry.saved = cancelling;
        }
      } catch {
        // Unknown write outcome must not be overwritten during later cleanup.
        entry.completionPublicationUnknown = true;
      }
    }
    if (entry.receiptConflict || entry.completionPublicationUnknown)
      entry.saved = { ...entry.saved, phase: 'held', resourceHeld: true };
    this.emit(entry);
    return entry.closing;
  }

  private retire(entry: ActiveOAuth, settled: boolean): void {
    entry.retired = true;
    delete entry.authorization;
    if (entry.timer) clearTimeout(entry.timer);
    this.options.fence.release(entry.saved.resourceId, entry.saved.commandId, settled);
    if (!settled) this.cleanupDebt.add(entry.saved.commandId);
    if (this.active.get(entry.saved.commandId) === entry) this.active.delete(entry.saved.commandId);
  }
}
