import { TeamOwnerError } from '../team/contracts.js';
import { digest, effectId } from '../team/identity.js';
import { assertTeamExecutionAllowed } from '../team/teamLifecycleAdmission.js';
import { hostProjectPathIdentity } from './hostProjectPathIdentity.js';
import { assertProjectDefinitionIdle } from './projectDefinitionPlan.js';
import { assertProjectLifecycleIdle } from './projectLifecyclePlan.js';
import { assertProjectReviewFlowIdle } from './HostProjectReviewFlow.js';
import { applyDefinitionLaunchSettings, projectAuthoredSettings, projectDefinitionSettings } from './projectLaunchSettings.js';
import { projectContextPrepareSchema, projectContextReadSchema, projectPreparationIndexSchema,
  projectPreparationRecordSchema, projectPreparationSelectionSchema, projectReadinessLocatorSchema } from './contracts.js';
import { localModelReadinessTransferSchema } from '../composition/prepareTeamModelReadiness.js';
import { captureProjectReadinessTransfer } from './projectReadinessTransfer.js';
import type { HostProjectContextSnapshot, ProjectPreparationRecord } from './contracts.js';
import type { HostedTeam } from '../composition/MemberEntry.js';
import type { TeamRegistry } from '../team-registry/TeamRegistry.js';
import type { TeamRegistryList, TeamRegistryReceipt, TeamRegistryRecord } from '../team-registry/contracts.js';
import type { TeamStore } from '../team/ports.js';
import type { OwnerState } from '../team/ownerState.js';

export interface HostProjectTarget { team: HostedTeam; handleId: string }
type History = { phase: 'published' | 'pending' | 'held'; record: TeamRegistryRecord };
type Registry = Pick<TeamRegistry, 'list' | 'lookup' | 'createProjectContext'>;

/** Logical definitions and project histories share the original registry, Team owner and command ledgers. */
export class HostTeamProjectContexts {
  private readonly launching = new Map<string, string>();
  constructor(private readonly options: {
    principalId: string; registry: Registry;
    team(teamId: string): HostedTeam | undefined;
    store(team: HostedTeam): TeamStore;
    assertCurrent(): void; assertStopped(team: HostedTeam): void;
    identifyPath?: typeof hostProjectPathIdentity;
    synchronizeHistory?(logical: HostedTeam, execution: HostedTeam, commandId: string): void;
    reconcileDefinition?(target: HostProjectTarget): void;
  }) {}

  private current(team: HostedTeam, control = false) {
    this.options.assertCurrent();
    if (this.options.team(team.definition.binding.teamId) !== team) throw new TeamOwnerError('forbidden');
    return team.owner.withLaunchAuthority(this.options.principalId, control ? 'control' : 'read', () => {
      this.options.assertCurrent();
      const store = this.options.store(team);
      const roster = team.connection.readRoster();
      const state = store.read<OwnerState>('state.json');
      if (!state) throw new TeamOwnerError('hold');
      if (control) {
        assertTeamExecutionAllowed(state, store);
        assertProjectLifecycleIdle(store); assertProjectDefinitionIdle(store); assertProjectReviewFlowIdle(store);
      }
      return roster;
    });
  }

