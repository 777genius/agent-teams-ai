import { randomUUID } from 'node:crypto';

import { ScheduledTaskCreationPending } from '@main/services/schedule/SmartScheduleDispatcher';
import { isTeamTaskActivelyWorked } from '@shared/utils/teamTaskState';

import { readHostScheduleState } from './readHostScheduleState';

import type { BackendLaunchConfigurationView, BackendLaunchSnapshot } from '../../../contracts/launch';
import type { BackendOperationPayloads, BackendOperationRequest,
  BackendRuntimeSnapshot, BackendTaskRecipient } from '../../../contracts/operations';
import type { BackendRosterConfiguration } from '../../../contracts/roster';
import type { CapturedHostScheduleTarget } from '../../application/captureHostScheduleTarget';
import type { ExecutionRequest, ScheduledTaskResult } from '@main/services/schedule/ScheduledTaskExecutor';
import type { SmartScheduleRuntimePort } from '@main/services/schedule/SmartScheduleDispatcher';
import type { CreateTaskRequest, MemberSpawnStatusesSnapshot, ScheduleRun, TeamAgentRuntimeSnapshot,
  TeamCreateRequest, TeamLaunchRequest, TeamLaunchResponse, TeamTask } from '@shared/types';

type Value = Extract<Awaited<ReturnType<CapturedHostScheduleTarget['invoke']>>, { ok: true }>['value'];

/** One occurrence, one original owner. All effects remain in existing Team/Runtime ledgers. */
export class HostSmartScheduleRuntimeAdapter implements SmartScheduleRuntimePort {
  readonly targetKind = 'host' as const;
  private rosterRevision?: string;

  constructor(private readonly options: {
    target: CapturedHostScheduleTarget;
    selection: string;
    runId?: string;
    taskFirst?: true;
    getPreviousRuns(scheduleId: string, runId: string): Promise<ScheduleRun[]>;
    isCancelled?(): boolean;
    runOneShot?(request: ExecutionRequest, expectedRosterRevision: string): Promise<ScheduledTaskResult>;
  }) {}

  private assertTeam(team: string): void {
    if (team !== this.options.selection || !this.options.target.isCurrent() || this.options.isCancelled?.())
      throw new Error('Original scheduled team is unavailable');
  }

  private id(operation: string): string {
    if (!this.options.runId) throw new Error('No scheduled occurrence was admitted');
    return `${this.options.runId}:${operation}`;
  }

  private async call<K extends keyof BackendOperationPayloads>(operation: K,
    payload: BackendOperationPayloads[K], commandId: string = randomUUID()): Promise<Value> {
    this.assertTeam(this.options.selection);
    const result = await this.options.target.invoke({ commandId, operation, payload } as Omit<BackendOperationRequest, 'handle'>);
    if (!result.ok) throw new Error(`Scheduled ${operation} ${result.outcome} (${result.code})`);
    return result.value;
  }

  private async roster(): Promise<BackendRosterConfiguration> {
    const value = await this.call('team.roster.read', {});
    if (!value || !('removedMembers' in value)) throw new Error('Scheduled roster is unavailable');
    if (this.rosterRevision !== undefined && value.revision !== this.rosterRevision)
      throw new Error('Scheduled team settings changed during the occurrence');
    return value;
  }

  private async launch(): Promise<BackendLaunchSnapshot | null> {
    const state = await readHostScheduleState(this.options.target);
    if (state.first.runtimeNeverLaunched === true) return null;
    const value = await this.call('team.launch.read', {});
    if (!value || !('retryCapability' in value)) throw new Error('Scheduled launch state is unavailable');
    return value;
  }

  private async runtime(memberId: string, expectedGeneration: string): Promise<BackendRuntimeSnapshot> {
    const value = await this.call('runtime.read', { memberId, expectedGeneration });
    if (!value || !('inputs' in value) || !('attached' in value) || value.generation !== expectedGeneration)
      throw new Error('Scheduled member generation is unavailable');
    return value;
  }

  async getSavedRequest(team: string): Promise<TeamCreateRequest | null> {
    this.assertTeam(team);
    const roster = await this.roster();
    if (!roster.savedSettings) return null;
    this.rosterRevision ??= roster.revision;
    if (roster.members.filter(row => row.role === 'lead').length !== 1)
      throw new Error('Scheduled team lead is unavailable');
    return { ...structuredClone(roster.savedSettings), teamName: team,
      savedSettingsFingerprint: roster.revision,
      members: roster.members.filter(row => row.role !== 'lead').map(row =>
        ({ ...structuredClone(row.settings), name: row.name })) };
  }

  async hasLaunchConfig(team: string): Promise<boolean> {
    return Boolean(await this.getSavedRequest(team));
  }
  async hasRunnableConfig(team: string): Promise<boolean> { return this.hasLaunchConfig(team); }
  async getLeadName(team: string): Promise<string | null> {
    this.assertTeam(team);
    const leads = (await this.roster()).members.filter(row => row.role === 'lead');
    return leads.length === 1 ? leads[0]!.name : null;
  }

