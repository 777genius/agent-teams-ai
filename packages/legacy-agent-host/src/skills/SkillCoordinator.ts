import { isUtf8 } from 'node:buffer';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { captureSkillRoots } from './CapturedSkillRoots.js';
import { assertManagementTarget, ManagementCommandError } from '../management/commandRecords.js';
import { SkillFilesystem } from './SkillFilesystem.js';
import {
  assertSkillTransportBudget,
  planSkillFiles,
  skillDigest,
  skillFolder,
  SKILL_NAMES,
  validateSkillBundle,
} from './skillPolicy.js';
import { skillCommandSchema, skillMutationSchema, skillSelection } from './skillRecords.js';

import type { ManagementCommandStore, ManagementTarget } from '../management/commandRecords.js';
import type { ManagementResourceFence } from '../management/ManagementResourceFence.js';
import type { ProviderManagementProfile } from '../management/profile.js';
import type { SkillCommand, SkillReceipt, StoredSkillCommand } from './skillRecords.js';

type Selection = z.infer<z.ZodObject<typeof skillSelection>>;
const selected = z.object(skillSelection).strict();
const selectionOf = (input: Selection): Selection => ({
  profileId: input.profileId,
  configRevision: input.configRevision,
  targetId: input.targetId,
  scope: input.scope,
  rootKind: input.rootKind,
});
const intent = (input: Selection, command: SkillCommand) => skillDigest({ ...input, command });