  private logical(target: HostProjectTarget) {
    const roster = this.current(target.team);
    const all = this.options.registry.list(target.team.definition.scope.projectId);
    if (all.held.some(row => row.record.teamId === target.team.definition.binding.teamId)) throw new TeamOwnerError('hold');
    const row = all.teams.find(row => row.teamId === target.team.definition.binding.teamId);
    if (row && (row.binding.handleId !== target.handleId || digest(row.binding.scope) !== digest(target.team.definition.scope) ||
        row.teamName !== target.team.definition.binding.teamName)) throw new TeamOwnerError('forbidden');
    if (!row && roster.savedSettings?.projectContextMode === 'per_project') throw new TeamOwnerError('hold');
    const alias = row?.projectContext;
    if (!alias) return { target, all, alias: undefined };
    const parent = all.teams.find(row => row.teamId === alias.logicalTeamId && row.binding.handleId === alias.logicalHandleId);
    const logical = parent && this.options.team(parent.teamId);
    if (!logical || parent!.projectContext || parent!.contextId !== row.contextId ||
        digest(parent!.binding.scope) !== digest(logical.definition.scope) ||
        logical.definition.binding.backendId !== target.team.definition.binding.backendId ||
        roster.savedSettings?.projectContextMode !== 'shared' || roster.savedSettings.cwd !== alias.projectPath)
      throw new TeamOwnerError('hold');
    this.current(logical);
    return { target: { team: logical, handleId: parent!.binding.handleId }, all, alias };
  }

  private histories(target: HostProjectTarget, all: TeamRegistryList): History[] {
    const rows: History[] = [...all.teams.map(record => ({ phase: 'published' as const, record })), ...all.held];
    const children = rows.filter(row => row.record.projectContext?.logicalTeamId === target.team.definition.binding.teamId);
    for (const row of children) {
      const relation = row.record.projectContext!;
      if (relation.logicalHandleId !== target.handleId || row.record.contextId !== target.team.definition.scope.projectId ||
          row.record.binding.scope.projectId !== target.team.definition.scope.projectId ||
          row.record.projectContextMode === 'per_project') throw new TeamOwnerError('hold');
    }
    if (new Set(children.map(row => row.record.projectContext!.projectKey)).size !== children.length ||
        new Set(children.map(row => row.record.projectContext!.workContextId)).size !== children.length)
      throw new TeamOwnerError('hold');
    return children;
  }

  read(target: HostProjectTarget, raw: unknown): HostProjectContextSnapshot {
    const request = projectContextReadSchema.parse(raw), source = this.logical(target);
    if (source.alias) return { kind: 'team-project-context', histories: [], view: {
      mode: 'per_project', state: 'redirect', logicalHandleId: source.target.handleId, projectPath: source.alias.projectPath } };
    const isolated = this.current(target.team).savedSettings?.projectContextMode === 'per_project';
    const children = this.histories(target, source.all), histories: HostProjectContextSnapshot['histories'] = [];
    for (const row of children) {
      if (row.phase !== 'published') continue;
      const team = this.options.team(row.record.teamId);
      if (!team) throw new TeamOwnerError('hold');
      this.current(team);
      histories.push({ executionHandleId: row.record.binding.handleId, workContextId: row.record.projectContext!.workContextId,
        projectPath: row.record.projectContext!.projectPath });
    }
    const result = { kind: 'team-project-context' as const, histories };
    if (!isolated) return { ...result, view: { mode: 'shared', state: 'ready', executionHandleId: target.handleId } };
    if (!request.projectPath?.trim()) {
      const recovery = children.find(row => row.phase !== 'published')?.record.projectContext;
      return { ...result, view: { mode: 'per_project', state: 'needs_project',
        ...(recovery ? { recoveryProjectPath: recovery.projectPath } : {}) } };
    }
    const project = (this.options.identifyPath ?? hostProjectPathIdentity)(request.projectPath, request.scheduleAdmission === true);
    const row = children.find(row => row.record.projectContext!.projectKey === project.key);
    if (request.scheduleAdmission) {
      this.current(target.team, true);
      if (this.launching.has(target.team.definition.binding.teamId)) throw new TeamOwnerError('hold');
      if (row?.phase === 'published') {
        const selected = this.options.team(row.record.teamId);
        if (!selected) throw new TeamOwnerError('hold');
        this.current(selected, true);
      }
      for (const sibling of children) {
        if (sibling === row) continue;
        const child = this.options.team(sibling.record.teamId);
        if (sibling.phase !== 'published' || !child) throw new TeamOwnerError('hold');
        this.current(child, true); this.options.assertStopped(child);
      }
    }
    if (!row) return { ...result, view: { mode: 'per_project', state: 'empty' } };
    const relation = row.record.projectContext!;
    if (row.phase !== 'published') return { ...result, view: { mode: 'per_project', state: 'pending',
      reason: 'incomplete', projectPath: relation.projectPath, runId: null } };
    return { ...result, view: { mode: 'per_project', state: 'ready', executionHandleId: row.record.binding.handleId,
      workContextId: relation.workContextId, projectPath: relation.projectPath } };
  }

