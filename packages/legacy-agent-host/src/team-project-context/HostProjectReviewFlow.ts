import { z } from 'zod';
import { TeamOwnerError } from '../team/contracts.js';
import { digest } from '../team/identity.js';
import { validateTeamCommand } from '../team/validateTeamCommand.js';
import { teamRegistryScopeSchema } from '../team-registry/contracts.js';
import { assertProjectDefinitionIdle } from './projectDefinitionPlan.js';
import { assertProjectLifecycleIdle } from './projectLifecyclePlan.js';
import { projectFanoutJournal } from './projectFanoutJournal.js';
import { HostProjectTeamRelations } from './HostProjectTeamRelations.js';
import type { ProjectTeamTarget, ProjectTeamRelationsOptions } from './HostProjectTeamRelations.js';
import type { HostedTeam } from '../composition/MemberEntry.js';
import type { TeamStore } from '../team/ports.js';
import type { TeamCommand, CommandReceipt, TeamReviewFlowSettings } from '../team/contracts.js';

const id = z.string().min(1).max(256).refine(value => !!value.trim() && !value.includes('\0'));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const settingsSchema = z.object({ reviewFlow: z.enum(['agent_approval', 'human_approval', 'lead_then_human']),
  reviewFlowPrompt: z.string().refine(value => value.trim().length <= 1000) }).strict().nullable();
const targetSchema = z.object({ teamId: id, handleId: id, scope: teamRegistryScopeSchema,
  authorityRevision: z.number().int().positive(), commandId: id }).strict();
const planSchema = z.object({ schemaVersion: z.literal(1), family: z.literal('project-review-flow'),
  ownerId: id, ownerDigest: hash, principalId: id, logicalTeamId: id, logicalHandleId: id, commandId: id,
  settings: settingsSchema, targets: z.array(targetSchema).min(1).max(129),
  fingerprint: hash, phase: z.enum(['prepared', 'completed']), sequence: z.number().int().min(1).max(4096),
}).strict();
type Plan = z.infer<typeof planSchema>;
const directory = 'project-review-flow';
const settingSchema = z.object({ schemaVersion: z.literal(1), ownerId: id, ownerDigest: hash, principalId: id,
  logicalTeamId: id, commandId: id, settings: settingsSchema }).strict();
function fingerprint(value: Omit<Plan, 'fingerprint' | 'phase' | 'sequence'>): string {
  const { fingerprint: _fingerprint, phase: _phase, sequence: _sequence, ...intent } = value as Plan;
  return digest(intent);
}
function validate(raw: unknown): Plan {
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) throw new TeamOwnerError('hold');
  const plan = parsed.data, first = plan.targets[0]!;
  if (fingerprint(plan) !== plan.fingerprint || first.teamId !== plan.logicalTeamId ||
    first.handleId !== plan.logicalHandleId || first.commandId !== plan.commandId ||
    new Set(plan.targets.map(row => row.teamId)).size !== plan.targets.length ||
    new Set(plan.targets.map(row => row.commandId)).size !== plan.targets.length ||
    plan.targets.some(row => row.scope.teamId !== row.teamId)) throw new TeamOwnerError('hold');
  return plan;
}
export function assertProjectReviewFlowIdle(store: Pick<TeamStore, 'read'>): void {
  const raw = store.read(`${directory}/current.json`);
  if (raw !== undefined && validate(raw).phase === 'prepared') throw new TeamOwnerError('hold');
}

/** One logical policy and every existing project board share the original captured owner command. */
export class HostProjectReviewFlow {
  readonly relations: HostProjectTeamRelations;
  constructor(private readonly options: ProjectTeamRelationsOptions & {
    stores: ReadonlyMap<string, TeamStore>;
  }) { this.relations = new HostProjectTeamRelations(options); }

