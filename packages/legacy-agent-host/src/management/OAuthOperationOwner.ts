import { z } from 'zod';

import { assertManagementTarget, ManagementCommandError } from './commandRecords.js';
import { managementDigest } from './identity.js';

import type {
  ManagementCommandStore,
  ManagementTarget,
  StoredOAuthCommand,
} from './commandRecords.js';
import type { ProviderOAuthSnapshot } from './contracts.js';
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

/** Captured native conversation. prepare() does not allocate; close seals even pending allocation. */
export interface OAuthNativeConversation {
  readonly timeoutMs: number;
  /** Native browser callbacks may complete while the optional paste-code UI remains open. */
  readonly nativeCompletion?: Promise<boolean>;
  authorize(
    fields: Record<string, string> | undefined,
    signal: AbortSignal
  ): Promise<{
    authorizationUrl: string;
    instructions: string;
    completionMethod: 'auto' | 'code';
    browserOwner?: 'native';
  }>;
  complete(code: string | undefined, signal: AbortSignal): Promise<boolean>;
  close(): Promise<boolean>;
}

interface ActiveOAuth {
  saved: StoredOAuthCommand;
  native: OAuthNativeConversation;
  abort: AbortController;
  authorization?: { authorizationUrl: string; instructions: string; browserOwner?: 'native' };
  timer?: NodeJS.Timeout;
  closing?: Promise<void>;
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
      this.options.store.write(saved);
      entry = { saved, native, abort: new AbortController(), retired: false };
      this.active.set(input.operationId, entry);
    } catch (error) {
      this.options.fence.release(target.resourceId, input.operationId, true);
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
  authorization(
    raw: unknown
  ): { authorizationUrl: string; instructions: string; browserOwner?: 'native' } | null {
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

  complete(raw: unknown): ProviderOAuthSnapshot {
    const input = completeSchema.parse(raw);
    this.assertAdmission();
    const saved = this.readOriginal(input);
    if (!saved) throw new ManagementCommandError('invalid');
    const fingerprint = managementDigest({ commandId: input.commandId, code: input.code ?? null });
    if (saved.completionCommandId) {
      if (
        saved.completionCommandId !== input.commandId ||
        saved.completionFingerprint !== fingerprint
      )
        throw new ManagementCommandError('conflict');
      return this.snapshot(saved);
    }
    const entry = this.active.get(input.operationId);
    if (!entry || entry.retired) return this.snapshot(saved);
    this.assertBound(entry);
    if (
      !['waiting-for-code', 'waiting-for-browser'].includes(entry.saved.phase) ||
      (entry.saved.completionMethod === 'code') !== (input.code !== undefined)
    )
      throw new ManagementCommandError('invalid');
    try {
      this.publish(entry, 'completing', {
        completionCommandId: input.commandId,
        completionFingerprint: fingerprint,
      });
    } catch (error) {
      void this.stop(entry, 'native-outcome-unknown');
      throw error;
    }
    void this.finish(entry, input.code);
    return this.snapshot(entry.saved);
  }

  async cancel(raw: unknown): Promise<ProviderOAuthSnapshot> {
    const input = identity.parse(raw);
    this.assertAdmission();
    const saved = this.readOriginal(input);
    if (!saved) throw new ManagementCommandError('invalid');
    const entry = this.active.get(input.operationId);
    if (!entry) return this.snapshot(saved);
    // Close the original capture even if its namespace/config changed; never select a replacement.
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
    if (entry.retired || this.active.get(entry.saved.commandId) !== entry)
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

  private snapshot(saved: StoredOAuthCommand): ProviderOAuthSnapshot {
    const current = this.active.get(saved.commandId)?.saved ?? saved;
    const unavailable =
      !this.active.has(saved.commandId) &&
      !['completed', 'cancelled', 'held'].includes(current.phase);
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
    const next = { ...entry.saved, ...patch, phase, sequence: entry.saved.sequence + 1 };
    this.options.store.write(next);
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
        (result.browserOwner !== undefined && result.browserOwner !== 'native')
      )
        throw new ManagementCommandError('invalid');
      entry.authorization = {
        authorizationUrl: url.href,
        instructions: result.instructions,
        ...(result.browserOwner ? { browserOwner: result.browserOwner } : {}),
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
      this.assertBound(entry);
      // An explicit code submission owns its original completion command and native outcome.
      if (entry.saved.completionCommandId) return;
      if (!ok) {
        await this.stop(entry, 'native-outcome-unknown');
        return;
      }
      if (!['waiting-for-code', 'waiting-for-browser'].includes(entry.saved.phase)) return;
      const commandId = `native:${managementDigest({ operationId: entry.saved.commandId })}`;
      this.publish(entry, 'completing', {
        completionCommandId: commandId,
        completionFingerprint: managementDigest({ commandId, code: null }),
      });
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
      entry.saved.phase =
        clean && (reason === 'cancelled' || reason === 'expired') ? 'cancelled' : 'held';
      entry.saved.resourceHeld = !clean;
      entry.saved.sequence++;
      try {
        this.options.assertWriter();
        this.options.store.write(entry.saved);
      } catch {
        clean = false;
        entry.saved.phase = 'held';
        entry.saved.resourceHeld = true;
      }
      this.emit(entry);
      this.retire(entry, clean);
    });
    entry.abort.abort();
    delete entry.authorization;
    if (entry.timer) clearTimeout(entry.timer);
    entry.saved.phase = 'cancelling';
    entry.saved.reason = reason;
    entry.saved.sequence++;
    entry.saved.resourceHeld = true;
    try {
      this.options.assertWriter();
      this.options.store.write(entry.saved);
    } catch {
      /* Cleanup still mandatory. */
    }
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