  assertDefinitionAdmission(target: HostProjectTarget): void {
    const source = this.logical(target);
    if (source.alias) throw new TeamOwnerError('forbidden');
    this.current(target.team, true);
    if (this.launching.has(target.team.definition.binding.teamId)) throw new TeamOwnerError('hold');
  }

  assertProductMutation(target: HostProjectTarget): void {
    const source = this.logical(target);
    this.current(target.team, true);
    if (source.alias && this.current(source.target.team, true).savedSettings?.projectContextMode !== 'per_project')
      throw new TeamOwnerError('forbidden');
    if (!source.alias && this.current(target.team).savedSettings?.projectContextMode === 'per_project')
      throw new TeamOwnerError('forbidden');
  }

  assertDefinitionEditable(target: HostProjectTarget): void {
    this.assertDefinitionAdmission(target);
    const source = this.logical(target);
    for (const row of this.histories(target, source.all)) {
      const child = this.options.team(row.record.teamId);
      if (row.phase !== 'published' || !child) throw new TeamOwnerError('hold');
      this.current(child, true); this.options.assertStopped(child);
    }
  }

  assertLaunchAllowed(target: HostProjectTarget): void {
    const source = this.logical(target), roster = this.current(target.team, true);
    if (!source.alias) {
      if (roster.savedSettings?.projectContextMode === 'per_project') throw new TeamOwnerError('forbidden');
      for (const row of this.histories(target, source.all)) {
        const child = this.options.team(row.record.teamId);
        if (row.phase !== 'published' || !child) throw new TeamOwnerError('hold');
        this.current(child, true); this.options.assertStopped(child);
      }
      return;
    }
    const logical = this.current(source.target.team, true);
    if (logical.savedSettings?.projectContextMode !== 'per_project') throw new TeamOwnerError('forbidden');
    const inFlight = this.launching.get(source.target.team.definition.binding.teamId);
    if (inFlight && inFlight !== target.team.definition.binding.teamId) throw new TeamOwnerError('hold');
    (this.options.identifyPath ?? hostProjectPathIdentity)(source.alias.projectPath, true);
    const product = (value: typeof roster) => value.members.map(row => ({ name: row.name, role: row.role, settings: row.settings }));
    if (digest(product(logical)) !== digest(product(roster)) ||
        digest(projectAuthoredSettings(logical.savedSettings, source.alias.projectPath)) !==
          digest(projectAuthoredSettings(roster.savedSettings, source.alias.projectPath))) throw new TeamOwnerError('conflict');
    for (const row of this.histories(source.target, source.all)) {
      if (row.record.teamId === target.team.definition.binding.teamId) continue;
      const sibling = this.options.team(row.record.teamId);
      if (row.phase !== 'published' || !sibling) throw new TeamOwnerError('hold');
      this.current(sibling, true); this.options.assertStopped(sibling);
    }
  }

  async withLaunch<T>(target: HostProjectTarget, action: () => Promise<T>): Promise<T> {
    this.assertLaunchAllowed(target);
    const source = this.logical(target);
    if (!source.alias) return action();
    const key = source.target.team.definition.binding.teamId;
    if (this.launching.has(key)) throw new TeamOwnerError('hold');
    this.launching.set(key, target.team.definition.binding.teamId);
    try { return await action(); } finally { this.launching.delete(key); }
  }

