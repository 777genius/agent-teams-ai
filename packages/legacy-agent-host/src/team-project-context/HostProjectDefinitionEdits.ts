import { TeamOwnerError } from '../team/contracts.js';
import { digest, effectId } from '../team/identity.js';
import { assertTeamExecutionAllowed } from '../team/teamLifecycleAdmission.js';
import { replaceRosterPayloadSchema } from '../team/rosterSchema.js';
import { parseLiveRosterResponse } from '../team/liveRosterMembership.js';
import { runtimeDigest } from '../runtime/identity.js';
import { assertProjectLifecycleIdle } from './projectLifecyclePlan.js';
import { assertProjectReviewFlowIdle } from './HostProjectReviewFlow.js';
import { activeProjectDefinitionPlan, readProjectDefinitionPlan, writeProjectDefinitionPlan,
  projectDefinitionFingerprint } from './projectDefinitionPlan.js';
import { projectDefinitionSettings } from './projectLaunchSettings.js';
import type { ProjectDefinitionPlan } from './projectDefinitionPlan.js';
import type { HostProjectTarget } from './HostTeamProjectContexts.js';
import type { LiveRosterOperation } from '../composition/executeLiveRosterMembership.js';
import type { LiveRosterResponse } from '../team/liveRosterMembership.js';
import type { HostedTeam } from '../composition/MemberEntry.js';
import type { TeamRegistry } from '../team-registry/TeamRegistry.js';
import type { TeamStore } from '../team/ports.js';
import type { OwnerState } from '../team/ownerState.js';

const held = (): LiveRosterResponse => ({ ok: false, code: 'hold', outcome: 'unknown' });
/** Definition fanout is a continuation of one original Team CAS; no cold replay can issue another child effect. */
export class HostProjectDefinitionEdits {
  private readonly running = new Set<string>();
  private readonly warm = new Map<string, number>();
  constructor(private readonly options: {
    principalId: string; registry(): Pick<TeamRegistry, 'list'> | undefined;
    teams: ReadonlyMap<string, HostedTeam>; stores: ReadonlyMap<string, TeamStore>;
    assertCurrent(): void; assertNotLaunching(target: HostProjectTarget): void; assertStopped(team: HostedTeam): void;
    executeLive(input: LiveRosterOperation): Promise<unknown>;
  }) {}

  private current(team: HostedTeam, control = false) {
    this.options.assertCurrent();
    if (this.options.teams.get(team.definition.binding.teamId) !== team) throw new TeamOwnerError('forbidden');
    const store = this.options.stores.get(team.definition.binding.teamId);
    if (!store) throw new TeamOwnerError('hold');
    return team.owner.withLaunchAuthority(this.options.principalId, control ? 'control' : 'read', authorityRevision => {
      const roster = team.connection.readRoster(), state = store.read<OwnerState>('state.json');
      if (!state) throw new TeamOwnerError('hold');
      if (control) {
        assertTeamExecutionAllowed(state, store); assertProjectLifecycleIdle(store); assertProjectReviewFlowIdle(store);
      }
      return { roster, store, authorityRevision };
    });
  }

  private describe(target: HostProjectTarget, mutation = true) {
    const current = this.current(target.team);
    const catalog = this.options.registry()?.list(target.team.definition.scope.projectId);
    const row = catalog?.teams.find(row => row.teamId === target.team.definition.binding.teamId);
    if (catalog?.held.some(row => row.record.teamId === target.team.definition.binding.teamId)) throw new TeamOwnerError('hold');
    if (row && (row.binding.handleId !== target.handleId || digest(row.binding.scope) !== digest(target.team.definition.scope))) throw new TeamOwnerError('forbidden');
    if (row?.projectContext) {
      if (mutation) throw new TeamOwnerError('forbidden');
      return undefined;
    }
    if (current.roster.savedSettings?.projectContextMode !== 'per_project') return undefined;
    if (!row || !catalog) throw new TeamOwnerError('hold');
    const children = [...catalog.teams.map(record => ({ phase: 'published' as const, record })), ...catalog.held]
      .filter(row => row.record.projectContext?.logicalTeamId === target.team.definition.binding.teamId);
    for (const child of children) if (child.record.projectContext!.logicalHandleId !== target.handleId ||
        child.record.contextId !== row.contextId || child.phase !== 'published') throw new TeamOwnerError('hold');
    return { ...current, children };
  }

