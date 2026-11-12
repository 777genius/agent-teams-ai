import { z } from 'zod';

import { assertManagementTarget, ManagementCommandError } from './commandRecords.js';
import { managementDigest } from './identity.js';
import { ManagementResourceFence } from './ManagementResourceFence.js';
import { advanceOpenCodeV2Credential } from './openCodeV2CredentialRecord.js';
import type { OpenCodeV2CredentialProgress } from './openCodeV2CredentialRecord.js';

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
export type CredentialProgressWriter = (value: OpenCodeV2CredentialProgress) => void;

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
        target: CredentialTarget,
        progress: CredentialProgressWriter,
      ): Promise<{ ok: boolean; settled: boolean; rejected?: boolean }>;
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

  /** Original unfinished set only; no credentials, replay, inferred completion or new journal. */
  pending(raw: unknown): CredentialCommandReceipt | null {
    const input = z.object({ profileId: id, configRevision: id, providerId: id }).strict().parse(raw);
    this.options.assertCurrent();
    const target = this.options.select(input.profileId, input.configRevision);
    const matches: StoredCredentialCommand[] = [];
    for (const row of this.options.store.list()) {
      if (row.kind !== 'credential.set' || row.profileId !== target.profileId ||
          row.configRevision !== target.configRevision || row.providerId !== input.providerId ||
          row.phase === 'completed' || row.terminalRejection === true) continue;
      assertManagementTarget(row, target);
      matches.push(row);
    }
    if (matches.length > 1) throw new ManagementCommandError('conflict');
    return matches[0] ? this.receipt(matches[0]) : null;
  }

  /** Retained control may compare the original secret fingerprint, but can never claim or mutate. */
  resume(raw: unknown): CredentialCommandReceipt {
    const command = credentialCommandSchema.parse(raw);
    this.options.assertCurrent();
    const target = this.options.select(command.profileId, command.configRevision);
    const original = this.options.store.read(command.commandId);
    if (!original || original.kind !== command.kind || original.providerId !== command.providerId ||
        original.fingerprint !== managementDigest(command)) throw new ManagementCommandError('conflict');
    assertManagementTarget(original, target);
    return this.receipt(original);
  }

  async execute(raw: unknown): Promise<CredentialCommandReceipt> {
    const command = credentialCommandSchema.parse(raw);
    this.options.assertCurrent();
    const target = this.options.select(command.profileId, command.configRevision);
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
    this.options.validate?.(command);
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
        : await this.options.perform(command, target, (progress) => {
          this.options.assertCurrent();
          assertManagementTarget(saved, this.options.select(command.profileId, command.configRevision));
          const next = advanceOpenCodeV2Credential(saved.openCodeV2, progress);
          if (command.kind !== 'credential.set' || !next) throw new ManagementCommandError('conflict');
          saved.openCodeV2 = next;
          this.options.store.write(saved);
        });
      settled = result.settled;
      this.options.assertCurrent();
      assertManagementTarget(saved, this.options.select(command.profileId, command.configRevision));
      saved.phase = result.ok && settled ? 'completed' : 'held';
      saved.resourceHeld = !settled;
      const completedAt = Date.now();
      saved.finishedAtMs = this.finishTime(target.resourceId);
      if (!result.ok && settled && 'rejected' in result && result.rejected === true)
        saved.terminalRejection = true;
      if (saved.phase === 'completed' && command.kind === 'credential.refresh')
        saved.refreshCompletedAtMs = reused?.refreshCompletedAtMs ?? completedAt;
      this.options.store.write(saved);
      return this.receipt(saved);
    } catch {
      // A lost response/publication is UNKNOWN. Never replay the mutation under a new process.
      saved.phase = 'held';
      delete saved.refreshCompletedAtMs;
      delete saved.terminalRejection;
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
      ...(saved.terminalRejection && saved.openCodeV2?.phase === 'probe-completed' &&
        saved.openCodeV2.verification?.ok === false ? { reason: 'verification-rejected' as const } : {}),
    };
  }
}
