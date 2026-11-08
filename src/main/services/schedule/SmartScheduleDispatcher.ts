/**
 * Smart schedule dispatch. Business decisions only: all runtime/process and task
 * mutations use the existing application APIs injected at composition time.
 *
 * Legacy schedules never reach this class.
 */
import type { ExecutionRequest, ScheduledTaskResult } from './ScheduledTaskExecutor';
import type {
  CreateTaskRequest,
  MemberSpawnStatusesSnapshot,
  Schedule,
  ScheduleRun,
  TeamAgentRuntimeEntry,
  TeamAgentRuntimeSnapshot,
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamTask,
} from '@shared/types';

export type SmartScheduleOutcome =
  | { kind: 'one_shot'; result: ScheduledTaskResult }
  | { kind: 'dispatched'; summary: string; taskId?: string }
  | { kind: 'skipped'; summary: string; taskId?: string };

export interface SmartScheduleRuntimePort {
  isTeamAlive(teamName: string): boolean;
  isTeamLaunching(teamName: string): boolean;
  isTeamBusy(teamName: string): boolean;
  getRuntime(teamName: string): Promise<TeamAgentRuntimeSnapshot>;
  getMemberStatuses(teamName: string): Promise<MemberSpawnStatusesSnapshot>;
  getLeadName(teamName: string): Promise<string | null>;
  getSavedRequest(teamName: string): Promise<TeamCreateRequest | null>;
  /** Required only for opt-in task-first schedules; old adapters remain compatible. */
  hasRunnableConfig?(teamName: string): Promise<boolean>;
  getPreviousRuns?(scheduleId: string, runId: string): Promise<ScheduleRun[]>;
  getTask?(teamName: string, taskId: string): Promise<TeamTask | null>;
  startTaskByUser?(teamName: string, taskId: string): Promise<{ notifiedOwner: boolean }>;
  attachMember(teamName: string, memberName: string): Promise<void>;
  createTask(teamName: string, request: CreateTaskRequest): Promise<TeamTask>;
  launchTeam(request: TeamLaunchRequest): Promise<TeamLaunchResponse>;
  runOneShot(request: ExecutionRequest): Promise<ScheduledTaskResult>;
}

const READY_KINDS = new Set(['confirmed_bootstrap', 'runtime_process']);
const ABSENT_KINDS = new Set(['not_found', 'registered_only']);
// Slow local-model and Windows process boots may take longer than a few seconds.
const READY_CHECK_ATTEMPTS = 45;
const READY_CHECK_DELAY_MS = 2000;

function readyMember(entry: TeamAgentRuntimeEntry | undefined): boolean {
  if (!entry?.alive) return false;
  // Non-OpenCode leads are tracked by the authoritative live process rather
  // than an optional teammate livenessKind (which is absent in their snapshot).
  if (entry.backendType === 'lead') {
    return entry.pidSource === 'lead_process' && Number.isSafeInteger(entry.pid) && (entry.pid ?? 0) > 0;
  }
  return Boolean(entry.livenessKind && READY_KINDS.has(entry.livenessKind));
}

function skipped(reason: string, taskId?: string): SmartScheduleOutcome {
  return { kind: 'skipped', summary: reason, ...(taskId ? { taskId } : {}) };
}

function teamLaunchRequest(saved: TeamCreateRequest, prompt: string): TeamLaunchRequest {
  return {
    teamName: saved.teamName,
    cwd: saved.cwd,
    prompt,
    runtimeSelectionVersion: saved.runtimeSelectionVersion,
    providerId: saved.providerId,
    providerBackendId: saved.providerBackendId,
    model: saved.model,
    effort: saved.effort,
    fastMode: saved.fastMode,
    syncModelsWithLead: saved.syncModelsWithLead,
    limitContext: saved.limitContext,
    skipPermissions: saved.skipPermissions,
    worktree: saved.worktree,
    extraCliArgs: saved.extraCliArgs,
  };
}

export class SmartScheduleDispatcher {
  /** Prevent concurrent automatic mutations of the same team's runtime/task board. */
  private readonly dispatchingTeams = new Set<string>();

  constructor(private readonly runtime: SmartScheduleRuntimePort) {}

