import { performance } from 'node:perf_hooks';
import { TeamOwnerError } from '../team/contracts.js';
import { digest } from '../team/identity.js';
import { HostProjectTeamRelations } from './HostProjectTeamRelations.js';
import { assertProjectDefinitionIdle } from './projectDefinitionPlan.js';
import { assertProjectReviewFlowIdle } from './HostProjectReviewFlow.js';
import { projectLifecycleFingerprint, projectLifecycleJournal } from './projectLifecyclePlan.js';
import type { ProjectLifecyclePlan, ProjectLifecycleTarget } from './projectLifecyclePlan.js';
import type { ProjectTeamTarget, ProjectTeamRelationsOptions } from './HostProjectTeamRelations.js';
import type { HostedTeam } from '../composition/MemberEntry.js';
import type { TeamStore } from '../team/ports.js';
import type { TeamLifecycleReceipt } from '../team/lifecycleContracts.js';
import type { createTeamBackupComposition } from '../composition/createTeamBackupComposition.js';
import type { createTeamLifecycleRetirement } from '../composition/createTeamLifecycleRetirement.js';

type Change = { expectedRevision: string; action: 'trash' | 'restore' };
type Action = Change['action'] | 'purge';
const value = (receipt: TeamLifecycleReceipt) => ({ kind: 'team_lifecycle' as const,
  commandId: receipt.commandId, revision: digest(receipt.after),
  deletedAt: receipt.after.deletedAt ?? null, cleanupPending: receipt.after.cleanupPending });

/** Original logical lifecycle intent captures every child before any tombstone or physical deletion. */
export class HostProjectTeamLifecycle {
  readonly relations: HostProjectTeamRelations;
  constructor(private readonly options: ProjectTeamRelationsOptions & {
    stores: ReadonlyMap<string, TeamStore>;
    storage: Pick<ReturnType<typeof createTeamBackupComposition>, 'changeLifecycle' | 'purge' | 'lookupPurge' | 'pendingPurge'>;
    retirement: Pick<ReturnType<typeof createTeamLifecycleRetirement>, 'lookup' | 'isRetired'>;
    afterTrash(team: HostedTeam, commandId: string): Promise<void>;
    preparePurge?(teamId: string, deadline: number): Promise<void>;
  }) { this.relations = new HostProjectTeamRelations(options); }