  private store(team: HostedTeam): TeamStore {
    const store = this.options.stores.get(team.definition.binding.teamId);
    if (!store || this.options.teams.get(team.definition.binding.teamId) !== team) throw new TeamOwnerError('hold');
    return store;
  }
  private journal(team: HostedTeam) { return projectFanoutJournal(this.store(team), directory, validate); }
  private original(target: ProjectTeamTarget, commandId: string): Plan | undefined {
    this.relations.assertTarget(target);
    const plan = this.journal(target.team).original(commandId);
    if (plan && (plan.ownerId !== this.options.profile.owner.ownerId ||
      plan.ownerDigest !== digest(this.options.profile.owner) ||
      plan.principalId !== this.options.profile.principalId || plan.logicalTeamId !== target.team.definition.binding.teamId ||
      plan.logicalHandleId !== target.handleId)) throw new TeamOwnerError('forbidden');
    return plan;
  }
  private board(team: HostedTeam) {
    if (!team.connection.readQueries) throw new TeamOwnerError('hold');
    return team.connection.readQueries.getReviewFlowSettings();
  }
  private setting(team: HostedTeam): { saved: boolean; settings: TeamReviewFlowSettings | null; unreadable?: true } {
    const raw = this.store(team).read(`${directory}/setting.json`);
    if (raw === undefined) return { saved: false, settings: null };
    const parsed = settingSchema.safeParse(raw);
    if (!parsed.success) return { saved: true, settings: null, unreadable: true };
    const value = parsed.data;
    if (value.ownerId !== this.options.profile.owner.ownerId || value.ownerDigest !== digest(this.options.profile.owner) ||
      value.principalId !== this.options.profile.principalId ||
      value.logicalTeamId !== team.definition.binding.teamId) throw new TeamOwnerError('hold');
    const original = team.connection.lookup(value.commandId);
    if (!original || original.phase !== 'completed' || digest(original.command) !== digest({ commandId: value.commandId,
      operation: 'task.board.review-flow', payload: { settings: value.settings } })) throw new TeamOwnerError('hold');
    const current = this.board(team);
    if (current.unreadable || digest(current.settings) !== digest(value.settings))
      return { saved: true, settings: null, unreadable: true };
    return { saved: true, settings: structuredClone(value.settings) };
  }

  read(target: ProjectTeamTarget) {
    const family = this.relations.select(target), board = this.board(target.team);
    if (family.kind !== 'logical') return { kind: 'review-flow' as const, ...board };
    const saved = this.setting(target.team), current = this.journal(target.team).current();
    if (current) this.original(target, current.commandId);
    return { kind: 'review-flow' as const, ...board,
      projectTeam: { ...saved, projects: family.children.map(child => ({
        executionHandleId: child.handleId, projectPath: child.record.projectContext!.projectPath,
      })) },
      ...(current?.phase === 'prepared' ? { pending: { commandId: current.commandId, settings: structuredClone(current.settings) } } : {}),
    };
  }

  private admission(target: ProjectTeamTarget): number {
    this.relations.assertTarget(target);
    return target.team.owner.withLaunchAuthority(this.options.profile.principalId, 'control', revision => {
      this.relations.assertTarget(target);
      const store = this.store(target.team);
      assertProjectLifecycleIdle(store); assertProjectDefinitionIdle(store);
      const lifecycle = target.team.owner.lifecycleCommands(this.options.profile.principalId).view();
      if (lifecycle.deleted || lifecycle.cleanupPending) throw new TeamOwnerError('hold');
      this.board(target.team);
      return revision;
    });
  }
  private current(plan: Plan, row: Plan['targets'][number]): HostedTeam {
    this.options.assertCurrent();
    const team = this.options.teams.get(row.teamId);
    if (!team || team.definition.binding.backendId !== plan.ownerId ||
      digest(team.definition.scope) !== digest(row.scope)) throw new TeamOwnerError('hold');
    team.owner.withLaunchAuthority(plan.principalId, 'control', revision => {
      if (revision !== row.authorityRevision) throw new TeamOwnerError('forbidden');
      const lifecycle = team.owner.lifecycleCommands(plan.principalId).view();
      if (lifecycle.deleted || lifecycle.cleanupPending) throw new TeamOwnerError('hold');
    });
    return team;
  }