  async dispatch(
    schedule: Schedule,
    runId: string,
    isCancelled: () => boolean
  ): Promise<SmartScheduleOutcome> {
    if (!schedule.executionMode) {
      throw new Error('Legacy schedule must use the original one-shot executor');
    }
    if (schedule.executionMode !== 'agent' && schedule.executionMode !== 'team') {
      throw new Error('Unsupported schedule execution mode');
    }
    if (!schedule.launchConfig.prompt.trim()) {
      return skipped('Scheduled instructions are empty; no action was submitted');
    }
    const team = schedule.teamName;
    if (this.dispatchingTeams.has(team)) {
      return skipped('Another schedule is already dispatching this team');
    }
    this.dispatchingTeams.add(team);
    try {
      if (isCancelled()) return skipped('Schedule was cancelled');
      if (this.runtime.isTeamLaunching(team)) {
        return skipped('Team is launching; no duplicate launch or task was submitted');
      }
      if (this.runtime.isTeamBusy(team)) {
        return skipped('Team lifecycle operation in progress; no work was submitted');
      }
      if (schedule.taskFirst) {
        return await this.dispatchTaskFirst(schedule, runId, isCancelled);
      }
      if (!this.runtime.isTeamAlive(team)) {
        if (isCancelled() || this.runtime.isTeamLaunching(team) || this.runtime.isTeamBusy(team) || this.runtime.isTeamAlive(team)) {
          return skipped('Team state changed while scheduling; no action was submitted');
        }
        if (schedule.executionMode === 'agent') {
          const result = await this.runtime.runOneShot({
            runId,
            config: schedule.launchConfig,
            maxTurns: schedule.maxTurns,
            maxBudgetUsd: schedule.maxBudgetUsd,
          });
          return { kind: 'one_shot', result };
        }
        const saved = await this.runtime.getSavedRequest(team);
        if (!saved?.cwd || !saved.providerId) {
          return skipped('Team launch settings are missing or the provider is not selected');
        }
        if (isCancelled() || this.runtime.isTeamLaunching(team) || this.runtime.isTeamBusy(team) || this.runtime.isTeamAlive(team)) {
          return skipped('Team launch state changed; no duplicate launch was submitted');
        }
        // Launch has its own per-team admission. The prompt is sent by that launch
        // path; sending another inbox message here would execute it twice.
        const result = await this.runtime.launchTeam(
          teamLaunchRequest(saved, schedule.launchConfig.prompt.trim())
        );
        if (result.launchStatus === 'already_running' || result.alreadyRunning) {
          return await this.dispatchToLiveTeam(schedule, runId, isCancelled);
        }
        if (result.launchStatus === 'already_launching' || result.alreadyLaunching) {
          return skipped('Another team launch is already underway');
        }
        return {
          kind: 'dispatched',
          summary: 'Team launch requested with scheduled instructions; bootstrap/work not yet verified',
        };
      }
      return await this.dispatchToLiveTeam(schedule, runId, isCancelled);
    } finally {
      this.dispatchingTeams.delete(team);
    }
  }