  private store(team: HostedTeam): TeamStore {
    const store = this.options.stores.get(team.definition.binding.teamId);
    if (!store || this.options.teams.get(team.definition.binding.teamId) !== team) throw new TeamOwnerError('hold');
    return store;
  }
  private original(target: ProjectTeamTarget, commandId: string, action?: Action, expectedRevision?: string) {
    this.relations.assertTarget(target);
    const plan = projectLifecycleJournal(this.store(target.team)).original(commandId);
    if (plan && (plan.ownerId !== this.options.profile.owner.ownerId || plan.ownerDigest !== digest(this.options.profile.owner) ||
      plan.principalId !== this.options.profile.principalId || plan.logicalTeamId !== target.team.definition.binding.teamId ||
      plan.logicalHandleId !== target.handleId)) throw new TeamOwnerError('forbidden');
    if (plan && ((action !== undefined && plan.action !== action) ||
      (expectedRevision !== undefined && plan.expectedRevision !== expectedRevision))) throw new TeamOwnerError('conflict');
    return plan;
  }
  private selected(plan: ProjectLifecyclePlan, row: ProjectLifecycleTarget, write: boolean): HostedTeam {
    this.options.assertCurrent();
    const team = this.options.teams.get(row.teamId);
    if (!team || team.definition.binding.teamName !== row.teamName || team.definition.binding.backendId !== plan.ownerId ||
      digest(team.definition.scope) !== digest(row.scope)) throw new TeamOwnerError('hold');
    team.owner.withLaunchAuthority(plan.principalId, write ? 'control' : 'read', revision => {
      this.options.assertCurrent();
      if (revision !== row.authorityRevision) throw new TeamOwnerError('forbidden');
    });
    return team;
  }
  private prepare(target: ProjectTeamTarget, commandId: string, action: Action, expectedRevision: string) {
    return this.store(target.team).fenced(() => {
      const existing = this.original(target, commandId, action, expectedRevision);
      if (existing) return existing;
      const family = this.relations.writable(target);
      if (family.kind === 'shared' && family.children.length === 0) return undefined;
      const journal = projectLifecycleJournal(this.store(target.team));
      if (journal.current()?.phase === 'prepared') throw new TeamOwnerError('hold');
      const targets = [...family.children, target].map((selected, index): ProjectLifecycleTarget =>
        selected.team.owner.withLaunchAuthority(this.options.profile.principalId, 'control', authorityRevision => {
          this.relations.assertTarget(selected);
          const store = this.store(selected.team);
          assertProjectDefinitionIdle(store); assertProjectReviewFlowIdle(store);
          const state = selected.team.owner.lifecycleCommands(this.options.profile.principalId).view();
          if (selected === target && state.revision !== expectedRevision) throw new TeamOwnerError('conflict');
          if (action === 'restore' && !state.deleted) throw new TeamOwnerError('invalid');
          if (action === 'purge' && (!state.deleted || state.cleanupPending)) throw new TeamOwnerError('hold');
          if (this.options.storage.pendingPurge(selected.team.definition.binding.teamId)) throw new TeamOwnerError('hold');
          return { teamId: selected.team.definition.binding.teamId, teamName: selected.team.definition.binding.teamName,
            handleId: selected.handleId, scope: structuredClone(selected.team.definition.scope), authorityRevision,
            expectedRevision: state.revision, commandId: index === family.children.length ? commandId
              : `lifecycle:${digest({ commandId, action, teamId: selected.team.definition.binding.teamId })}` };
        }));
      const intent = { schemaVersion: 1 as const, family: 'project-lifecycle' as const,
        ownerId: this.options.profile.owner.ownerId, ownerDigest: digest(this.options.profile.owner),
        principalId: this.options.profile.principalId, logicalTeamId: target.team.definition.binding.teamId,
        logicalHandleId: target.handleId, commandId, action, expectedRevision, targets };
      return journal.prepare({ ...intent, fingerprint: projectLifecycleFingerprint(intent), phase: 'prepared' });
    });
  }

  read(target: ProjectTeamTarget) {
    this.relations.assertTarget(target);
    const state = target.team.owner.lifecycleCommands(this.options.profile.principalId).view();
    const current = projectLifecycleJournal(this.store(target.team)).current();
    if (current) this.original(target, current.commandId);
    let cleanupPending = state.cleanupPending;
    if (current?.phase === 'prepared') {
      for (const row of current.targets) {
        if (row.teamId === current.logicalTeamId) continue;
        const child = this.options.teams.get(row.teamId);
        if (!child) { cleanupPending = true; continue; }
        const selected = this.selected(current, row, false);
        const childPending = selected.owner.lifecycleCommands(this.options.profile.principalId).view().cleanupPending;
        cleanupPending = childPending || cleanupPending;
      }
    } else {
      const family = this.relations.select(target);
      for (const child of family.children) {
        const childPending = child.team.owner.lifecycleCommands(this.options.profile.principalId).view().cleanupPending;
        cleanupPending = childPending || cleanupPending;
      }
    }
    const pending = current?.phase === 'prepared' ? current : undefined;
    const pendingPurge = pending?.action === 'purge'
      ? { commandId: pending.commandId, expectedRevision: pending.expectedRevision }
      : this.options.storage.pendingPurge(target.team.definition.binding.teamId);
    return { kind: 'team_lifecycle' as const, revision: state.revision, deletedAt: state.deletedAt, cleanupPending,
      ...(pending && pending.action !== 'purge' ? { pendingChange: {
        commandId: pending.commandId, expectedRevision: pending.expectedRevision, action: pending.action,
      } } : {}), ...(pendingPurge ? { pendingPurge } : {}) };
  }