  private child(target: HostProjectTarget, plan: ProjectDefinitionPlan, captured: ProjectDefinitionPlan['children'][number]) {
    const root = this.current(target.team, true);
    if (root.authorityRevision !== plan.authorityRevision || plan.principalId !== this.options.principalId ||
        plan.logicalHandleId !== target.handleId || plan.logicalScopeDigest !== digest(target.team.definition.scope)) throw new TeamOwnerError('forbidden');
    const rows = this.options.registry()?.list(target.team.definition.scope.projectId);
    const record = rows?.teams.find(row => row.teamId === captured.record.teamId);
    if (!record || digest(record) !== digest(captured.record)) throw new TeamOwnerError('hold');
    const team = this.options.teams.get(record.teamId);
    if (!team || record.projectContext?.logicalHandleId !== target.handleId ||
        record.projectContext.logicalTeamId !== target.team.definition.binding.teamId ||
        digest(record.binding.scope) !== digest(team.definition.scope) || team.definition.binding.backendId !== target.team.definition.binding.backendId)
      throw new TeamOwnerError('forbidden');
    if (this.current(team, true).authorityRevision !== captured.authorityRevision) throw new TeamOwnerError('forbidden');
    return team;
  }

  private validateOriginal(target: HostProjectTarget, plan: ProjectDefinitionPlan, input: LiveRosterOperation): void {
    const expected = replaceRosterPayloadSchema.parse(input.conversation.phase === 'read'
      ? (input.payload as { expected: unknown }).expected : input.payload);
    if (plan.commandId !== input.commandId || plan.logicalHandleId !== target.handleId ||
        plan.logicalScopeDigest !== digest(target.team.definition.scope) || plan.principalId !== this.options.principalId ||
        digest(plan.payload) !== digest(expected)) throw new TeamOwnerError('conflict');
    if (this.current(target.team, input.conversation.phase !== 'read').authorityRevision !== plan.authorityRevision) throw new TeamOwnerError('forbidden');
  }