  prepare(target: HostProjectTarget, commandId: string, raw: unknown): HostProjectContextSnapshot {
    const input = projectContextPrepareSchema.parse(raw);
    if (!commandId || commandId.length > 256 || /[\0\r\n]/u.test(commandId)) throw new TeamOwnerError('invalid');
    this.options.reconcileDefinition?.(target);
    const logical = this.logical(target);
    if (logical.alias) throw new TeamOwnerError('forbidden');
    let source = this.current(target.team, true);
    if (source.savedSettings?.projectContextMode !== 'per_project') throw new TeamOwnerError('invalid');
    const project = (this.options.identifyPath ?? hostProjectPathIdentity)(input.projectPath, true);
    const fingerprint = digest({ commandId, handleId: target.handleId, input });
    const store = this.options.store(target.team), name = `project-context-launches/${digest(commandId)}.json`;
    const selectionName = `project-context-launches/${digest(commandId)}.selection.json`;
    const retainedSelection = store.read<unknown>(selectionName);
    let selection: ReturnType<typeof projectPreparationSelectionSchema.parse>;
    if (retainedSelection !== undefined) {
      selection = projectPreparationSelectionSchema.parse(retainedSelection);
      if (selection.fingerprint !== fingerprint || selection.commandId !== commandId ||
          selection.logicalHandleId !== target.handleId || selection.projectKey !== project.key ||
          selection.projectPath !== project.path) throw new TeamOwnerError('conflict');
    } else {
      const original = input.rosterCommandId ? target.team.connection.lookupRoster(input.rosterCommandId) : undefined;
      const expectation = input.rosterCommandId
        ? target.team.owner.nativeRoster.readExpectation(this.options.principalId, input.rosterCommandId) : undefined;
      if (input.rosterCommandId && !original || (original?.revision ?? input.expectedRevision) !== source.revision)
        throw new TeamOwnerError('conflict');
      if (input.rosterCommandId && (!expectation || expectation.revision !== original!.revision ||
          input.expectedRevision !== undefined && input.expectedRevision !== expectation.expectedRevision)) throw new TeamOwnerError('conflict');
      const savedSettings = applyDefinitionLaunchSettings(source.savedSettings, input.launchSettings);
      const definition = digest(savedSettings) === digest(source.savedSettings) ? undefined : {
        commandId: effectId('project-context-definition-launch', target.handleId, commandId),
        roster: { expectedRevision: source.revision, savedSettings,
          members: source.members.filter(row => row.role !== 'lead').map(row => ({ name: row.name, ...row.settings })) } };
      selection = { schemaVersion: 1, commandId, fingerprint, sourceRevision: source.revision,
        probeRevision: expectation?.expectedRevision ?? source.revision, logicalHandleId: target.handleId,
        projectKey: project.key, projectPath: project.path, ...(definition ? { definition } : {}) };
    }
    store.fenced(() => {
      this.current(target.team, true);
      const index = projectPreparationIndexSchema.parse(store.read('project-context-launch-index.json') ?? []);
      const admission = index.find(row => row.commandId === commandId);
      if (admission && admission.fingerprint !== fingerprint) throw new TeamOwnerError('conflict');
      if (!admission) {
        if (index.length >= 1024) throw new TeamOwnerError('hold');
        store.write('project-context-launch-index.json', [...index, { commandId, fingerprint }]);
      }
      const retained = store.read<unknown>(selectionName);
      if (retained !== undefined) {
        if (digest(projectPreparationSelectionSchema.parse(retained)) !== digest(selection)) throw new TeamOwnerError('conflict');
      } else store.write(selectionName, selection);
    });
    const priorRaw = store.read<unknown>(name);
    let prior: ProjectPreparationRecord | undefined;
    if (priorRaw !== undefined) {
      prior = projectPreparationRecordSchema.parse(priorRaw);
      if (prior.fingerprint !== fingerprint || prior.commandId !== commandId || prior.logicalHandleId !== target.handleId ||
          prior.probeRevision !== selection.probeRevision || digest(prior.definition ?? null) !== digest(selection.definition ?? null) ||
          prior.projectKey !== project.key) throw new TeamOwnerError('conflict');
    }
    const definition = selection.definition;
    let definitionReceipt = definition ? target.team.connection.lookupRoster(definition.commandId, definition.roster) : undefined;
    if (source.revision !== (definitionReceipt?.revision ?? selection.sourceRevision)) throw new TeamOwnerError('conflict');
    if (prior && (!definition || definitionReceipt)) {
      const creation = this.options.registry.lookup(effectId('project-context-create', target.team.definition.binding.teamId, project.key), target.team.definition.scope.projectId);
      if (!creation || creation.phase !== 'published' || creation.record.projectContext?.logicalHandleId !== target.handleId ||
          creation.record.projectContext.logicalTeamId !== target.team.definition.binding.teamId || creation.record.projectContext.projectKey !== project.key)
        throw new TeamOwnerError('hold');
      const execution = this.options.team(creation.record.teamId);
      if (!execution || prior.executionTeamId !== creation.record.teamId || prior.executionHandleId !== creation.record.binding.handleId ||
          prior.sourceRevision !== source.revision) throw new TeamOwnerError('conflict');
      const receipt = execution.connection.lookupRoster(prior.rosterCommandId, prior.roster);
      if (receipt) {
        if (this.current(execution).revision !== receipt.revision) throw new TeamOwnerError('conflict');
        this.options.synchronizeHistory?.(target.team, execution, commandId);
        return { ...this.read(target, { projectPath: project.path }), prepared: { executionHandleId: prior.executionHandleId,
          rosterCommandId: prior.rosterCommandId, sourceRevision: prior.sourceRevision } };
      }
    }
    this.assertDefinitionEditable(target);
    if (definition && !definitionReceipt) {
      definitionReceipt = target.team.connection.replaceRoster({ commandId: definition.commandId, ...definition.roster });
      source = this.current(target.team, true);
      if (source.revision !== definitionReceipt.revision) throw new TeamOwnerError('conflict');
    }
    const creation = this.ensureHistory(target, project, source);
    if (creation.phase !== 'published') throw new TeamOwnerError('hold');
    const execution = this.options.team(creation.record.teamId);
    if (!execution) throw new TeamOwnerError('hold');
    const current = this.current(execution, true);
    const record: ProjectPreparationRecord = prior ?? { ...selection, sourceRevision: source.revision,
      executionHandleId: creation.record.binding.handleId, executionTeamId: creation.record.teamId,
      rosterCommandId: effectId('project-context-roster', target.handleId, commandId), roster: {
        expectedRevision: current.revision, savedSettings: projectDefinitionSettings(source.savedSettings, current.savedSettings, project.path, input.launchSettings),
        members: source.members.filter(row => row.role !== 'lead').map(row => ({ name: row.name, ...row.settings })) } };
    if (record.executionTeamId !== creation.record.teamId || record.executionHandleId !== creation.record.binding.handleId) throw new TeamOwnerError('conflict');
    if (!prior) store.fenced(() => {
      this.current(target.team, true);
      if (store.read(name) !== undefined) throw new TeamOwnerError('conflict');
      store.write(name, record);
    });
    const receipt = execution.connection.lookupRoster(record.rosterCommandId, record.roster) ??
      execution.connection.replaceRoster({ commandId: record.rosterCommandId, ...record.roster });
    if (this.current(execution).revision !== receipt.revision || this.current(target.team).revision !== source.revision) throw new TeamOwnerError('conflict');
    this.options.synchronizeHistory?.(target.team, execution, commandId);
    return { ...this.read(target, { projectPath: project.path }), prepared: { executionHandleId: record.executionHandleId,
      rosterCommandId: record.rosterCommandId, sourceRevision: record.sourceRevision } };
  }

