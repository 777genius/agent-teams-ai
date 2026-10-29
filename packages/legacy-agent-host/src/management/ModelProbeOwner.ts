import { z } from 'zod';

import { assertManagementTarget, ManagementCommandError } from './commandRecords.js';
import { managementDigest } from './identity.js';
import { modelProbeLimitsSchema } from './modelLimits.js';

import type {
  ManagementCommandStore,
  ManagementTarget,
  StoredModelProbe,
} from './commandRecords.js';
import type { ProviderModelProbeSnapshot } from './contracts.js';
import type { ManagementResourceFence } from './ManagementResourceFence.js';

const id = z.string().min(1).max(256);
const identity = z.object({ commandId: id, profileId: id, configRevision: id }).strict();
const startSchema = identity
  .extend({
    providerId: id,
    modelId: id,
    limits: modelProbeLimitsSchema.optional(),
    effort: z
      .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
      .optional(),
    modelContext: z.enum(['model-default', 'one-million']).optional(),
    context: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type ModelProbeInput = z.infer<typeof startSchema>;
export interface NativeModelProbe {
  timeoutMs: number;
  run(signal: AbortSignal): Promise<boolean>;
  close(): Promise<boolean>;
}
interface ActiveProbe {
  saved: StoredModelProbe;
  native: NativeModelProbe;
  abort: AbortController;
  timer?: NodeJS.Timeout;
  closing?: Promise<void>;
  retired: boolean;
  isCurrent(): boolean;
}

/** Durable at-most-once admission for explicit model tests; lookup/restart cannot spend twice. */
export class ModelProbeOwner {
  private readonly active = new Map<string, ActiveProbe>();
  private readonly debt = new Set<string>();
  private sealed = false;
  constructor(
    private readonly options: {
      store: ManagementCommandStore;
      fence: ManagementResourceFence;
      assertWriter(): void;
      select(profileId: string, configRevision: string): ManagementTarget;
      prepare(input: ModelProbeInput, isCurrent: () => boolean): NativeModelProbe;
    }
  ) {}

  start(raw: unknown, guard: () => boolean = () => true): ProviderModelProbeSnapshot {
    const input = startSchema.parse(raw);
    this.assertAdmission();
    const isCurrent = () => {
      try {
        return guard();
      } catch {
        return false;
      }
    };
    if (!isCurrent()) throw new ManagementCommandError('held');
    const target = this.options.select(input.profileId, input.configRevision);
    const fingerprint = managementDigest(input);
    const previous = this.options.store.read(input.commandId);
    if (previous) {
      if (previous.kind !== 'model.probe' || previous.fingerprint !== fingerprint)
        throw new ManagementCommandError('conflict');
      assertManagementTarget(previous, target);
      return this.snapshot(previous);
    }
    this.options.fence.reserve(target.resourceId, input.commandId);
    let entry: ActiveProbe;
    try {
      const native = this.options.prepare(input, isCurrent);
      if (
        !Number.isSafeInteger(native.timeoutMs) ||
        native.timeoutMs < 1 ||
        native.timeoutMs > 180000
      )
        throw new ManagementCommandError('invalid');
      const saved: StoredModelProbe = {
        schemaVersion: 1,
        ...target,
        kind: 'model.probe',
        commandId: input.commandId,
        providerId: input.providerId,
        modelId: input.modelId,
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.modelContext === undefined ? {} : { modelContext: input.modelContext }),
        ...(input.context === undefined ? {} : { context: input.context }),
        ...(input.limits ? { limits: input.limits } : {}),
        fingerprint,
        phase: 'running',
        resourceHeld: true,
        ok: false,
        expiresAt: Date.now() + native.timeoutMs,
      };
      this.options.store.write(saved);
      entry = { saved, native, abort: new AbortController(), retired: false, isCurrent };
      this.active.set(input.commandId, entry);
    } catch (error) {
      this.options.fence.release(target.resourceId, input.commandId, true);
      throw error;
    }
    entry.timer = setTimeout(() => {
      void this.finish(entry, 'cancelled', false);
    }, entry.native.timeoutMs);
    entry.timer.unref();
    void this.run(entry);
    return this.snapshot(entry.saved);
  }

  read(raw: unknown): ProviderModelProbeSnapshot | null {
    this.assertAdmission();
    const input = identity.parse(raw),
      saved = this.original(input);
    return saved ? this.snapshot(saved) : null;
  }

  /** Team evidence is usable only for the same current physical account/config target. */
  readCurrent(raw: unknown): ProviderModelProbeSnapshot | null {
    this.assertAdmission();
    const input = identity.parse(raw),
      saved = this.original(input);
    if (!saved) return null;
    assertManagementTarget(saved, this.options.select(input.profileId, input.configRevision));
    return this.snapshot(saved);
  }

  async cancel(raw: unknown): Promise<ProviderModelProbeSnapshot> {
    this.assertAdmission();
    const input = identity.parse(raw),
      saved = this.original(input);
    if (!saved) throw new ManagementCommandError('invalid');
    const entry = this.active.get(input.commandId);
    if (entry) await this.finish(entry, 'cancelled', false);
    else if (saved.phase === 'held' && !saved.resourceHeld) {
      // Abandon an unavailable model observation only after confirmed native
      // release. This settles cancellation without ever replaying its input.
      const cancelled: StoredModelProbe = { ...saved, phase: 'cancelled', ok: false };
      this.options.store.write(cancelled);
      return this.snapshot(cancelled);
    }
    return this.snapshot(entry?.saved ?? saved);
  }

  /** Composition cleanup only: the retained context binds the exact original Team selection. */
  async cancelContextual(commandId: string, context: string): Promise<ProviderModelProbeSnapshot> {
    this.assertAdmission();
    const saved = this.options.store.read(id.parse(commandId));
    if (!saved || saved.kind !== 'model.probe' || saved.context !== context)
      throw new ManagementCommandError('conflict');
    return this.cancel({
      commandId,
      profileId: saved.profileId,
      configRevision: saved.configRevision,
    });
  }

  private original(input: z.infer<typeof identity>): StoredModelProbe | undefined {
    const saved = this.options.store.read(input.commandId);
    if (!saved) return undefined;
    if (
      saved.kind !== 'model.probe' ||
      saved.profileId !== input.profileId ||
      saved.configRevision !== input.configRevision
    )
      throw new ManagementCommandError('conflict');
    return saved;
  }

  private snapshot(saved: StoredModelProbe): ProviderModelProbeSnapshot {
    const current = this.active.get(saved.commandId)?.saved ?? saved;
    return {
      commandId: current.commandId,
      profileId: current.profileId,
      configRevision: current.configRevision,
      providerId: current.providerId,
      modelId: current.modelId,
      ...(current.effort === undefined ? {} : { effort: current.effort }),
      ...(current.modelContext === undefined ? {} : { modelContext: current.modelContext }),
      ...(current.context === undefined ? {} : { context: current.context }),
      ...(current.limits ? { limits: current.limits } : {}),
      phase:
        current.phase === 'running' && !this.active.has(current.commandId) ? 'held' : current.phase,
      ok: current.phase === 'completed' && current.ok,
      expiresAt: current.expiresAt,
    };
  }

  private assertAdmission(): void {
    this.options.assertWriter();
    if (this.sealed) throw new ManagementCommandError('held');
  }

  private async run(entry: ActiveProbe): Promise<void> {
    try {
      this.assertAdmission();
      if (!entry.isCurrent()) {
        await this.finish(entry, 'cancelled', false);
        return;
      }
      assertManagementTarget(
        entry.saved,
        this.options.select(entry.saved.profileId, entry.saved.configRevision)
      );
      const ok = await entry.native.run(entry.abort.signal);
      if (!entry.retired) await this.finish(entry, 'completed', ok);
    } catch {
      if (!entry.retired) await this.finish(entry, 'held', false);
    }
  }

  private finish(entry: ActiveProbe, phase: StoredModelProbe['phase'], ok: boolean): Promise<void> {
    if (entry.closing) return entry.closing;
    entry.retired = true; // Fence before abort or physical close; late success cannot win cancellation.
    entry.abort.abort();
    if (entry.timer) clearTimeout(entry.timer);
    entry.closing = Promise.resolve().then(async () => {
      let clean = false;
      try {
        clean = await entry.native.close();
      } catch {
        /* Unknown custody remains held. */
      }
      if (phase === 'completed' && !entry.isCurrent()) {
        phase = 'cancelled';
        ok = false;
      }
      entry.saved = {
        ...entry.saved,
        phase: clean ? phase : 'held',
        resourceHeld: !clean,
        ok: clean && phase === 'completed' && ok,
      };
      try {
        this.options.assertWriter();
        if (phase === 'completed')
          assertManagementTarget(
            entry.saved,
            this.options.select(entry.saved.profileId, entry.saved.configRevision)
          );
        this.options.store.write(entry.saved);
      } catch {
        clean = false;
        entry.saved.phase = 'held';
        entry.saved.ok = false;
        entry.saved.resourceHeld = true;
      }
      this.options.fence.release(entry.saved.resourceId, entry.saved.commandId, clean);
      if (!clean) this.debt.add(entry.saved.commandId);
      if (this.active.get(entry.saved.commandId) === entry)
        this.active.delete(entry.saved.commandId);
    });
    return entry.closing;
  }

  seal(): void {
    this.sealed = true;
    for (const entry of this.active.values()) void this.finish(entry, 'cancelled', false);
  }
  async close(): Promise<void> {
    this.seal();
    await Promise.allSettled(
      [...this.active.values()].map((entry) => this.finish(entry, 'cancelled', false))
    );
    if (this.debt.size) throw new ManagementCommandError('held');
  }
}