  private async dispatchTaskFirst(
    schedule: Schedule,
    runId: string,
    isCancelled: () => boolean
  ): Promise<SmartScheduleOutcome> {
    const { getPreviousRuns, getTask, hasRunnableConfig, startTaskByUser } = this.runtime;
    if (!getPreviousRuns || !getTask || !hasRunnableConfig || !startTaskByUser) {
      return skipped('Task-first scheduling is unavailable in this runtime');
    }

    // A crash may leave a task without a linked receipt, and skipped occurrences
    // have no task at all. Examine bounded run history, never just the latest tick.
    const priorRuns = await getPreviousRuns(schedule.id, runId);
    const seenTasks = new Set<string>();
    for (const previous of priorRuns) {
      const taskId = previous.linkedTaskId ?? previous.id;
      if (seenTasks.has(taskId)) continue;
      seenTasks.add(taskId);
      const prior = await getTask(schedule.teamName, taskId);
      if (prior && prior.status !== 'completed' && prior.status !== 'deleted') {
        return skipped(`Previous task #${prior.displayId || prior.id} is still active`, prior.id);
      }
    }
    if (isCancelled() || this.runtime.isTeamBusy(schedule.teamName)) {
      return skipped('Team lifecycle changed before task assignment');
    }

    // The live case keeps the already-proven readiness/attach gates and task
    // command identity; only the stopped case needs task-first bootstrap.
    if (this.runtime.isTeamAlive(schedule.teamName)) {
      return this.dispatchToLiveTeam(schedule, runId, isCancelled);
    }
    const saved = await this.runtime.getSavedRequest(schedule.teamName);
    if (!saved?.cwd || !saved.providerId || !(await hasRunnableConfig(schedule.teamName))) {
      return skipped('Finish team setup before assigning scheduled work');
    }
    if (saved.prompt?.trim()) {
      return skipped('Review historical team instructions before enabling task-first launch');
    }
    const leadName = await this.runtime.getLeadName(schedule.teamName);
    if (!leadName) return skipped('Team lead cannot be resolved');
    const selected = schedule.executionMode === 'team' ? leadName : schedule.targetMember?.trim();
    const owner = selected?.toLowerCase() === leadName.toLowerCase() ? leadName : selected || leadName;
    if (owner !== leadName && !saved.members.some((member) => member.name === owner)) {
      return skipped(`Member "${owner}" is not configured in this team`);
    }

    // A pending board task is the durable source of truth. No bootstrap prompt
    // contains this work and no task is automatically retried after a lost ACK.
    const prompt = schedule.launchConfig.prompt.trim();
    const task = await this.runtime.createTask(schedule.teamName, {
      command: { commandId: runId, idempotencyKey: `schedule:${runId}` },
      subject: (schedule.label?.trim() || prompt.replace(/\s+/g, ' ').slice(0, 100)).slice(0, 120),
      prompt,
      owner,
      startImmediately: false,
    });
    if (
      isCancelled() ||
      this.runtime.isTeamLaunching(schedule.teamName) ||
      this.runtime.isTeamBusy(schedule.teamName) ||
      this.runtime.isTeamAlive(schedule.teamName)
    ) {
      return skipped('Task saved; team state changed before launch', task.id);
    }

    let launched: TeamLaunchResponse;
    try {
      launched = await this.runtime.launchTeam({
        ...teamLaunchRequest(saved, ''),
        prompt: undefined,
        bootstrapOnly: true,
      });
    } catch {
      return skipped('Task saved; team launch failed. Inspect the team before retrying', task.id);
    }
    if (launched.launchStatus === 'already_launching' || launched.alreadyLaunching) {
      return skipped('Task saved; another launch is already underway', task.id);
    }
    const ready = await this.waitForMember(
      schedule.teamName,
      owner,
      launched.runId,
      isCancelled,
      true
    );
    if (!ready || isCancelled() || this.runtime.isTeamBusy(schedule.teamName)) {
      return skipped('Task saved; selected agent did not become ready', task.id);
    }
    try {
      await startTaskByUser(schedule.teamName, task.id);
    } catch {
      return skipped('Task saved; start acknowledgement is uncertain. Inspect the task', task.id);
    }
    return {
      kind: 'dispatched',
      taskId: task.id,
      summary: `Task #${task.displayId || task.id} start requested for ${owner}; agent work not yet verified`,
    };
  }

