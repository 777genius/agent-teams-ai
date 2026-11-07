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
  TeamAgentRuntimeEntry,
  TeamAgentRuntimeSnapshot,
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamTask,
} from '@shared/types';

export type SmartScheduleOutcome =
  | { kind: 'one_shot'; result: ScheduledTaskResult }
  | { kind: 'dispatched'; summary: string }
  | { kind: 'skipped'; summary: string };

export interface SmartScheduleRuntimePort {
  isTeamAlive(teamName: string): boolean;
  isTeamLaunching(teamName: string): boolean;
  getRuntime(teamName: string): Promise<TeamAgentRuntimeSnapshot>;
  getMemberStatuses(teamName: string): Promise<MemberSpawnStatusesSnapshot>;
  getLeadName(teamName: string): Promise<string | null>;
  getSavedRequest(teamName: string): Promise<TeamCreateRequest | null>;
  attachMember(teamName: string, memberName: string): Promise<void>;
  createTask(teamName: string, request: CreateTaskRequest): Promise<TeamTask>;
  launchTeam(request: TeamLaunchRequest): Promise<TeamLaunchResponse>;
  runOneShot(request: ExecutionRequest): Promise<ScheduledTaskResult>;
}

const READY_KINDS = new Set(['confirmed_bootstrap', 'runtime_process']);
const ABSENT_KINDS = new Set(['not_found', 'registered_only']);
const READY_CHECK_ATTEMPTS = 10;
const READY_CHECK_DELAY_MS = 1000;

function readyMember(entry: TeamAgentRuntimeEntry | undefined): boolean {
  return Boolean(entry?.alive && entry.livenessKind && READY_KINDS.has(entry.livenessKind));
}

function skipped(reason: string): SmartScheduleOutcome {
  return { kind: 'skipped', summary: reason };
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
      if (!this.runtime.isTeamAlive(team)) {
        if (isCancelled() || this.runtime.isTeamLaunching(team) || this.runtime.isTeamAlive(team)) {
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
        if (isCancelled() || this.runtime.isTeamLaunching(team) || this.runtime.isTeamAlive(team)) {
          return skipped('Team launch state changed; no duplicate launch was submitted');
        }
        // Launch has its own per-team admission. The prompt is sent by that launch
        // path; sending another inbox message here would execute it twice.
        const result = await this.runtime.launchTeam(
          teamLaunchRequest(saved, schedule.launchConfig.prompt)
        );
        if (result.launchStatus === 'already_running' || result.alreadyRunning) {
          return this.dispatchToLiveTeam(schedule, runId, isCancelled);
        }
        if (result.launchStatus === 'already_launching' || result.alreadyLaunching) {
          return skipped('Another team launch is already underway');
        }
        return {
          kind: 'dispatched',
          summary: 'Team launch requested with scheduled instructions; bootstrap/work not yet verified',
        };
      }
      return this.dispatchToLiveTeam(schedule, runId, isCancelled);
    } finally {
      this.dispatchingTeams.delete(team);
    }
  }

  private async dispatchToLiveTeam(
    schedule: Schedule,
    runId: string,
    isCancelled: () => boolean
  ): Promise<SmartScheduleOutcome> {
    const team = schedule.teamName;
    const runtime = await this.runtime.getRuntime(team);
    if (!runtime.runId || !this.runtime.isTeamAlive(team)) {
      return skipped('Team runtime is not confirmed running');
    }
    const leadName = await this.runtime.getLeadName(team);
    if (!leadName) return skipped('Team lead cannot be resolved');
    const memberName =
      schedule.executionMode === 'team'
        ? leadName
        : schedule.targetMember?.trim() || leadName;
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
      if (isCancelled() || !this.runtime.isTeamAlive(team)) {
        return skipped('Team stopped before member attach');
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
      subject: (schedule.label?.trim() || prompt.slice(0, 100)).slice(0, 120),
      prompt,
      owner: memberName,
      startImmediately: true,
    });
    return {
      kind: 'dispatched',
      summary: `Task #${task.displayId || task.id} assigned to ${memberName}; work completion not yet verified`,
    };
  }

  private async waitForMember(
    teamName: string,
    memberName: string,
    expectedRunId: string,
    isCancelled: () => boolean
  ): Promise<boolean> {
    for (let i = 0; i < READY_CHECK_ATTEMPTS; i++) {
      if (isCancelled() || !this.runtime.isTeamAlive(teamName)) return false;
      const current = await this.runtime.getRuntime(teamName);
      if (current.runId !== expectedRunId) return false;
      if (readyMember(current.members[memberName])) return true;
      if (i + 1 < READY_CHECK_ATTEMPTS) {
        await new Promise<void>((resolve) => setTimeout(resolve, READY_CHECK_DELAY_MS));
      }
    }
    return false;
  }
}