  ensureHistory(target: HostProjectTarget, project: { key: string; path: string }, source = this.current(target.team, true)): TeamRegistryReceipt {
    if (source.savedSettings?.projectContextMode !== 'per_project') throw new TeamOwnerError('invalid');
    const logicalTeamId = target.team.definition.binding.teamId, contextId = target.team.definition.scope.projectId;
    const commandId = effectId('project-context-create', logicalTeamId, project.key);
    const original = this.options.registry.lookup(commandId, contextId);
    if (original) {
      const relation = original.record.projectContext;
      if (!relation || relation.logicalTeamId !== logicalTeamId || relation.logicalHandleId !== target.handleId ||
          relation.projectKey !== project.key || relation.projectPath !== project.path) throw new TeamOwnerError('conflict');
      return original;
    }
    const relation = { logicalTeamId, logicalHandleId: target.handleId, projectKey: project.key, projectPath: project.path,
      workContextId: effectId('project-work-context', logicalTeamId, project.key) };
    return this.options.registry.createProjectContext(commandId, { contextId,
      teamName: `project-${digest([logicalTeamId, project.key]).slice(0,40)}`,
      savedSettings: { ...source.savedSettings, cwd: project.path, projectContextMode: 'shared' },
      members: source.members.filter(row => row.role !== 'lead').map(row => ({ name: row.name, memberSettings: row.settings })) }, relation);
  }