  execute(target: ProjectTeamTarget, command: TeamCommand): CommandReceipt | undefined {
    if (command.operation !== 'task.board.review-flow') return undefined;
    validateTeamCommand(command);
    return this.store(target.team).fenced(() => {
      let plan = this.original(target, command.commandId);
      if (plan && digest(plan.settings) !== digest(command.payload.settings)) throw new TeamOwnerError('conflict');
      if (!plan) {
        const family = this.relations.writable(target);
        if (family.kind !== 'logical') return undefined;
        assertProjectReviewFlowIdle(this.store(target.team));
        const targets = [target, ...family.children].map((selected, index) => ({
          teamId: selected.team.definition.binding.teamId, handleId: selected.handleId,
          scope: structuredClone(selected.team.definition.scope), authorityRevision: this.admission(selected),
          commandId: index === 0 ? command.commandId
            : `review:${digest({ commandId: command.commandId, teamId: selected.team.definition.binding.teamId })}`,
        }));
        const intent = { schemaVersion: 1 as const, family: 'project-review-flow' as const,
          ownerId: this.options.profile.owner.ownerId, ownerDigest: digest(this.options.profile.owner),
          principalId: this.options.profile.principalId,
          logicalTeamId: target.team.definition.binding.teamId, logicalHandleId: target.handleId,
          commandId: command.commandId, settings: structuredClone(command.payload.settings), targets };
        plan = this.journal(target.team).prepare({ ...intent, fingerprint: fingerprint(intent), phase: 'prepared' });
      }
      if (plan.phase === 'completed') {
        this.current(plan, plan.targets[0]!);
        const receipt = target.team.connection.lookup(command.commandId, command);
        if (!receipt || receipt.phase !== 'completed') throw new TeamOwnerError('hold');
        return receipt;
      }
      // Capture was complete before the first policy write; each effect checks the same original grant.
      for (const row of plan.targets) this.current(plan, row);
      let logical: CommandReceipt | undefined;
      let incomplete = false;
      for (const [index, row] of plan.targets.entries()) {
        try {
          const team = this.current(plan, row);
          const receipt = team.connection.execute({ commandId: row.commandId,
            operation: 'task.board.review-flow', payload: { settings: structuredClone(plan.settings) } });
          if (receipt.phase !== 'completed') throw new TeamOwnerError('hold');
          if (index === 0) {
            logical = receipt;
            this.store(target.team).write(`${directory}/setting.json`, { schemaVersion: 1,
              ownerId: plan.ownerId, ownerDigest: plan.ownerDigest, principalId: plan.principalId, logicalTeamId: plan.logicalTeamId,
              commandId: plan.commandId, settings: structuredClone(plan.settings) });
          }
        } catch (error) {
          if (index === 0) throw error;
          // Match the existing policy fanout: attempt every captured board, retain all failures.
          incomplete = true;
        }
      }
      this.current(plan, plan.targets[0]!);
      if (incomplete) throw new TeamOwnerError('hold');
      this.journal(target.team).complete(plan);
      return logical!;
    });
  }

  lookup(target: ProjectTeamTarget, commandId: string): CommandReceipt | null | undefined {
    const plan = this.original(target, commandId);
    if (!plan) return undefined;
    this.current(plan, plan.targets[0]!);
    if (plan.phase !== 'completed') return null;
    const receipt = target.team.connection.lookup(commandId, { commandId,
      operation: 'task.board.review-flow', payload: { settings: plan.settings } });
    if (!receipt || receipt.phase !== 'completed') throw new TeamOwnerError('hold');
    return receipt;
  }

  synchronizeHistory(logical: HostedTeam, execution: HostedTeam, commandId: string): void {
    this.options.assertCurrent();
    const context = logical.definition.scope.projectId;
    const catalog = this.options.registry()?.list(context);
    const record = catalog?.teams.find(row => row.teamId === execution.definition.binding.teamId);
    if (!record?.projectContext || record.projectContext.logicalTeamId !== logical.definition.binding.teamId)
      throw new TeamOwnerError('hold');
    const family = this.relations.select({ team: execution, handleId: record.binding.handleId });
    if (family.kind !== 'alias' || family.logical?.team !== logical) throw new TeamOwnerError('forbidden');
    const saved = logical.owner.withLaunchAuthority(this.options.profile.principalId, 'read', () => this.setting(logical));
    if (!saved.saved) return;
    if (saved.unreadable) throw new TeamOwnerError('hold');
    const current = this.board(execution);
    if (!current.unreadable && digest(current.settings) === digest(saved.settings)) return;
    execution.owner.withLaunchAuthority(this.options.profile.principalId, 'control', () => {
      this.options.assertCurrent();
      const receipt = execution.connection.execute({ commandId: `project-review:${digest({ commandId,
        logical: logical.definition.binding.teamId, execution: execution.definition.binding.teamId, settings: saved.settings })}`,
        operation: 'task.board.review-flow', payload: { settings: saved.settings } });
      if (receipt.phase !== 'completed') throw new TeamOwnerError('hold');
    });
  }
}
