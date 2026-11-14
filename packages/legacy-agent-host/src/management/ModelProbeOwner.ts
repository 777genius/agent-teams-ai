import { z } from 'zod';

import { assertManagementTarget, ManagementCommandError, nativeLocalReadinessEvidenceSchema,
  modelReadinessProbeScopeSchema, modelReadinessReferenceSchema } from './commandRecords.js';
import { managementDigest } from './identity.js';
import { modelProbeLimitsSchema } from './modelLimits.js';
import { AcceptedOpenCodeV2FileKey, openCodeV2NativeFileWitnessSchema } from '../adapters/providers/OpenCodeV2SelectedFileKey.js';

import type {
  LocalModelReadinessOrigin,
  ManagementCommandStore,
  ReadinessPreparationAnchor,
  ManagementTarget,
  NativeLocalReadinessEvidence,
  StoredModelProbe,
  ModelReadinessProbeScope,
  ModelReadinessReference,
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
export const nativeCoordinationPurpose = 'native-local-coordination-v1' as const;
export const nativeLocalReadinessPurpose = 'native-local-readiness-v1' as const;
export type NativeModelProbePurpose = typeof nativeCoordinationPurpose | typeof nativeLocalReadinessPurpose;
const coordinationIdentity = identity.extend({
  context: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export interface NativeModelProbe {
  timeoutMs: number;
  run(signal: AbortSignal, originalDeadline?: number): Promise<boolean>;
  close(originalDeadline?: number): Promise<boolean>;
  /** Private adapter observation. Only the original owner can persist or qualify it. */
  readiness?(): NativeLocalReadinessEvidence | undefined;
  nativeFileKeyWitness?(): unknown;
}
interface ActiveProbe {
  saved: StoredModelProbe;
  native: NativeModelProbe;
  abort: AbortController;
  timer?: NodeJS.Timeout;
  closing?: Promise<void>;
  retired: boolean;
  isCurrent(): boolean;
  readiness?: NativeLocalReadinessEvidence;
  running?: Promise<void>;
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
      prepare(input: ModelProbeInput, isCurrent: () => boolean, purpose?: NativeModelProbePurpose,
        origin?: LocalModelReadinessOrigin): NativeModelProbe;
      readinessOriginCurrent?(origin: LocalModelReadinessOrigin, input: ModelProbeInput,
        current?: () => boolean): boolean;
    }
  ) {}

  start(raw: unknown, guard: () => boolean = () => true): ProviderModelProbeSnapshot {
    return this.admit(startSchema.parse(raw), guard);
  }

  /** Private composition only. The strict public start parser cannot select this purpose. */
  startNativeCoordination(raw: unknown, guard: () => boolean): ProviderModelProbeSnapshot {
    const input = startSchema.extend({ context: coordinationIdentity.shape.context }).parse(raw);
    return this.admit(input, guard, nativeCoordinationPurpose);
  }

  /** Private compound proof; the public start parser cannot supply purpose or evidence. */
  startNativeReadiness(raw: unknown, guard: () => boolean, scope?: ModelReadinessProbeScope): ProviderModelProbeSnapshot {
    const input = startSchema.extend({ context: coordinationIdentity.shape.context }).parse(raw);
    return this.admit(input, guard, nativeLocalReadinessPurpose, undefined, scope);
  }

  /** Private preparation composition; never upgrades an already retained ordinary receipt. */
  startPrepared(raw: unknown, guard: () => boolean, prepared?: {
    anchor: ReadinessPreparationAnchor; origin?: LocalModelReadinessOrigin;
  }, scope?: ModelReadinessProbeScope): ProviderModelProbeSnapshot {
    this.assertAdmission();
    const input = startSchema.parse(raw), previous = this.options.store.read(input.commandId);
    if (previous) {
      if (previous.kind !== 'model.probe' || scope &&
          managementDigest(previous.readinessScope ?? null) !== managementDigest(scope) || prepared &&
          (managementDigest(previous.localModelReadinessPreparation ?? null) !== managementDigest(prepared.anchor) ||
           managementDigest(previous.localModelReadinessOrigin ?? null) !== managementDigest(prepared.origin ?? null)))
        throw new ManagementCommandError('conflict');
      return this.admit(input, guard, previous.purpose,
        previous.localModelReadinessPreparation ? {
          anchor: previous.localModelReadinessPreparation,
          ...(previous.localModelReadinessOrigin ? { origin: previous.localModelReadinessOrigin } : {}),
        } : undefined, previous.readinessScope);
    }
    return this.admit(input, guard, prepared?.origin ? nativeLocalReadinessPurpose : undefined, prepared, scope);
  }

  /** Original first-group record only. Absence and a historical record without origin are distinct. */
  readPreparation(commandId: string): { present: boolean; anchor?: ReadinessPreparationAnchor } {
    this.assertAdmission();
    const saved = this.options.store.read(id.parse(commandId));
    if (!saved) return { present: false };
    if (saved.kind !== 'model.probe') throw new ManagementCommandError('conflict');
    const anchor = saved.localModelReadinessPreparation;
    if (anchor && anchor.anchorCommandId !== commandId) throw new ManagementCommandError('conflict');
    return { present: true, ...(anchor ? { anchor: structuredClone(anchor) } : {}) };
  }

  /** B2 may consume only this original complete receipt, never a public ok boolean. */
  readNativeReadiness(raw: unknown) {
    this.assertAdmission();
    const input = coordinationIdentity.parse(raw), saved = this.original(input);
    if (!saved) return null;
    if (saved.purpose !== nativeLocalReadinessPurpose || saved.context !== input.context)
      throw new ManagementCommandError('conflict');
    assertManagementTarget(saved, this.options.select(input.profileId, input.configRevision));
    if (saved.phase !== 'completed' || !saved.ok || saved.readinessRetired || saved.resourceHeld || !saved.readiness ||
        saved.readiness.evidence.decision !== 'allow' ||
        saved.readiness.evidence.ordinary !== 'confirmed' || !this.originCurrent(saved) ||
        Date.now() >= saved.expiresAt || saved.readiness.context !== input.context ||
        saved.readiness.selectionDigest !== saved.selectionDigest)
      throw new ManagementCommandError('held');
    return Object.freeze({ ...this.snapshot(saved), readiness: structuredClone(saved.readiness) });
  }

  /** Exact private inspection only. The caller still needs captureReadinessReference to qualify it. */
  readRetainedProbe(commandId: string, context: string): Readonly<StoredModelProbe> {
    this.assertAdmission();
    const saved = this.options.store.read(id.parse(commandId));
    if (!saved || saved.kind !== 'model.probe' || saved.context !== context)
      throw new ManagementCommandError('conflict');
    return Object.freeze(structuredClone(saved));
  }

  /** Original selection lookup by its explicit command, never a scan or latest-result fallback. */
  readScopedProbe(commandId: string, teamBindingDigest: string, selectionDigest: string): Readonly<StoredModelProbe> {
    this.assertAdmission();
    const saved = this.options.store.read(id.parse(commandId));
    if (!saved || saved.kind !== 'model.probe' || !saved.context ||
        saved.readinessScope?.teamBindingDigest !== teamBindingDigest ||
        saved.readinessScope.selectionDigest !== selectionDigest)
      throw new ManagementCommandError('conflict');
    return Object.freeze(structuredClone(saved));
  }

  /** Wait for the already admitted operation itself; never poll, admit or recreate it. */
  async awaitPrepared(commandId: string, context: string): Promise<void> {
    this.readRetainedProbe(commandId, context);
    const running = this.active.get(commandId)?.running;
    if (running) await running;
    this.readRetainedProbe(commandId, context);
  }

  captureReadinessReference(commandId: string, context: string, inspect: (saved: Readonly<StoredModelProbe>) => {
    target: ManagementTarget; originCurrent: boolean; accountDigest?: string;
  }): ModelReadinessReference {
    const saved = this.readRetainedProbe(commandId, context), current = inspect(saved);
    this.assertAdmission();
    assertManagementTarget(saved, current.target);
    if (!saved.readinessScope || saved.readinessRetired || saved.phase !== 'completed' || !saved.ok || saved.resourceHeld ||
        Date.now() >= saved.expiresAt || Date.now() >= saved.readinessScope.cutoff || saved.localModelReadinessPreparation &&
          Date.now() >= saved.localModelReadinessPreparation.expiresAt || !current.originCurrent ||
        saved.purpose !== undefined && saved.purpose !== nativeLocalReadinessPurpose)
      throw new ManagementCommandError('held');
    if (saved.purpose === nativeLocalReadinessPurpose && (!saved.readiness ||
        saved.readiness.context !== context || saved.readiness.selectionDigest !== saved.selectionDigest ||
        saved.readiness.evidence.decision !== 'allow' || saved.readiness.evidence.ordinary !== 'confirmed' ||
        saved.readiness.evidence.accountDigest !== current.accountDigest))
      throw new ManagementCommandError('held');
    if (saved.nativeFileKeyWitness !== undefined && current.accountDigest === undefined ||
        saved.readinessScope.accountDigest !== undefined &&
        saved.readinessScope.accountDigest !== current.accountDigest) throw new ManagementCommandError('held');
    return modelReadinessReferenceSchema.parse({
      commandId, context, profileId: saved.profileId, configRevision: saved.configRevision,
      fingerprint: saved.fingerprint, selectionDigest: saved.selectionDigest, resourceId: saved.resourceId,
      purpose: saved.purpose ?? 'ordinary', expiresAt: saved.expiresAt,
      preparationDigest: managementDigest({ scope: saved.readinessScope,
        anchor: saved.localModelReadinessPreparation ?? null, origin: saved.localModelReadinessOrigin ?? null,
        ...(saved.nativeFileKeyWitness === undefined ? {} : { nativeFileKeyWitness: managementDigest(saved.nativeFileKeyWitness) }) }),
      mechanismDigest: saved.readinessScope.mechanismDigest,
    });
  }

  assertReadinessReference(reference: ModelReadinessReference,
    inspect: Parameters<ModelProbeOwner['captureReadinessReference']>[2]): void {
    const input = modelReadinessReferenceSchema.parse(reference);
    if (managementDigest(input) !== managementDigest(this.captureReadinessReference(
      input.commandId, input.context, inspect))) throw new ManagementCommandError('conflict');
  }

  /** Historical source facts for a separately authorized same-target action, never a fresh grant. */
  readReadinessProvenance(reference: ModelReadinessReference,
    inspect: Parameters<ModelProbeOwner['captureReadinessReference']>[2]): Readonly<StoredModelProbe> {
    const input = modelReadinessReferenceSchema.parse(reference);
    const saved = this.readRetainedProbe(input.commandId, input.context), current = inspect(saved);
    assertManagementTarget(saved, current.target);
    if (!saved.readinessScope || saved.phase !== 'completed' || !saved.ok || saved.resourceHeld ||
        !current.originCurrent || saved.fingerprint !== input.fingerprint ||
        saved.selectionDigest !== input.selectionDigest || saved.resourceId !== input.resourceId ||
        saved.profileId !== input.profileId || saved.configRevision !== input.configRevision ||
        saved.expiresAt !== input.expiresAt || (saved.purpose ?? 'ordinary') !== input.purpose ||
        saved.readinessScope.mechanismDigest !== input.mechanismDigest ||
        managementDigest({ scope: saved.readinessScope, anchor: saved.localModelReadinessPreparation ?? null,
          origin: saved.localModelReadinessOrigin ?? null,
          ...(saved.nativeFileKeyWitness === undefined ? {} : { nativeFileKeyWitness: managementDigest(saved.nativeFileKeyWitness) }) }) !== input.preparationDigest ||
        (saved.purpose === undefined ? saved.readinessScope.kind !== 'native' :
          saved.purpose !== nativeLocalReadinessPurpose || !saved.readiness ||
          saved.readiness.context !== input.context || saved.readiness.selectionDigest !== saved.selectionDigest ||
          saved.readiness.evidence.decision !== 'allow' || saved.readiness.evidence.ordinary !== 'confirmed' ||
          saved.readiness.evidence.accountDigest !== current.accountDigest) ||
        saved.nativeFileKeyWitness !== undefined && current.accountDigest === undefined ||
        saved.readinessScope.accountDigest !== undefined && saved.readinessScope.accountDigest !== current.accountDigest)
      throw new ManagementCommandError('held');
    this.assertAdmission();
    return saved;
  }

  /** Writer-only cleanup survives sealed work admission and revoked operator grants. */
  async cancelRetained(commandId: string, context: string): Promise<void> {
    this.options.assertWriter();
    const saved = this.options.store.read(id.parse(commandId));
    if (!saved || saved.kind !== 'model.probe' || saved.context !== context)
      throw new ManagementCommandError('conflict');
    this.options.store.write({ ...saved, readinessRetired: true });
    const entry = this.active.get(commandId);
    if (entry) entry.saved = { ...entry.saved, readinessRetired: true };
    if (entry) await this.finish(entry, 'cancelled', false);
    this.options.assertWriter();
    const original = this.options.store.read(commandId);
    if (!original || original.kind !== 'model.probe' || original.context !== context || original.resourceHeld)
      throw new ManagementCommandError('held');
  }

  /** Traversal is cleanup only; no successful-proof selection or new management target. */
  async cancelTeamPreparations(teamBindingDigest: string, actionDigest?: string, destinationKey?: string): Promise<void> {
    this.options.assertWriter();
    const original = [...this.options.store.list()].filter((row): row is StoredModelProbe =>
      row.kind === 'model.probe' && row.readinessScope?.teamBindingDigest === teamBindingDigest &&
      (actionDigest === undefined || row.readinessScope.actionDigest === actionDigest) &&
      (destinationKey === undefined || row.readinessScope.destinationKeys.length === 1 &&
        row.readinessScope.destinationKeys[0] === destinationKey));
    const results = await Promise.allSettled(original.map(row => this.cancelRetained(row.commandId, row.context!)));
    if (results.some(result => result.status === 'rejected')) throw new ManagementCommandError('held');
  }

  /** Exact current proof only; running, held, historical text-only or expired rows cannot qualify. */
  readNativeCoordination(raw: unknown): ProviderModelProbeSnapshot | null {
    this.assertAdmission();
    const input = coordinationIdentity.parse(raw), saved = this.original(input);
    if (!saved) return null;
    if (saved.purpose !== nativeCoordinationPurpose || saved.context !== input.context)
      throw new ManagementCommandError('conflict');
    assertManagementTarget(saved, this.options.select(input.profileId, input.configRevision));
    if (saved.phase !== 'completed' || !saved.ok || saved.resourceHeld || Date.now() >= saved.expiresAt)
      throw new ManagementCommandError('held');
    return this.snapshot(saved);
  }

  private admit(input: ModelProbeInput, guard: () => boolean,
    purpose?: NativeModelProbePurpose,
    prepared?: { anchor: ReadinessPreparationAnchor; origin?: LocalModelReadinessOrigin },
    scope?: ModelReadinessProbeScope
  ): ProviderModelProbeSnapshot {
    this.assertAdmission();
    const admittedAt = Date.now();
    const privateScope = scope ? modelReadinessProbeScopeSchema.parse(scope) : undefined;
    const isCurrent = () => {
      try {
        return guard() && (!prepared?.origin || Date.now() < prepared.anchor.expiresAt) &&
          (!privateScope || Date.now() < privateScope.cutoff);
      } catch {
        return false;
      }
    };
    if (!isCurrent()) throw new ManagementCommandError('held');
    const target = this.options.select(input.profileId, input.configRevision);
    if (prepared?.origin && this.options.readinessOriginCurrent?.(prepared.origin, input, isCurrent) !== true)
      throw new ManagementCommandError('held');
    const original = purpose ? { ...input, purpose, target } : input;
    const committed = prepared ? { ...original, localModelReadinessPreparation: prepared.anchor,
      ...(prepared.origin ? { localModelReadinessOrigin: prepared.origin } : {}) } : original;
    const fingerprint = managementDigest(privateScope ? { ...committed, readinessScope: privateScope } : committed);
    const previous = this.options.store.read(input.commandId);
    if (previous) {
      if (previous.kind !== 'model.probe' || previous.fingerprint !== fingerprint)
        throw new ManagementCommandError('conflict');
      assertManagementTarget(previous, target);
      return this.snapshot(previous);
    }
    if (prepared && Date.now() >= prepared.anchor.expiresAt) throw new ManagementCommandError('held');
    this.options.fence.reserve(target.resourceId, input.commandId);
    let entry: ActiveProbe;
    try {
      const native = this.options.prepare(input, isCurrent, purpose, prepared?.origin);
      if (
        !Number.isSafeInteger(native.timeoutMs) ||
        native.timeoutMs < 1 ||
        native.timeoutMs > (purpose ? 90000 : 180000)
      )
        throw new ManagementCommandError('invalid');
      const saved: StoredModelProbe = {
        schemaVersion: 1,
        ...target,
        kind: 'model.probe',
        ...(purpose ? { purpose } : {}),
        ...(prepared ? { localModelReadinessPreparation: structuredClone(prepared.anchor) } : {}),
        ...(prepared?.origin ? { localModelReadinessOrigin: structuredClone(prepared.origin) } : {}),
        ...(privateScope ? { readinessScope: privateScope } : {}),
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
        expiresAt: prepared?.origin || privateScope
          ? Math.min(admittedAt + native.timeoutMs, prepared?.anchor.expiresAt ?? Infinity,
            privateScope?.cutoff ?? Infinity)
          : (purpose ? admittedAt : Date.now()) + native.timeoutMs,
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
    }, purpose || privateScope ? Math.max(0, entry.saved.expiresAt - Date.now()) : entry.native.timeoutMs);
    entry.timer.unref();
    entry.running = this.run(entry);
    void entry.running;
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
    if (!this.originCurrent(saved)) throw new ManagementCommandError('held');
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
  readContextual(commandId: string, context: string): ProviderModelProbeSnapshot | null {
    this.assertAdmission();
    const saved = this.options.store.read(id.parse(commandId));
    if (!saved) return null;
    if (saved.kind !== 'model.probe' || saved.context !== context)
      throw new ManagementCommandError('conflict');
    return this.snapshot(saved);
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
      ok: current.phase === 'completed' && current.ok && !current.readinessRetired,
      expiresAt: current.expiresAt,
    };
  }

  private originCurrent(saved: StoredModelProbe): boolean {
    if (!saved.localModelReadinessOrigin) return true;
    try { return this.options.readinessOriginCurrent?.(saved.localModelReadinessOrigin, saved) === true; }
    catch { return false; }
  }

  private assertAdmission(): void {
    this.options.assertWriter();
    if (this.sealed) throw new ManagementCommandError('held');
  }

  private async run(entry: ActiveProbe): Promise<void> {
    try {
      this.assertAdmission();
      if (!entry.isCurrent() || (entry.saved.purpose || entry.saved.readinessScope) && Date.now() >= entry.saved.expiresAt) {
        await this.finish(entry, 'cancelled', false);
        return;
      }
      assertManagementTarget(
        entry.saved,
        this.options.select(entry.saved.profileId, entry.saved.configRevision)
      );
      const ok = await entry.native.run(entry.abort.signal,
        entry.saved.purpose || entry.saved.readinessScope ? entry.saved.expiresAt : undefined);
      if (!entry.retired && entry.saved.purpose === nativeLocalReadinessPurpose) {
        const evidence = nativeLocalReadinessEvidenceSchema.parse(entry.native.readiness?.());
        if (ok !== (evidence.decision === 'allow')) throw new ManagementCommandError('held');
        entry.readiness = evidence;
      }
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
        clean = await entry.native.close(entry.saved.purpose || entry.saved.readinessScope ? entry.saved.expiresAt : undefined);
      } catch {
        /* Unknown custody remains held. */
      }
      if (phase === 'completed' && (!entry.isCurrent() || !this.originCurrent(entry.saved) ||
          (entry.saved.purpose || entry.saved.readinessScope) && Date.now() >= entry.saved.expiresAt)) {
        phase = 'cancelled';
        ok = false;
      }
      let nativeFileKeyWitness: string | undefined;
      if (clean && phase === 'completed' && ok && entry.saved.context &&
          (entry.saved.purpose === nativeLocalReadinessPurpose && entry.readiness?.ordinary === 'confirmed' &&
            entry.readiness.decision === 'allow' ||
            entry.saved.purpose === undefined && entry.saved.readinessScope?.kind === 'native')) {
        try {
          const proof = entry.native.nativeFileKeyWitness?.();
          if (proof !== undefined) {
            if (!AcceptedOpenCodeV2FileKey.selected(proof, entry.saved.providerId, entry.saved.modelId) ||
                !proof.filesCurrent()) throw new ManagementCommandError('held');
            nativeFileKeyWitness = openCodeV2NativeFileWitnessSchema.parse(proof.encoded);
          }
        } catch { phase = 'held'; ok = false; }
      }
      entry.saved = {
        ...entry.saved,
        phase: clean ? phase : 'held',
        resourceHeld: !clean,
        ok: clean && phase === 'completed' && ok,
        ...(nativeFileKeyWitness === undefined ? {} : { nativeFileKeyWitness }),
        ...(clean && phase === 'completed' && entry.readiness ? { readiness: {
          context: entry.saved.context!, selectionDigest: entry.saved.selectionDigest,
          evidence: entry.readiness,
        } } : {}),
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