  async execute(target: HostProjectTarget, input: LiveRosterOperation): Promise<LiveRosterResponse | undefined> {
    const source = this.describe(target, input.conversation.phase !== 'read');
    if (!source) return undefined;
    const original = replaceRosterPayloadSchema.parse(input.conversation.phase === 'read'
      ? (input.payload as { expected: unknown }).expected : input.payload);
    let plan = readProjectDefinitionPlan(source.store, input.commandId);
    if (!plan) {
      if (input.conversation.phase !== 'capture') return held();
      this.options.assertNotLaunching(target);
      if (activeProjectDefinitionPlan(source.store) || source.roster.revision !== original.expectedRevision) throw new TeamOwnerError('conflict');
      if (original.savedSettings && original.savedSettings.projectContextMode !== 'per_project') throw new TeamOwnerError('invalid');
      const children = source.children.map(row => {
        const child = this.options.teams.get(row.record.teamId);
        if (!child || digest(child.definition.scope) !== digest(row.record.binding.scope)) throw new TeamOwnerError('hold');
        const current = this.current(child, true);
        return { record: structuredClone(row.record), authorityRevision: current.authorityRevision,
          commandId: effectId('project-definition-child', target.team.definition.binding.teamId, input.commandId, row.record.teamId),
          payload: { expectedRevision: current.roster.revision, members: original.members,
            savedSettings: projectDefinitionSettings(original.savedSettings ?? source.roster.savedSettings,
              current.roster.savedSettings, row.record.projectContext!.projectPath) } };
      });
      const intent = { schemaVersion: 1 as const, commandId: input.commandId, principalId: this.options.principalId,
        logicalHandleId: target.handleId, logicalScopeDigest: digest(target.team.definition.scope),
        authorityRevision: this.current(target.team, true).authorityRevision, payload: original, children,
        issued: [], completed: [], phase: 'prepared' as const };
      plan = { ...intent, fingerprint: projectDefinitionFingerprint(intent) };
      writeProjectDefinitionPlan(source.store, plan);
      this.warm.set(input.commandId, Date.now() + input.conversation.remainingMs);
    }
    this.validateOriginal(target, plan, input);
    if (plan.phase === 'abandoned') return held();
    const logicalReceipt = target.team.connection.lookupRoster(plan.commandId, plan.payload);
    if (plan.phase === 'completed') {
      if (!logicalReceipt) throw new TeamOwnerError('hold');
      return { ok: true, value: logicalReceipt };
    }
    if (input.conversation.phase === 'read') {
      for (const captured of plan.children) if (plan.issued.includes(captured.commandId)) {
        this.child(target, plan, captured);
        await this.options.executeLive({ ...input, teamId: captured.record.teamId, commandId: captured.commandId,
          binding: { ...input.binding, handleId: captured.record.binding.handleId, scope: captured.record.binding.scope },
          payload: { expected: captured.payload }, conversation: { phase: 'read' } });
      }
      return held();
    }
    if (this.running.has(plan.commandId)) return held();
    this.running.add(plan.commandId);
    try {
      const rootReceipt = logicalReceipt ?? target.team.connection.replaceRoster({ commandId: plan.commandId, ...plan.payload });
      if (this.current(target.team).roster.revision !== rootReceipt.revision) throw new TeamOwnerError('conflict');
      for (const captured of plan.children) {
        const child = this.child(target, plan, captured);
        if (plan.completed.includes(captured.commandId)) {
          if (!child.connection.lookupRoster(captured.commandId, captured.payload)) throw new TeamOwnerError('hold');
          continue;
        }
        const wasIssued = plan.issued.includes(captured.commandId);
        const cutoff = this.warm.get(plan.commandId);
        if (!wasIssued && (cutoff === undefined || Date.now() >= cutoff)) return held();
        if (wasIssued && input.conversation.phase === 'capture') {
          const known = child.connection.lookupRoster(captured.commandId, captured.payload);
          if (!known) return held();
          plan.completed.push(captured.commandId); writeProjectDefinitionPlan(source.store, plan); continue;
        }
        if (!wasIssued) { plan.issued.push(captured.commandId); writeProjectDefinitionPlan(source.store, plan); }
        const { localModelReadinessOrigin, ...request } = input;
        const childInput: LiveRosterOperation = { ...request, teamId: captured.record.teamId, commandId: captured.commandId,
          binding: { ...input.binding, handleId: captured.record.binding.handleId, scope: captured.record.binding.scope },
          payload: captured.payload,
          conversation: wasIssued ? input.conversation : { phase: 'capture', remainingMs: Math.max(1, Math.min(input.conversation.remainingMs, cutoff! - Date.now())) },
          ...(wasIssued && localModelReadinessOrigin ? { localModelReadinessOrigin } : {}) };
        const response = parseLiveRosterResponse(await this.options.executeLive(childInput));
        this.child(target, plan, captured);
        if (response.ok && 'liveRosterCapture' in response) return { ...response, projectDefinition: {
          logicalCommandId: input.commandId, logicalHandleId: target.handleId,
          logicalTeamId: target.team.definition.binding.teamId, logicalExpectedRevision: original.expectedRevision,
          logicalRequestDigest: runtimeDigest({ commandId: input.commandId, payload: original }),
          selectionDigest: runtimeDigest({ handleId: captured.record.binding.handleId,
            scope: captured.record.binding.scope, payload: captured.payload, liveRosterCapture: response.liveRosterCapture }),
        } };
        if (!response.ok || !('value' in response)) return held();
        if (response.value.commandId !== captured.commandId ||
            child.connection.lookupRoster(captured.commandId, captured.payload)?.revision !== response.value.revision) throw new TeamOwnerError('hold');
        plan.completed.push(captured.commandId); writeProjectDefinitionPlan(source.store, plan);
      }
      plan.phase = 'completed'; writeProjectDefinitionPlan(source.store, plan); this.warm.delete(plan.commandId);
      return { ok: true, value: rootReceipt };
    } finally { this.running.delete(plan.commandId); }
  }

  /** Explicit fresh stopped work may abandon unknown native work, but never replays unissued siblings. */
  lookup(target: HostProjectTarget, commandId: string, expected?: unknown) {
    const source = this.describe(target, false);
    if (!source) return undefined;
    const plan = readProjectDefinitionPlan(source.store, commandId);
    if (!plan) return undefined;
    if (plan.logicalHandleId !== target.handleId || plan.logicalScopeDigest !== digest(target.team.definition.scope) ||
        plan.principalId !== this.options.principalId || this.current(target.team).authorityRevision !== plan.authorityRevision ||
        expected !== undefined && digest(replaceRosterPayloadSchema.parse(expected)) !== digest(plan.payload))
      throw new TeamOwnerError('conflict');
    if (plan.phase !== 'completed') return null;
    return target.team.connection.lookupRoster(commandId, plan.payload) ?? null;
  }

  reconcileStopped(target: HostProjectTarget): void {
    const source = this.describe(target);
    if (!source) return;
    const plan = activeProjectDefinitionPlan(source.store);
    if (!plan) return;
    if (this.running.has(plan.commandId)) throw new TeamOwnerError('hold');
    this.options.assertStopped(target.team);
    for (const captured of plan.children) {
      const child = this.child(target, plan, captured); this.options.assertStopped(child);
    }
    plan.phase = 'abandoned'; writeProjectDefinitionPlan(source.store, plan); this.warm.delete(plan.commandId);
  }
}
