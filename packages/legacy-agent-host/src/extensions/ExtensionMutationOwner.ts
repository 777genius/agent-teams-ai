import { z } from 'zod';

import { assertManagementTarget, ManagementCommandError } from '../management/commandRecords.js';
import { managementDigest } from '../management/identity.js';
import { ManagementResourceFence } from '../management/ManagementResourceFence.js';
import { nativeExtensionCommandSchema } from './nativeCommands.js';

import type { ManagementCommandStore, ManagementTarget } from '../management/commandRecords.js';
import type { ExtensionMutationReceipt, StoredExtensionCommand } from './extensionRecords.js';
import type { NativeExtensionCommand } from './nativeCommands.js';

const id = z.string().min(1).max(256);
const selection = {
  profileId: id,
  configRevision: id,
  targetId: z.string().regex(/^[a-f0-9]{64}$/u),
  panel: z.enum(['plugins', 'mcp']),
  scope: z.enum(['user', 'global', 'project', 'local']),
};
const matchingSelection = (input: {
  panel: string;
  scope: string;
  command: NativeExtensionCommand;
}) =>
  input.command.action.startsWith(input.panel === 'plugins' ? 'plugin.' : 'mcp.') &&
  input.command.scope === input.scope;
export const extensionMutationSchema = z
  .object({ ...selection, commandId: id, command: nativeExtensionCommandSchema })
  .strict()
  .refine(matchingSelection);
type Input = z.infer<typeof extensionMutationSchema>;

/** Finite extension commands use the original management journal/fence; lookup never dispatches. */
export class ExtensionMutationOwner {
  private readonly fence: ManagementResourceFence;
  constructor(
    private readonly options: {
      readonly store: ManagementCommandStore;
      readonly fence?: ManagementResourceFence;
      assertCurrent(): void;
      select(
        input: Pick<Input, 'profileId' | 'configRevision' | 'targetId' | 'panel' | 'scope'>
      ): ManagementTarget;
      perform(
        command: NativeExtensionCommand,
        targetId: string,
        assertOriginal: () => void,
        original: Pick<Input, 'profileId' | 'configRevision' | 'targetId' | 'panel' | 'scope'>
      ): Promise<{ ok: boolean; settled: boolean; completed?: boolean }>;
    }
  ) {
    this.fence = options.fence ?? new ManagementResourceFence(options.store.list());
  }

  lookup(raw: unknown): ExtensionMutationReceipt | null {
    const input = z
      .object({ ...selection, commandId: id })
      .strict()
      .parse(raw);
    this.options.assertCurrent();
    const target = this.options.select(input);
    const saved = this.options.store.read(input.commandId);
    if (!saved) return null;
    if (
      saved.kind !== 'extension.mutation' ||
      saved.targetId !== input.targetId ||
      saved.scope !== input.scope ||
      !saved.action.startsWith(input.panel === 'plugins' ? 'plugin.' : 'mcp.')
    )
      throw new ManagementCommandError('conflict');
    assertManagementTarget(saved, target);
    return this.receipt(saved);
  }

  /** Find only an original unresolved intent after app/Host restart, without a replacement command. */
  pending(raw: unknown): ExtensionMutationReceipt | null {
    const input = z
      .object({ ...selection, command: nativeExtensionCommandSchema })
      .strict()
      .refine(matchingSelection)
      .parse(raw);
    this.options.assertCurrent();
    const target = this.options.select(input);
    const digest = managementDigest({
      targetId: input.targetId,
      panel: input.panel,
      scope: input.scope,
      command: input.command,
    });
    const matches = [...this.options.store.list()].filter(
      (row): row is StoredExtensionCommand =>
        row.kind === 'extension.mutation' &&
        row.targetId === input.targetId &&
        row.intentDigest === digest &&
        (row.phase === 'claimed' || row.phase === 'held')
    );
    if (!matches.length) return null;
    if (matches.length !== 1) throw new ManagementCommandError('held');
    const original = matches[0]!;
    assertManagementTarget(original, target);
    return this.receipt(original);
  }

  async execute(raw: unknown): Promise<ExtensionMutationReceipt> {
    const input = extensionMutationSchema.parse(raw);
    this.options.assertCurrent();
    const target = this.options.select(input),
      fingerprint = managementDigest(input);
    const previous = this.options.store.read(input.commandId);
    if (previous) {
      if (
        previous.kind !== 'extension.mutation' ||
        previous.targetId !== input.targetId ||
        previous.fingerprint !== fingerprint
      )
        throw new ManagementCommandError('conflict');
      assertManagementTarget(previous, target);
      return this.receipt(previous);
    }
    const pending = this.pending({
      profileId: input.profileId,
      configRevision: input.configRevision,
      targetId: input.targetId,
      panel: input.panel,
      scope: input.scope,
      command: input.command,
    });
    if (pending) return pending;
    if (
      [...this.options.store.list()].some(
        (row) =>
          row.kind === 'extension.mutation' &&
          row.resourceId === target.resourceId &&
          (row.phase === 'claimed' || row.phase === 'held')
      )
    )
      throw new ManagementCommandError('held');
    this.fence.reserve(target.resourceId, input.commandId);
    const saved: StoredExtensionCommand = {
      schemaVersion: 1,
      commandId: input.commandId,
      profileId: target.profileId,
      configRevision: target.configRevision,
      providerId: 'anthropic',
      selectionDigest: target.selectionDigest,
      resourceId: target.resourceId,
      fingerprint,
      targetId: input.targetId,
      intentDigest: managementDigest({
        targetId: input.targetId,
        panel: input.panel,
        scope: input.scope,
        command: input.command,
      }),
      kind: 'extension.mutation',
      action: input.command.action,
      scope: input.command.scope,
      phase: 'claimed',
      resourceHeld: true,
    };
    try {
      this.options.store.write(saved);
    } catch (error) {
      this.fence.release(target.resourceId, input.commandId, true);
      throw error;
    }
    const assertOriginal = () => {
      this.options.assertCurrent();
      assertManagementTarget(saved, this.options.select(input));
    };
    let settled = false;
    try {
      assertOriginal();
      const result = await this.options.perform(input.command, input.targetId, assertOriginal, {
        profileId: input.profileId,
        configRevision: input.configRevision,
        targetId: input.targetId,
        panel: input.panel,
        scope: input.scope,
      });
      settled = result.settled;
      assertOriginal();
      saved.phase =
        result.ok && settled ? 'completed' : result.completed && settled ? 'failed' : 'held';
      saved.resourceHeld = !settled;
      saved.finishedAtMs = Date.now();
      this.options.store.write(saved);
      return this.receipt(saved);
    } catch {
      saved.phase = 'held';
      saved.resourceHeld = !settled;
      try {
        assertOriginal();
        this.options.store.write(saved);
      } catch {
        settled = false;
      }
      return this.receipt(saved);
    } finally {
      this.fence.release(target.resourceId, input.commandId, settled);
    }
  }

  private receipt(saved: StoredExtensionCommand): ExtensionMutationReceipt {
    return {
      commandId: saved.commandId,
      profileId: saved.profileId,
      configRevision: saved.configRevision,
      targetId: saved.targetId,
      action: saved.action,
      scope: saved.scope,
      phase:
        saved.phase === 'completed' ? 'completed' : saved.phase === 'failed' ? 'failed' : 'held',
    };
  }
}