  readLaunchSource(target: HostProjectTarget, raw: unknown) {
    const locator = projectReadinessLocatorSchema.parse(raw), source = this.logical(target);
    if (!source.alias || source.target.handleId !== locator.logicalHandleId) throw new TeamOwnerError('forbidden');
    if (this.current(source.target.team, true).savedSettings?.projectContextMode !== 'per_project') throw new TeamOwnerError('forbidden');
    const store = this.options.store(source.target.team);
    const record = projectPreparationRecordSchema.parse(store.read(`project-context-launches/${digest(locator.commandId)}.json`));
    if (record.commandId !== locator.commandId || record.logicalHandleId !== locator.logicalHandleId ||
        record.executionTeamId !== target.team.definition.binding.teamId || record.executionHandleId !== target.handleId ||
        record.projectKey !== source.alias.projectKey || record.projectPath !== source.alias.projectPath ||
        this.current(source.target.team, true).revision !== record.sourceRevision) throw new TeamOwnerError('conflict');
    const receipt = target.team.connection.lookupRoster(record.rosterCommandId, record.roster);
    if (!receipt || this.current(target.team, true).revision !== receipt.revision) throw new TeamOwnerError('conflict');
    return { kind: 'team-project-launch-source' as const, logicalHandleId: locator.logicalHandleId,
      sourceRevision: record.sourceRevision, probeRevision: record.probeRevision,
      roster: { commandId: record.rosterCommandId, expected: record.roster } };
  }

  captureReadinessTransfer(target: HostProjectTarget, raw: unknown) {
    const input = localModelReadinessTransferSchema.parse(raw);
    if (!input.projectContext) return input;
    const source = this.logical(target), proof = this.readLaunchSource(target, input.projectContext);
    if (digest(input.roster) !== digest(proof.roster) || !source.alias) throw new TeamOwnerError('conflict');
    const logical = this.current(source.target.team, true), authority = source.target.team.owner.withLaunchAuthority(this.options.principalId, 'control', revision => revision);
    return captureProjectReadinessTransfer({ ...input, kind: 'project', logicalBindingDigest: digest(source.target.team.definition.binding),
      sourceRevision: proof.sourceRevision, probeRevision: proof.probeRevision,
      logicalMembers: logical.members.map(({ memberId, name, role }) => ({ memberId, name, role })) }, () => {
      if (this.readLaunchSource(target, input.projectContext!).sourceRevision !== proof.sourceRevision ||
          source.target.team.owner.withLaunchAuthority(this.options.principalId, 'control', revision => revision) !== authority)
        throw new TeamOwnerError('forbidden');
    });
  }