  async getRuntime(team: string): Promise<TeamAgentRuntimeSnapshot> {
    this.assertTeam(team);
    const roster = await this.roster(), launch = await this.launch(), updatedAt = new Date().toISOString();
    const members: TeamAgentRuntimeSnapshot['members'] = {};
    for (const member of roster.members) {
      const selected = launch?.members.find(row => row.memberId === member.memberId);
      const observed = selected?.generation ? await this.runtime(member.memberId, selected.generation) : undefined;
      const alive = observed?.phase === 'allocated' && observed.attached && !observed.sealed && observed.custody === 'owned';
      const ready = alive && observed.nativeReady && selected?.usable && selected.nativeReady;
      members[member.name] = { memberName: member.name, alive: Boolean(alive), restartable: false, updatedAt,
        ...(selected?.generation ? { runtimeGeneration: selected.generation } : {}),
        livenessKind: ready ? 'confirmed_bootstrap' : alive ? 'registered_only' :
          (!observed || observed.custody === 'released') ? 'not_found' : 'registered_only',
        ...(member.settings.providerId ?? roster.savedSettings?.providerId
          ? { providerId: member.settings.providerId ?? roster.savedSettings?.providerId } : {}) };
    }
    return { teamName: team, runId: launch?.launchId ?? null, updatedAt, members };
  }

  async isTeamAlive(team: string): Promise<boolean> {
    return Object.values((await this.getRuntime(team)).members).some(row => row.alive);
  }
  async isTeamLaunching(team: string): Promise<boolean> {
    this.assertTeam(team);
    return (await this.launch())?.members.some(row => row.status === 'pending-bootstrap') ?? false;
  }
  async isTeamBusy(team: string): Promise<boolean> {
    this.assertTeam(team);
    const launch = await this.launch();
    return launch?.members.some(row => row.status === 'unknown' || row.status === 'pending-human') ?? false;
  }
  async getMemberStatuses(team: string): Promise<MemberSpawnStatusesSnapshot> {
    const runtime = await this.getRuntime(team);
    return { runId: runtime.runId, statuses: Object.fromEntries(Object.values(runtime.members).map(row =>
      [row.memberName, { updatedAt: row.updatedAt, status: row.alive ? 'online' : row.livenessKind === 'not_found' ? 'offline' : 'error',
        launchState: row.livenessKind === 'confirmed_bootstrap' ? 'confirmed_alive' :
          row.livenessKind === 'not_found' ? 'failed_to_start' : 'runtime_pending_bootstrap' }])) };
  }
  async hasActiveOwnedTask(team: string, owner: string): Promise<boolean> {
    this.assertTeam(team);
    return (await readHostScheduleState(this.options.target)).tasks.some(row =>
      row.owner === owner && isTeamTaskActivelyWorked(row));
  }
  getPreviousRuns = (scheduleId: string, runId: string) => this.options.getPreviousRuns(scheduleId, runId);
  async getTask(team: string, taskId: string): Promise<TeamTask | null> {
    this.assertTeam(team);
    return (await readHostScheduleState(this.options.target)).tasks.find(row => row.id === taskId) ?? null;
  }
  async resolvePreviousTask(team: string, run: ScheduleRun): Promise<TeamTask | null> {
    this.assertTeam(team);
    const original = this.options.target.target;
    if (!run.hostTarget || (Object.keys(original) as (keyof typeof original)[]).some(key =>
      run.hostTarget![key] !== original[key]))
      throw new Error('Previous occurrence belongs to another captured team');
    if (run.linkedTaskId) return this.getTask(team, run.linkedTaskId);
    const commandId = run.pendingTaskCommandId ?? run.id;
    const result = await this.options.target.invoke({ operation: 'command.lookup', commandId, payload: {} });
    if (!result.ok) throw new ScheduledTaskCreationPending(commandId);
    if (result.value === null) return null;
    if (!('operation' in result.value) || result.value.operation !== 'task.create' ||
      !('phase' in result.value)) throw new Error('Original scheduled task receipt is invalid');
    if (result.value.phase === 'rejected') return null;
    if (result.value.phase !== 'completed' || !('task' in result.value) || !result.value.task)
      throw new ScheduledTaskCreationPending(commandId);
    return this.getTask(team, result.value.task.id);
  }

  private async recipient(owner: string, expected?: { runId?: string; generation?: string }): Promise<BackendTaskRecipient> {
    const roster = await this.roster(), launch = await this.launch();
    const member = roster.members.find(row => row.name === owner),
      selected = launch?.members.find(row => row.memberId === member?.memberId);
    if (!member || !launch || !selected?.generation ||
      (expected?.runId !== undefined && expected.runId !== launch.launchId) ||
      (expected?.generation !== undefined && expected.generation !== selected.generation))
      throw new Error('Scheduled recipient changed before admission');
    return { name: owner, memberId: member.memberId, runId: launch.launchId, generation: selected.generation,
      ...(this.options.taskFirst ? { requireIdle: true as const } : {}) };
  }

