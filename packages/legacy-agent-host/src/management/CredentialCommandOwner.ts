import { z } from 'zod';

import { assertManagementTarget, ManagementCommandError } from './commandRecords.js';
import { managementDigest } from './identity.js';
import { ManagementResourceFence } from './ManagementResourceFence.js';

import type { ProviderCredentialReceipt } from './contracts.js';
import type {
  ManagementCommandStore,
  ManagementTarget,
  StoredCredentialCommand,
} from './commandRecords.js';

const id = z.string().min(1).max(256);
const common = { commandId: id, profileId: id, configRevision: id, providerId: id };
export const credentialCommandSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...common,
      kind: z.literal('credential.set'),
      key: z
        .string()
        .min(1)
        .max(64 * 1024),
      metadata: z.record(id, z.string().max(8192)).optional(),
    })
    .strict(),
  z.object({ ...common, kind: z.literal('credential.forget') }).strict(),
  z.object({
    ...common,
    kind: z.literal('credential.refresh'),
    // Consumer-owned reuse policy; the Host applies it to the actual credential namespace.
    reuseWindowMs: z.number().int().min(0).max(300_000).optional(),
  }).strict(),
]);
export type CredentialCommand = z.infer<typeof credentialCommandSchema>;

export type CredentialCommandReceipt = ProviderCredentialReceipt;
export type CredentialCommandStore = ManagementCommandStore;
export type CredentialTarget = ManagementTarget;

/** Durable management intents. Secrets are hashed for matching, never persisted in the journal. */
export class CredentialCommandOwner {
  private readonly fence: ManagementResourceFence;

  constructor(
    private readonly options: {
      store: CredentialCommandStore;
      assertCurrent(): void;
      select(profileId: string, configRevision: string): CredentialTarget;
      perform(
        command: CredentialCommand,
        target: CredentialTarget
      ): Promise<{ ok: boolean; settled: boolean }>;
      fence?: ManagementResourceFence;
      validate?(command: CredentialCommand): void;
    }
  ) {
    this.fence = options.fence ?? new ManagementResourceFence(options.store.list());
  }

  lookup(raw: unknown): CredentialCommandReceipt | null {
    const input = z
      .object({ commandId: id, profileId: id, configRevision: id })
      .strict()
      .parse(raw);
    this.options.assertCurrent();
    const target = this.options.select(input.profileId, input.configRevision);
    const saved = this.options.store.read(input.commandId);
    if (!saved) return null;
    if (
      saved.kind !== 'credential.set' &&
      saved.kind !== 'credential.forget' &&
      saved.kind !== 'credential.refresh'
    )
      throw new ManagementCommandError('conflict');
    assertManagementTarget(saved, target);
    return this.receipt(saved);
  }

  async execute(raw: unknown): Promise<CredentialCommandReceipt> {
    const command = credentialCommandSchema.parse(raw);
    this.options.assertCurrent();
    const target = this.options.select(command.profileId, command.configRevision);
    this.options.validate?.(command);
    const fingerprint = managementDigest(command);
    const previous = this.options.store.read(command.commandId);
    if (previous) {
      if (
        previous.kind !== 'credential.set' &&
        previous.kind !== 'credential.forget' &&
        previous.kind !== 'credential.refresh'
      )
        throw new ManagementCommandError('conflict');
      assertManagementTarget(previous, target);
      if (previous.fingerprint !== fingerprint) throw new ManagementCommandError('conflict');
      return this.receipt(previous);
    }
    this.fence.reserve(target.resourceId, command.commandId);
    const saved: StoredCredentialCommand = {
      schemaVersion: 1,
      commandId: command.commandId,
      profileId: target.profileId,
      configRevision: target.configRevision,
      kind: command.kind,
      providerId: command.providerId,
      selectionDigest: target.selectionDigest,
      resourceId: target.resourceId,
      fingerprint,
      phase: 'claimed',
      resourceHeld: true,
    };
    try {
      this.options.store.write(saved);
    } catch (error) {
      // Durable before any native effect.
      this.fence.release(target.resourceId, command.commandId, true);
      throw error;
    }
    let settled = false;
    try {
      this.options.assertCurrent();
      assertManagementTarget(saved, this.options.select(command.profileId, command.configRevision));
      const reused = this.reusableRefresh(command, target);
      const result = reused
        ? { ok: true, settled: true }
        : await this.options.perform(command, target);
      settled = result.settled;
      this.options.assertCurrent();
      assertManagementTarget(saved, this.options.select(command.profileId, command.configRevision));
      saved.phase = result.ok && settled ? 'completed' : 'held';
      saved.resourceHeld = !settled;
      const completedAt = Date.now();
      saved.finishedAtMs = this.finishTime(target.resourceId);
      if (saved.phase === 'completed' && command.kind === 'credential.refresh')
        saved.refreshCompletedAtMs = reused?.refreshCompletedAtMs ?? completedAt;
      this.options.store.write(saved);
      return this.receipt(saved);
    } catch {
      // A lost response/publication is UNKNOWN. Never replay the mutation under a new process.
      saved.phase = 'held';
      delete saved.refreshCompletedAtMs;
      saved.resourceHeld = !settled;
      try {
        this.options.assertCurrent();
        this.options.store.write(saved);
      } catch {
        settled = false;
      }
      return this.receipt(saved);
    } finally {
      this.fence.release(target.resourceId, command.commandId, settled);
    }
  }

  /** Reuse never extends the original rotation window or crosses credential namespaces. */
  private reusableRefresh(
    command: CredentialCommand,
    target: CredentialTarget
  ): StoredCredentialCommand | undefined {
    if (command.kind !== 'credential.refresh' || !command.reuseWindowMs) return undefined;
    let latest: StoredCredentialCommand | undefined;
    for (const row of this.options.store.list()) {
      if (row.resourceId !== target.resourceId || row.commandId === command.commandId) continue;
      // Older/uncertain records cannot prove the current credential generation.
      if (!row.kind.startsWith('credential.') || !('finishedAtMs' in row) || !row.finishedAtMs)
        return undefined;
      if (!latest || row.finishedAtMs > latest.finishedAtMs!)
        latest = row as StoredCredentialCommand;
    }
    const completedAt = latest?.refreshCompletedAtMs;
    const elapsed = completedAt === undefined ? -1 : Date.now() - completedAt;
    // Wall-clock rollback must not immediately rotate a token again. Match the
    // consumer's existing conservative reuse policy until time catches up.
    return latest?.kind === 'credential.refresh' && latest.phase === 'completed' &&
      completedAt !== undefined && elapsed <= command.reuseWindowMs ? latest : undefined;
  }

  private finishTime(resourceId: string): number {
    let time = Date.now();
    for (const row of this.options.store.list())
      if (row.resourceId === resourceId && 'finishedAtMs' in row && row.finishedAtMs !== undefined)
        time = Math.max(time, row.finishedAtMs + 1);
    return time;
  }

  private receipt(saved: StoredCredentialCommand): CredentialCommandReceipt {
    return {
      commandId: saved.commandId,
      profileId: saved.profileId,
      configRevision: saved.configRevision,
      kind: saved.kind,
      providerId: saved.providerId,
      phase: saved.phase === 'completed' ? 'completed' : 'held',
    };
  }
}