  async change(target: ProjectTeamTarget, commandId: string, request: Change) {
    const plan = this.prepare(target, commandId, request.action, request.expectedRevision);
    if (!plan) {
      const receipt = await this.options.storage.changeLifecycle(target.team.definition.binding.teamId,
        { commandId, operation: request.action, expectedRevision: request.expectedRevision });
      if (receipt.operation === 'trash') {
        try { await this.options.afterTrash(target.team, commandId); } catch { /* Retain original cleanup debt. */ }
      }
      return value(receipt);
    }
    if (plan.phase !== 'completed') {
      for (const row of plan.targets) this.selected(plan, row, true);
      for (const row of plan.targets) {
        const team = this.selected(plan, row, true);
        const receipt = await this.options.storage.changeLifecycle(row.teamId, {
          commandId: row.commandId, operation: request.action, expectedRevision: row.expectedRevision });
        this.selected(plan, row, true);
        if (receipt.operation === 'trash') {
          try { await this.options.afterTrash(team, receipt.commandId); } catch { /* No false released-custody claim. */ }
        }
      }
      this.store(target.team).fenced(() => {
        this.selected(plan, plan.targets.at(-1)!, true);
        projectLifecycleJournal(this.store(target.team)).complete(plan);
      });
    }
    const receipt = target.team.owner.lifecycleCommands(this.options.profile.principalId).lookup(commandId,
      { operation: request.action, expectedRevision: request.expectedRevision });
    if (!receipt) throw new TeamOwnerError('hold');
    const current = this.read(target);
    return { ...value(receipt), cleanupPending: receipt.after.cleanupPending || current.cleanupPending };
  }

  lookup(target: ProjectTeamTarget, commandId: string, expected: Change) {
    const plan = this.original(target, commandId, expected.action, expected.expectedRevision);
    if (plan?.phase === 'prepared') return null;
    if (plan) this.selected(plan, plan.targets.at(-1)!, false);
    const receipt = target.team.owner.lifecycleCommands(this.options.profile.principalId).lookup(commandId,
      { operation: expected.action, expectedRevision: expected.expectedRevision });
    if (!receipt) return null;
    const current = this.read(target);
    return { ...value(receipt), cleanupPending: receipt.after.cleanupPending || current.cleanupPending };
  }

  private async purgeReceipt(plan: ProjectLifecyclePlan, row: ProjectLifecycleTarget) {
    const team = this.options.teams.get(row.teamId);
    if (team && !this.options.retirement.isRetired(team.definition)) {
      this.selected(plan, row, true);
      return await this.options.storage.lookupPurge(row.teamId, row.commandId, row.expectedRevision);
    }
    return await this.options.retirement.lookup({ owner: this.options.profile.owner, scope: row.scope },
      row.commandId, row.expectedRevision);
  }
  async purge(target: ProjectTeamTarget, commandId: string, expectedRevision: string) {
    const deadline = performance.now() + 10000;
    const plan = this.prepare(target, commandId, 'purge', expectedRevision);
    if (!plan) return await this.options.storage.purge(target.team.definition.binding.teamId, commandId, expectedRevision);
    // Prove every original native/process reference before physically removing the first project.
    for (const row of plan.targets) {
      const original = await this.purgeReceipt(plan, row);
      if (original?.phase === 'deleted') continue;
      this.selected(plan, row, true);
      await this.options.preparePurge?.(row.teamId, deadline);
      this.selected(plan, row, true);
    }
    let parent: Awaited<ReturnType<typeof this.options.storage.purge>> | undefined;
    for (const row of plan.targets) {
      this.options.assertCurrent();
      if (performance.now() >= deadline) throw new TeamOwnerError('hold');
      const original = await this.purgeReceipt(plan, row);
      if (original?.phase === 'deleted') continue;
      this.selected(plan, row, true);
      const receipt = await this.options.storage.purge(row.teamId, row.commandId, row.expectedRevision, deadline);
      this.options.assertCurrent();
      if (row.teamId === plan.logicalTeamId) parent = receipt;
    }
    // The parent store is deleted last. Its original deletion receipt is the final aggregate ACK.
    if (!parent) {
      const original = await this.purgeReceipt(plan, plan.targets.at(-1)!);
      if (!original || original.phase !== 'deleted') throw new TeamOwnerError('hold');
      return original;
    }
    return parent;
  }
  async lookupPurge(target: ProjectTeamTarget, commandId: string, expectedRevision: string) {
    const plan = this.original(target, commandId, 'purge', expectedRevision);
    if (!plan) return await this.options.storage.lookupPurge(target.team.definition.binding.teamId, commandId, expectedRevision);
    return await this.purgeReceipt(plan, plan.targets.at(-1)!);
  }
}