  async createTask(team: string, request: CreateTaskRequest,
    expected?: { runId: string; generation?: string }): Promise<TeamTask> {
    this.assertTeam(team);
    const commandId = request.command?.commandId;
    if (!commandId || commandId !== this.options.runId || !request.owner)
      throw new Error('Scheduled task identity is unavailable');
    const expectedRecipient = expected ? await this.recipient(request.owner, expected) : undefined;
    const payload: BackendOperationPayloads['task.create'] = { subject: request.subject, owner: request.owner,
      ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
      ...(request.startImmediately === undefined ? {} : { startImmediately: request.startImmediately }),
      ...(request.notifyOwner === false ? { notifyOwner: false } : {}),
      ...(expectedRecipient ? { expectedRecipient } : {}) };
    let result;
    try { result = await this.options.target.invoke({ operation: 'task.create', commandId, payload }); }
    catch { throw new ScheduledTaskCreationPending(commandId); }
    if (!result.ok) {
      if (result.outcome === 'unknown') throw new ScheduledTaskCreationPending(commandId);
      throw new Error(`Scheduled task was refused (${result.code})`);
    }
    if (!result.value || !('operation' in result.value) || result.value.operation !== 'task.create' ||
      !('phase' in result.value) || result.value.phase !== 'completed' || !('task' in result.value) || !result.value.task)
      throw new ScheduledTaskCreationPending(commandId);
    const task = await this.getTask(team, result.value.task.id);
    if (!task) throw new ScheduledTaskCreationPending(commandId);
    return task;
  }

  async startTaskByUser(team: string, taskId: string,
    admission?: { expectedOwner: string; expectedGeneration?: string; canStart: () => Promise<boolean> }) {
    this.assertTeam(team);
    if (!admission || !(await admission.canStart())) throw new Error('Scheduled recipient changed before start');
    const expectedRecipient = await this.recipient(admission.expectedOwner,
      { generation: admission.expectedGeneration });
    if (!(await admission.canStart())) throw new Error('Scheduled recipient changed before start');
    const value = await this.call('task.start', { taskId, notification: 'user', expectedRecipient }, this.id(`start:${taskId}`));
    if (!value || !('operation' in value) || value.operation !== 'task.start' || !('phase' in value) || value.phase !== 'completed')
      throw new Error('Scheduled task start awaits confirmation');
    return { notifiedOwner: 'notifiedOwner' in value && value.notifiedOwner === true };
  }

  async attachMember(team: string, name: string): Promise<void> {
    this.assertTeam(team);
    const expected = await this.recipient(name), state = await this.runtime(expected.memberId, expected.generation);
    if (state.phase !== 'unopened' || state.custody === 'unknown' || state.attached)
      throw new Error('Scheduled member cannot be attached without a manual restart');
    await this.call('runtime.open', { memberId: expected.memberId, expectedGeneration: expected.generation }, this.id(`attach:${expected.memberId}`));
  }

  async launchTeam(request: TeamLaunchRequest): Promise<TeamLaunchResponse> {
    this.assertTeam(request.teamName);
    const existing = await this.launch();
    if (await this.isTeamAlive(request.teamName)) return { runId: existing!.launchId, launchStatus: 'already_running' };
    if (await this.isTeamLaunching(request.teamName)) return { runId: existing!.launchId, launchStatus: 'already_launching' };
    if (await this.isTeamBusy(request.teamName)) throw new Error('Scheduled team launch is held');
    const roster = await this.roster();
    const replaced = await this.call('team.roster.replace', { expectedRevision: roster.revision,
      members: roster.members.filter(row => row.role !== 'lead').map(row => ({ ...row.settings, name: row.name })) }, this.id('roster'));
    if (!replaced || !('revision' in replaced) || !('commandId' in replaced) || replaced.commandId !== this.id('roster'))
      throw new Error('Scheduled roster admission awaits confirmation');
    this.rosterRevision = replaced.revision;
    const captured = await this.call('team.launch.capture', { rosterCommandId: this.id('roster') }, this.id('capture'));
    if (!captured || !('launch' in captured) || !('members' in captured)) throw new Error('Scheduled launch capture awaits confirmation');
    const view: BackendLaunchConfigurationView = captured;
    const value = await this.call('team.launch.start', { launchId: view.launch.launchId,
      rosterRevision: view.launch.rosterRevision,
      initialPrompt: request.bootstrapOnly ? null : request.prompt?.trim() || null }, this.id('launch'));
    if (!value || !('retryCapability' in value)) throw new Error('Scheduled launch awaits confirmation');
    return { runId: value.launchId, launchStatus: 'started' };
  }

  async runOneShot(request: ExecutionRequest): Promise<ScheduledTaskResult> {
    this.assertTeam(this.options.selection);
    if (!this.options.runOneShot) throw new Error('Host standalone schedule owner is unavailable');
    const roster = await this.roster();
    this.assertTeam(this.options.selection);
    return this.options.runOneShot(request, roster.revision);
  }
}