  /** A native member wrapper must still refer to the exact canonical owner/connection/scope. */
  private crossTeamIdentity(candidate: HostedTeam, handleId?: string) {
    const team = this.options.team(candidate.definition.binding.teamId);
    if (!team || candidate.owner !== team.owner || candidate.connection !== team.connection ||
        digest(candidate.definition.binding) !== digest(team.definition.binding) || digest(candidate.definition.scope) !== digest(team.definition.scope))
      throw new TeamOwnerError('forbidden');
    const roster = this.current(team, true), all = this.options.registry.list(team.definition.scope.projectId);
    const row = all.teams.find(row => row.teamId === team.definition.binding.teamId);
    if (all.held.some(row => row.record.teamId === team.definition.binding.teamId) ||
        row && (digest(row.binding.scope) !== digest(team.definition.scope) || row.teamName !== team.definition.binding.teamName ||
          handleId !== undefined && row.binding.handleId !== handleId)) throw new TeamOwnerError('forbidden');
    if (!row && roster.savedSettings?.projectContextMode === 'per_project') throw new TeamOwnerError('hold');
    const target = { team, handleId: row?.binding.handleId ?? handleId ?? '' };
    const relation = row ? this.logical(target) : undefined;
    if (relation?.alias) this.current(relation.target.team, true);
    if (relation?.alias && this.launching.has(relation.target.team.definition.binding.teamId)) throw new TeamOwnerError('hold');
    return { target, roster, alias: relation?.alias,
      logical: roster.savedSettings?.projectContextMode === 'per_project' && !relation?.alias,
      ...(row?.binding.handleId ?? handleId ? { handleId: row?.binding.handleId ?? handleId } : {}) };
  }

  assertCrossTeamPair(source: HostedTeam, target: HostedTeam): void {
    if (source.definition.scope.projectId !== target.definition.scope.projectId) throw new TeamOwnerError('forbidden');
    const from = this.crossTeamIdentity(source), to = this.crossTeamIdentity(target);
    if (from.logical || to.logical || from.target.team === to.target.team ||
        from.alias && to.alias && from.alias.logicalTeamId === to.alias.logicalTeamId) throw new TeamOwnerError('forbidden');
  }

  resolveCrossTeamTarget(source: HostedTeam, requested: HostedTeam, sourceHandle?: string, targetHandle?: string, visibleOnly = false) {
    if (source.definition.scope.projectId !== requested.definition.scope.projectId) throw new TeamOwnerError('forbidden');
    const from = this.crossTeamIdentity(source, sourceHandle), to = this.crossTeamIdentity(requested, targetHandle);
    if (from.logical || visibleOnly && to.alias) throw new TeamOwnerError('forbidden');
    let selected = to;
    if (to.logical) {
      const projectPath = from.alias?.projectPath ?? from.roster.savedSettings?.cwd;
      if (!projectPath) throw new TeamOwnerError('hold');
      const result = this.read(to.target, { projectPath });
      if (result.view.mode !== 'per_project' || result.view.state !== 'ready') throw new TeamOwnerError('hold');
      const childHandleId = result.view.executionHandleId;
      const record = this.options.registry.list(requested.definition.scope.projectId).teams
        .find(row => row.binding.handleId === childHandleId);
      const child = record && this.options.team(record.teamId);
      if (!child || record!.projectContext?.logicalHandleId !== to.target.handleId ||
          record!.projectContext?.logicalTeamId !== requested.definition.binding.teamId) throw new TeamOwnerError('hold');
      selected = this.crossTeamIdentity(child, record!.binding.handleId);
    }
    this.assertCrossTeamPair(source, selected.target.team);
    return { team: selected.target.team, ...(selected.handleId ? { handleId: selected.handleId } : {}) };
  }
}