  private async dispatchToLiveTeam(
    schedule: Schedule,
    runId: string,
    isCancelled: () => boolean
  ): Promise<SmartScheduleOutcome> {
    const team = schedule.teamName;
    if (this.runtime.isTeamBusy(team)) {
      return skipped('Team lifecycle operation in progress; no task was submitted');
    }
    const runtime = await this.runtime.getRuntime(team);
    if (!runtime.runId || !this.runtime.isTeamAlive(team)) {
      return skipped('Team runtime is not confirmed running');
    }
    const leadName = await this.runtime.getLeadName(team);
    if (!leadName) return skipped('Team lead cannot be resolved');
    const requestedMember =
      schedule.executionMode === 'team'
        ? leadName
        : schedule.targetMember?.trim() || leadName;
    // Only the lead is case-insensitive; teammate identities stay exact.
    const memberName =
      requestedMember.toLowerCase() === leadName.toLowerCase() ? leadName : requestedMember;
    const saved = await this.runtime.getSavedRequest(team);
    const configured = memberName === leadName || saved?.members.some((m) => m.name === memberName);
    if (!configured) return skipped(`Member "${memberName}" is not configured in this team`);

    const entry = runtime.members[memberName];
    if (!readyMember(entry)) {
      if (schedule.executionMode === 'team' || memberName === leadName) {
        return skipped('Team lead is not ready; no task was created');
      }
      // Only attach a *confirmed absent* configured teammate. Never use the
      // destructive manual restart path or interpret stale/process candidates
      // as offline. The existing lifecycle admission rejects concurrent starts.
      // OpenCode lane "reattach" can terminate an existing session when its
      // separate evidence store still sees a lane. A schedule must never perform
      // that destructive operation after only a best-effort liveness read.
      const configuredMember = saved?.members.find((member) => member.name === memberName);
      const providerId = entry?.providerId ?? configuredMember?.providerId ?? saved?.providerId;
      if (providerId === 'opencode' || entry?.laneKind === 'secondary') {
        return skipped('Automatic attach of this runtime lane is not safe; start the member manually');
      }
      const statuses = await this.runtime.getMemberStatuses(team);
      const memberStatus = statuses.statuses[memberName];
      if (
        !statuses.runId ||
        statuses.runId !== runtime.runId ||
        memberStatus?.status !== 'offline' ||
        (entry && (entry.alive || !entry.livenessKind || !ABSENT_KINDS.has(entry.livenessKind)))
      ) {
        return skipped(`Member "${memberName}" is not safely confirmed offline`);
      }
      if (isCancelled() || this.runtime.isTeamBusy(team) || !this.runtime.isTeamAlive(team)) {
        return skipped('Team stopped or changed before member attach');
      }
      await this.runtime.attachMember(team, memberName);
      const ready = await this.waitForMember(team, memberName, runtime.runId, isCancelled);
      if (!ready) return skipped(`Member "${memberName}" did not become ready`);
    }

    // A check immediately before the irreversible task mutation; the task
    // command's idempotency key prevents duplicate task creation on retries.
    const fresh = await this.runtime.getRuntime(team);
    if (
      isCancelled() ||
      this.runtime.isTeamBusy(team) ||
      !this.runtime.isTeamAlive(team) ||
      fresh.runId !== runtime.runId ||
      !readyMember(fresh.members[memberName])
    ) {
      return skipped('Runtime changed before task creation');
    }
    const prompt = schedule.launchConfig.prompt.trim();
    const task = await this.runtime.createTask(team, {
      command: {
        // The existing command ledger requires a UUID; runId is generated with randomUUID().
        commandId: runId,
        idempotencyKey: `schedule:${runId}`,
      },
      subject: (schedule.label?.trim() || prompt.replace(/\s+/g, ' ').slice(0, 100)).slice(0, 120),
      prompt,
      owner: memberName,
      startImmediately: true,
    });
    return {
      kind: 'dispatched',
      taskId: task.id,
      summary: `Task #${task.displayId || task.id} assigned to ${memberName}; work completion not yet verified`,
    };
  }

  private async waitForMember(
    teamName: string,
    memberName: string,
    expectedRunId: string,
    isCancelled: () => boolean,
    allowStarting = false
  ): Promise<boolean> {
    for (let i = 0; i < READY_CHECK_ATTEMPTS; i++) {
      if (isCancelled()) return false;
      const alive = this.runtime.isTeamAlive(teamName);
      if (!alive && !(allowStarting && this.runtime.isTeamLaunching(teamName))) return false;
      const current = await this.runtime.getRuntime(teamName);
      if (current.runId !== expectedRunId && (!allowStarting || current.runId)) return false;
      if (alive && current.runId === expectedRunId && readyMember(current.members[memberName])) {
        return true;
      }
      if (i + 1 < READY_CHECK_ATTEMPTS) {
        await new Promise<void>((resolve) => setTimeout(resolve, READY_CHECK_DELAY_MS));
      }
    }
    return false;
  }
}