/** Finite Skills filesystem ownership; same captured management journal/fence as auth/extensions. */
export class SkillCoordinator {
  private readonly profiles: Map<string, ProviderManagementProfile>;
  private readonly targets = new Map<
    string,
    { selection: Selection; roots: ReturnType<typeof captureSkillRoots> }
  >();
  constructor(
    profiles: readonly ProviderManagementProfile[],
    private readonly options: {
      store: ManagementCommandStore;
      fence: ManagementResourceFence;
      assertCurrent(): void;
      managementTarget(profileId: string, configRevision: string): ManagementTarget;
      /** Test seam at the real post-admission boundary, never a filesystem implementation substitute. */
      beforeEffect?(): Promise<void>;
    }
  ) {
    this.profiles = new Map(
      structuredClone(profiles).map((profile) => [profile.profileId, profile])
    );
  }
  private profile(profileId: string, configRevision: string): ProviderManagementProfile {
    this.options.assertCurrent();
    const profile = this.profiles.get(profileId);
    if (!profile || profile.configRevision !== configRevision)
      throw new ManagementCommandError('conflict');
    this.options.managementTarget(profileId, configRevision);
    return profile;
  }
  capture(raw: unknown) {
    const { targetId: _, ...fields } = skillSelection;
    const input = z.object(fields).strict().parse(raw);
    const profile = this.profile(input.profileId, input.configRevision);
    const roots = captureSkillRoots(
      profile,
      { scope: input.scope, rootKind: input.rootKind },
      () => {
        this.profile(input.profileId, input.configRevision);
      }
    );
    if (!this.targets.has(roots.targetId))
      this.targets.set(roots.targetId, {
        selection: { ...input, targetId: roots.targetId },
        roots,
      });
    return {
      ...input,
      targetId: roots.targetId,
      rootPath: roots.rootPath,
      projectRoot: roots.projectRoot,
    };
  }
  private resolve(input: Selection) {
    this.profile(input.profileId, input.configRevision);
    const captured = this.targets.get(input.targetId);
    if (!captured || skillDigest(captured.selection) !== skillDigest(selectionOf(input)))
      throw new ManagementCommandError('conflict');
    const roots = captured.roots;
    roots.assertCurrent();
    const native = this.options.managementTarget(input.profileId, input.configRevision);
    const target = {
      ...native,
      selectionDigest: skillDigest({ native: native.selectionDigest, skills: roots.targetId }),
    };
    return {
      roots,
      target,
      fs: new SkillFilesystem(roots, (bytes) => bytes.includes(0) || !isUtf8(bytes)),
    };
  }
  read(raw: unknown) {
    const input = selected.parse(raw),
      original = this.resolve(input);
    const items = [];
    let names: string[];
    try {
      original.roots.assertCurrent();
      names = readdirSync(original.roots.rootPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      names = [];
    }
    for (const folderName of names.sort()) {
      const path = join(original.roots.rootPath, folderName),
        stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new ManagementCommandError('held');
      if (!stat.isDirectory()) continue;
      const hasSkill = SKILL_NAMES.some((name) => {
        const file = join(path, name);
        original.roots.assertDescendant(file);
        try {
          return lstatSync(file).isFile();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return false;
        }
      });
      if (!hasSkill) continue;
      const tree = original.fs.snapshot(folderName),
        skill = SKILL_NAMES.map((name) =>
          tree.files.find((file) => file.relativePath === name)
        ).find(Boolean);
      if (!skill) continue;
      const flags = Object.fromEntries(
        ['scripts', 'references', 'assets'].map((name) => {
          const directory = join(path, name);
          original.roots.assertDescendant(directory);
          try {
            return [name, lstatSync(directory).isDirectory()];
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            return [name, false];
          }
        })
      );
      items.push({
        folderName,
        identity: tree.identity,
        flags,
        rawContent: Buffer.from(skill.base64, 'base64').toString('utf8'),
        skillFileName: skill.relativePath,
        modifiedAt: lstatSync(join(path, skill.relativePath)).mtimeMs,
        relatedFiles: tree.files.map((file) => file.relativePath),
      });
    }
    original.roots.assertCurrent();
    const result = {
      ...input,
      rootPath: original.roots.rootPath,
      projectRoot: original.roots.projectRoot,
      items,
    };
    assertSkillTransportBudget(result);
    return result;
  }
  private plan(input: Selection, command: SkillCommand) {
    if (command.action === 'trash') throw new ManagementCommandError('invalid');
    const original = this.resolve(input),
      current = original.fs.snapshot(command.folderName);
    if (command.action === 'import') validateSkillBundle(command.bundle);
    const desired =
      command.action === 'import'
        ? command.bundle.files
        : command.files.map((file) => ({
            relativePath: file.relativePath,
            base64: Buffer.from(file.content).toString('base64'),
            isBinary: false,
          }));
    const plan = planSkillFiles({
      targetSkillDir: original.fs.target(command.folderName),
      targetIdentity: current.identity,
      current: current.files,
      desired,
      mode: command.action,
      ...(command.action === 'import'
        ? {
            sourceBinding: command.bundle.binding,
            hiddenEntriesSkipped: command.bundle.hiddenEntriesSkipped,
          }
        : {}),
    });
    original.roots.assertCurrent();
    assertSkillTransportBudget(plan.preview);
    return { ...original, current, plan };
  }
  preview(raw: unknown) {
    assertSkillTransportBudget(raw);
    const input = z
      .object({ ...skillSelection, command: skillCommandSchema })
      .strict()
      .parse(raw);
    if (input.command.action === 'trash') {
      const original = this.resolve(input),
        tree = original.fs.snapshot(input.command.folderName);
      if (!tree.files.length) throw new ManagementCommandError('invalid');
      if (input.command.expectedIdentity !== tree.identity)
        throw new Error('Original selected skill changed');
      return {
        planId: skillDigest({
          targetId: input.targetId,
          command: input.command,
          identity: tree.identity,
        }),
        targetSkillDir: original.fs.target(input.command.folderName),
        changes: [],
        warnings: [],
        summary: { created: 0, updated: 0, deleted: 0, binary: 0 },
      };
    }
    return this.plan(input, input.command).plan.preview;
  }
  lookup(raw: unknown): SkillReceipt | null {
    const input = z
      .object({ ...skillSelection, commandId: z.string().min(1).max(256) })
      .strict()
      .parse(raw);
    this.profile(input.profileId, input.configRevision);
    const native = this.options.managementTarget(input.profileId, input.configRevision);
    const target = {
      ...native,
      selectionDigest: skillDigest({ native: native.selectionDigest, skills: input.targetId }),
    };
    const saved = this.options.store.read(input.commandId);
    if (!saved) return null;
    if (saved.kind !== 'skill.mutation' || saved.targetId !== input.targetId)
      throw new ManagementCommandError('conflict');
    if (saved.scope !== input.scope || saved.rootKind !== input.rootKind)
      throw new ManagementCommandError('conflict');
    assertManagementTarget(saved, target);
    return this.receipt(saved);
  }
  pending(raw: unknown): SkillReceipt | null {
    assertSkillTransportBudget(raw);
    const input = z
      .object({ ...skillSelection, command: skillCommandSchema })
      .strict()
      .parse(raw);
    const original = this.resolve(input),
      digest = intent(selectionOf(input), input.command);
    const matches = [...this.options.store.list()].filter(
      (row): row is StoredSkillCommand =>
        row.kind === 'skill.mutation' && row.intentDigest === digest && row.phase !== 'completed'
    );
    if (!matches.length) return null;
    if (matches.length !== 1) throw new ManagementCommandError('held');
    const saved = matches[0]!;
    assertManagementTarget(saved, original.target);
    return this.receipt(saved);
  }
  async mutate(raw: unknown) {
    assertSkillTransportBudget(raw);
    const input = skillMutationSchema.parse(raw),
      selection = selectionOf(input);
    const original = this.resolve(selection),
      command = input.command;
    skillFolder(command.folderName);
    const fingerprint = skillDigest(input),
      previous = this.options.store.read(input.commandId);
    if (previous) {
      if (previous.kind !== 'skill.mutation' || previous.fingerprint !== fingerprint)
        throw new ManagementCommandError('conflict');
      assertManagementTarget(previous, original.target);
      return { receipt: this.receipt(previous) };
    }
    const pending = this.pending({ ...selection, command });
    if (pending) return { receipt: pending };
    // Review mismatch is rejected before admission or any mkdir/write.
    const plan = command.action === 'trash' ? undefined : this.plan(selection, command);
    if (plan && input.reviewPlanId !== plan.plan.preview.planId)
      throw new Error(
        'The skill files changed after review. Review the latest changes and try again.'
      );
    const tree = plan?.current ?? original.fs.snapshot(command.folderName);
    if (command.action === 'trash' && command.expectedIdentity !== tree.identity)
      throw new Error('Original selected skill changed');
    if (
      command.action === 'trash' &&
      input.reviewPlanId !==
        skillDigest({ targetId: input.targetId, command, identity: tree.identity })
    )
      throw new Error('Original skill changed before Trash');
    const saved: StoredSkillCommand = {
      schemaVersion: 1,
      ...original.target,
      commandId: input.commandId,
      providerId: this.profile(input.profileId, input.configRevision).provider,
      fingerprint,
      kind: 'skill.mutation',
      targetId: selection.targetId,
      intentDigest: intent(selection, command),
      action: command.action,
      scope: selection.scope,
      rootKind: selection.rootKind,
      phase: 'claimed',
      resourceHeld: true,
    };
    this.options.fence.reserve(saved.resourceId, saved.commandId);
    try {
      this.options.store.write(saved);
    } catch (error) {
      this.options.fence.release(saved.resourceId, saved.commandId, true);
      throw error;
    }
    const assertOriginal = () => {
      this.options.assertCurrent();
      assertManagementTarget(saved, this.resolve(selection).target);
      original.roots.assertCurrent();
    };
    let settled = false,
      awaitingNativeTrash = false;
    try {
      await this.options.beforeEffect?.();
      assertOriginal();
      if (command.action === 'trash') {
        saved.trash = original.fs.stageTrash(
          saved.commandId,
          command.folderName,
          tree,
          assertOriginal
        );
        assertOriginal();
        this.options.store.write(saved);
        // This private response is consumed only by original Main. Lookup/replay never reissues it.
        awaitingNativeTrash = true;
        return { receipt: this.receipt(saved), nativeTrash: saved.trash };
      }
      original.fs.apply(
        saved.commandId,
        command.folderName,
        tree,
        plan!.plan.files,
        assertOriginal
      );
      assertOriginal();
      saved.phase = 'completed';
      saved.resourceHeld = false;
      this.options.store.write(saved);
      settled = true;
      return { receipt: this.receipt(saved) };
    } catch {
      saved.phase = 'held';
      saved.resourceHeld = true;
      try {
        assertOriginal();
        this.options.store.write(saved);
      } catch {
        /* Original claim remains UNKNOWN. */
      }
      return { receipt: this.receipt(saved) };
    } finally {
      if (!awaitingNativeTrash)
        this.options.fence.release(saved.resourceId, saved.commandId, settled);
    }
  }
  finishTrash(raw: unknown): SkillReceipt {
    const input = z
      .object({
        ...skillSelection,
        commandId: z.string().min(1).max(256),
        token: z.string().regex(/^[a-f0-9]{64}$/u),
        nativeCompleted: z.boolean(),
      })
      .strict()
      .parse(raw);
    const original = this.resolve(input),
      saved = this.options.store.read(input.commandId);
    if (
      !saved ||
      saved.kind !== 'skill.mutation' ||
      saved.action !== 'trash' ||
      saved.targetId !== input.targetId ||
      saved.trash?.token !== input.token
    )
      throw new ManagementCommandError('conflict');
    assertManagementTarget(saved, original.target);
    if (saved.phase === 'completed') return this.receipt(saved);
    // Absence is necessary, never sufficient. Only the original Main native completion can settle.
    let absent = false;
    try {
      original.roots.assertDescendant(saved.trash.path);
      lstatSync(saved.trash.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      absent = true;
    }
    this.options.assertCurrent();
    saved.phase = input.nativeCompleted && absent ? 'completed' : 'held';
    saved.resourceHeld = saved.phase !== 'completed';
    this.options.store.write(saved);
    this.options.fence.release(saved.resourceId, saved.commandId, saved.phase === 'completed');
    return this.receipt(saved);
  }
  private receipt(saved: StoredSkillCommand): SkillReceipt {
    return {
      commandId: saved.commandId,
      profileId: saved.profileId,
      configRevision: saved.configRevision,
      targetId: saved.targetId,
      scope: saved.scope,
      rootKind: saved.rootKind,
      action: saved.action,
      phase: saved.phase === 'completed' ? 'completed' : 'held',
    };
  }
}
