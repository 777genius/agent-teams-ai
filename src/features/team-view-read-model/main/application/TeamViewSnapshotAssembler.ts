import { getMemberColorByName } from '@shared/constants/memberColors';
import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { isLeadMember } from '@shared/utils/leadDetection';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';

import type {
  KanbanState,
  PersistedTeamLaunchSnapshot,
  ProviderModelLaunchIdentity,
  TaskChangePresenceState,
  TeamConfig,
  TeamFastMode,
  TeamGetDataOptions,
  TeamMember,
  TeamMemberSnapshot,
  TeamProcess,
  TeamProviderBackendId,
  TeamProviderId,
  TeamTask,
  TeamTaskWithKanban,
  TeamViewSnapshot,
} from '@shared/types';

const MEMBER_RUNTIME_ADVISORY_SNAPSHOT_BUDGET_MS = 250;
const MEMBER_BRANCH_TIMEOUT_MS = 2_000;
const SLOW_SNAPSHOT_THRESHOLD_MS = 1_500;

export interface TeamViewSnapshotRuntimeMeta {
  cwd?: string;
  providerId?: TeamProviderId;
  providerBackendId?: string;
  model?: string;
  effort?: string;
  fastMode?: TeamFastMode;
  launchIdentity?: ProviderModelLaunchIdentity;
}

export interface TeamViewTaskChangeLogSourceSnapshot {
  projectFingerprint: string | null;
  logSourceGeneration: string | null;
}

export interface TeamViewMemberResolutionOptions {
  launchSnapshot?: PersistedTeamLaunchSnapshot | null;
  leadProviderId?: TeamProviderId;
  leadProviderBackendId?: TeamProviderBackendId | null;
  leadFastMode?: TeamMember['fastMode'];
  leadResolvedFastMode?: boolean | null;
}

export interface TeamViewTaskChangePresenceRead<
  TPresenceIndex,
  TLogSourceSnapshot extends TeamViewTaskChangeLogSourceSnapshot,
> {
  enabled: boolean;
  logSourceSnapshot: TLogSourceSnapshot | null;
  presenceIndex: Promise<TPresenceIndex | null>;
}

export interface TeamViewSnapshotAssemblerPorts<
  TPresenceIndex,
  TLogSourceSnapshot extends TeamViewTaskChangeLogSourceSnapshot,
> {
  readConfig(teamName: string): Promise<TeamConfig | null>;
  readTasks(teamName: string): Promise<readonly TeamTask[]>;
  readInboxNames(teamName: string): Promise<string[]>;
  readMembersMeta(teamName: string): Promise<TeamConfig['members']>;
  readTeamMeta(teamName: string): Promise<TeamViewSnapshotRuntimeMeta | null>;
  readLaunchSnapshot(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  readKanbanState(teamName: string): Promise<KanbanState>;
  startTaskChangePresenceRead(
    teamName: string
  ): TeamViewTaskChangePresenceRead<TPresenceIndex, TLogSourceSnapshot>;
  projectTaskWithKanban(
    task: TeamTask,
    kanbanTaskState?: KanbanState['tasks'][string]
  ): TeamTaskWithKanban;
  projectTaskChangePresence(
    tasks: readonly TeamTaskWithKanban[],
    presenceIndex: TPresenceIndex | null,
    logSourceSnapshot: TLogSourceSnapshot | null
  ): Record<string, TaskChangePresenceState>;
  resolveMembers(
    config: TeamConfig,
    metaMembers: TeamConfig['members'],
    inboxNames: string[],
    tasks: TeamTaskWithKanban[],
    options: TeamViewMemberResolutionOptions
  ): TeamMemberSnapshot[];
  readMemberRuntimeAdvisories(
    teamName: string,
    members: readonly Pick<TeamMemberSnapshot, 'name' | 'removedAt'>[],
    observedAfterMs: number | null
  ): Promise<Map<string, NonNullable<TeamMemberSnapshot['runtimeAdvisory']>>>;
  resolveGitBranch(cwd: string): Promise<string | null>;
  memberBranchConcurrency: number;
  readProcesses(teamName: string): Promise<TeamProcess[]>;
  selectCurrentActiveTask(tasks: readonly TeamTaskWithKanban[]): TeamTaskWithKanban | null;
  compactTask(task: TeamTaskWithKanban): TeamTaskWithKanban;
  logDebug(message: string): void;
  logWarning(message: string): void;
  now?(): number;
}

interface ReadStepResult<T> {
  value: T;
  warning?: string;
  completedAt: number;
}

interface SnapshotMarks {
  [label: string]: number | undefined;
}

function isExplicitLeadRole(role: string | undefined): boolean {
  const normalized = role?.trim().toLowerCase();
  return normalized === 'lead' || normalized === 'team lead' || normalized === 'team-lead';
}

function hasVisibleLeadMember(members: readonly TeamMemberSnapshot[]): boolean {
  return members.some((member) => {
    if (isLeadMember(member)) {
      return true;
    }
    const normalizedName = member.name.trim().toLowerCase();
    return normalizedName === 'lead' || isExplicitLeadRole(member.role);
  });
}

function hasExplicitLeadInConfig(config: TeamConfig): boolean {
  return (config.members ?? []).some((member) => {
    if (isLeadMember(member)) {
      return true;
    }
    const normalizedName = member.name?.trim().toLowerCase() ?? '';
    return normalizedName === 'lead' || isExplicitLeadRole(member.role);
  });
}

/** Main-process application service that assembles a team view through owned ports. */
export class TeamViewSnapshotAssembler<
  TPresenceIndex,
  TLogSourceSnapshot extends TeamViewTaskChangeLogSourceSnapshot,
> {
  constructor(
    private readonly ports: TeamViewSnapshotAssemblerPorts<TPresenceIndex, TLogSourceSnapshot>
  ) {}

  async getTeamData(teamName: string, options?: TeamGetDataOptions): Promise<TeamViewSnapshot> {
    const includeMemberBranches = options?.includeMemberBranches !== false;
    const startedAt = this.now();
    const marks: SnapshotMarks = {};
    const mark = (label: string): void => {
      marks[label] = this.now();
    };
    const msSince = (label: string): number => {
      const timestamp = marks[label];
      return typeof timestamp === 'number' ? timestamp - startedAt : -1;
    };
    const msBetween = (from: string, to: string): number => {
      const fromTimestamp = marks[from];
      const toTimestamp = marks[to];
      return typeof fromTimestamp === 'number' && typeof toTimestamp === 'number'
        ? toTimestamp - fromTimestamp
        : -1;
    };

    const config = await this.ports.readConfig(teamName);
    if (!config) {
      throw new Error(`Team not found: ${teamName}`);
    }
    mark('config');

    const warnings: string[] = [];
    const startReadStep = <T>(step: {
      createFallback: () => T;
      warningText: string;
      load: () => Promise<T>;
    }): Promise<ReadStepResult<T>> =>
      (async () => {
        try {
          return {
            value: await step.load(),
            completedAt: this.now(),
          };
        } catch {
          return {
            value: step.createFallback(),
            warning: step.warningText,
            completedAt: this.now(),
          };
        }
      })();
    const runWithConcurrencyLimit = this.createConcurrencyLimiter(2);
    const presenceRead = this.ports.startTaskChangePresenceRead(teamName);

    const inboxNamesStep = startReadStep({
      createFallback: () => [],
      warningText: 'Inboxes failed to load',
      load: () => this.ports.readInboxNames(teamName),
    });
    const metaMembersStep = startReadStep({
      createFallback: () => [],
      warningText: 'Member metadata failed to load',
      load: () => this.ports.readMembersMeta(teamName),
    });
    const teamMetaStep = startReadStep({
      createFallback: () => null,
      warningText: 'Team runtime metadata failed to load',
      load: () => this.ports.readTeamMeta(teamName),
    });
    const launchStateStep = startReadStep({
      createFallback: () => null,
      warningText: 'Launch state failed to load',
      load: () => this.ports.readLaunchSnapshot(teamName),
    });
    const kanbanStateStep = startReadStep({
      createFallback: (): KanbanState => ({
        teamName,
        reviewers: [],
        tasks: {},
      }),
      warningText: 'Kanban state failed to load',
      load: () => this.ports.readKanbanState(teamName),
    });
    const tasksStep = runWithConcurrencyLimit(() =>
      startReadStep({
        createFallback: () => [],
        warningText: 'Tasks failed to load',
        load: () => this.ports.readTasks(teamName),
      })
    );

    const [
      tasksStepResult,
      inboxNamesStepResult,
      metaMembersStepResult,
      teamMetaStepResult,
      launchStateStepResult,
      kanbanStateStepResult,
    ] = await Promise.all([
      tasksStep,
      inboxNamesStep,
      metaMembersStep,
      teamMetaStep,
      launchStateStep,
      kanbanStateStep,
    ]);

    marks.tasks = tasksStepResult.completedAt;
    marks.inboxNames = inboxNamesStepResult.completedAt;
    marks.metaMembers = metaMembersStepResult.completedAt;
    marks.teamMeta = teamMetaStepResult.completedAt;
    marks.launchState = launchStateStepResult.completedAt;
    marks.kanbanState = kanbanStateStepResult.completedAt;

    for (const result of [
      tasksStepResult,
      inboxNamesStepResult,
      metaMembersStepResult,
      teamMetaStepResult,
      launchStateStepResult,
      kanbanStateStepResult,
    ]) {
      if (result.warning) {
        warnings.push(result.warning);
      }
    }

    const tasks = tasksStepResult.value;
    const inboxNames = inboxNamesStepResult.value;
    const metaMembers = metaMembersStepResult.value;
    const teamMeta = teamMetaStepResult.value;
    const launchSnapshot = launchStateStepResult.value;
    const kanbanState = kanbanStateStepResult.value;
    mark('postStart');
    mark('kanbanGc');

    const tasksWithKanbanBase = tasks.map((task) =>
      this.ports.projectTaskWithKanban(task, kanbanState.tasks[task.id])
    );
    mark('attachKanban');

    const presenceIndex = await presenceRead.presenceIndex;
    mark('loadPresenceIndex');
    const tasksWithKanban = this.projectTaskPresence(
      tasksWithKanbanBase,
      presenceRead,
      presenceIndex
    );
    mark('changePresence');

    const members = this.resolveMembers(
      config,
      metaMembers,
      inboxNames,
      tasksWithKanban,
      teamMeta,
      launchSnapshot
    );
    await this.synthesizeLeadMemberIfMissing(config, members, tasksWithKanban, teamMeta);
    mark('resolveMembers');

    await this.attachRuntimeAdvisories(teamName, members, launchSnapshot, warnings);
    mark('runtimeAdvisories');

    if (includeMemberBranches) {
      await this.enrichMemberBranches(members, config);
    }
    mark('enrichBranches');
    mark('syncComments');

    let processes: TeamProcess[] = [];
    try {
      processes = await this.ports.readProcesses(teamName);
    } catch {
      warnings.push('Processes failed to load');
    }
    mark('processes');

    const isAlive = processes.some((process) => !process.stoppedAt);
    this.logSlowSnapshot({
      teamName,
      includeMemberBranches,
      startedAt,
      tasksCount: tasks.length,
      inboxNamesCount: inboxNames.length,
      membersCount: members.length,
      processesCount: processes.length,
      warnings,
      msSince,
      msBetween,
    });

    return {
      teamName,
      config,
      tasks: tasksWithKanban.map((task) => this.ports.compactTask(task)),
      members,
      kanbanState,
      processes,
      isAlive,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  private createConcurrencyLimiter(limit: number) {
    let active = 0;
    const queue: Array<() => void> = [];
    const releaseNext = (): void => {
      if (active >= limit) return;
      queue.shift()?.();
    };

    return <T>(start: () => Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const run = (): void => {
          active += 1;
          void start()
            .then(resolve, reject)
            .finally(() => {
              active = Math.max(0, active - 1);
              releaseNext();
            });
        };
        if (active < limit) {
          run();
        } else {
          queue.push(run);
        }
      });
  }

  private projectTaskPresence(
    tasks: TeamTaskWithKanban[],
    presenceRead: TeamViewTaskChangePresenceRead<TPresenceIndex, TLogSourceSnapshot>,
    presenceIndex: TPresenceIndex | null
  ): TeamTaskWithKanban[] {
    if (!presenceRead.enabled) {
      return tasks;
    }
    const presenceById = this.ports.projectTaskChangePresence(
      tasks,
      presenceIndex,
      presenceRead.logSourceSnapshot
    );
    return tasks.map((task) => ({
      ...task,
      changePresence: presenceById[task.id] ?? 'unknown',
    }));
  }

  private resolveMembers(
    config: TeamConfig,
    metaMembers: TeamConfig['members'],
    inboxNames: string[],
    tasks: TeamTaskWithKanban[],
    teamMeta: TeamViewSnapshotRuntimeMeta | null,
    launchSnapshot: PersistedTeamLaunchSnapshot | null
  ): TeamMemberSnapshot[] {
    const launchIdentity = teamMeta?.launchIdentity;
    const leadProviderBackendId = launchIdentity
      ? (migrateProviderBackendId(
          launchIdentity.providerId,
          launchIdentity.providerBackendId ?? teamMeta?.providerBackendId
        ) ?? undefined)
      : (migrateProviderBackendId(teamMeta?.providerId, teamMeta?.providerBackendId) ?? undefined);

    return this.ports.resolveMembers(config, metaMembers, inboxNames, tasks, {
      launchSnapshot,
      leadProviderId: launchIdentity?.providerId ?? teamMeta?.providerId,
      leadProviderBackendId,
      leadFastMode: launchIdentity?.selectedFastMode ?? teamMeta?.fastMode ?? undefined,
      leadResolvedFastMode:
        typeof launchIdentity?.resolvedFastMode === 'boolean'
          ? launchIdentity.resolvedFastMode
          : undefined,
    });
  }

  private synthesizeLeadMemberIfMissing(
    config: TeamConfig,
    members: TeamMemberSnapshot[],
    tasks: TeamTaskWithKanban[],
    teamMeta: TeamViewSnapshotRuntimeMeta | null
  ): Promise<void> {
    if (hasVisibleLeadMember(members) || hasExplicitLeadInConfig(config)) {
      return Promise.resolve();
    }

    const launchIdentity = teamMeta?.launchIdentity;
    const providerBackendId = launchIdentity
      ? (migrateProviderBackendId(
          launchIdentity.providerId,
          launchIdentity.providerBackendId ?? teamMeta?.providerBackendId
        ) ?? undefined)
      : (migrateProviderBackendId(teamMeta?.providerId, teamMeta?.providerBackendId) ?? undefined);
    const leadName = 'team-lead';
    const ownedTasks = tasks.filter((task) => task.owner === leadName);
    const currentTask = this.ports.selectCurrentActiveTask(ownedTasks);

    members.unshift({
      name: leadName,
      agentId: undefined,
      currentTaskId: currentTask?.id ?? null,
      taskCount: ownedTasks.length,
      color: getMemberColorByName(leadName),
      agentType: 'team-lead',
      role: 'Team Lead',
      workflow: undefined,
      isolation: undefined,
      providerId: launchIdentity?.providerId ?? teamMeta?.providerId,
      providerBackendId,
      model:
        launchIdentity?.resolvedLaunchModel ?? launchIdentity?.selectedModel ?? teamMeta?.model,
      effort:
        launchIdentity?.resolvedEffort ??
        launchIdentity?.selectedEffort ??
        (isTeamEffortLevel(teamMeta?.effort) ? teamMeta.effort : undefined),
      selectedFastMode: launchIdentity?.selectedFastMode ?? teamMeta?.fastMode ?? undefined,
      resolvedFastMode:
        typeof launchIdentity?.resolvedFastMode === 'boolean'
          ? launchIdentity.resolvedFastMode
          : undefined,
      laneId: 'primary',
      laneKind: 'primary',
      laneOwnerProviderId: launchIdentity?.providerId ?? teamMeta?.providerId ?? 'anthropic',
      cwd: config.projectPath ?? teamMeta?.cwd,
      removedAt: undefined,
    });
    return Promise.resolve();
  }

  private async attachRuntimeAdvisories(
    teamName: string,
    members: TeamMemberSnapshot[],
    launchSnapshot: PersistedTeamLaunchSnapshot | null,
    warnings: string[]
  ): Promise<void> {
    try {
      const request = this.ports.readMemberRuntimeAdvisories(
        teamName,
        members,
        this.getRuntimeAdvisoryObservedAfterMs(launchSnapshot)
      );
      const timeoutToken = Symbol('member-runtime-advisory-timeout');
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<typeof timeoutToken>((resolve) => {
        timeoutHandle = setTimeout(
          resolve,
          MEMBER_RUNTIME_ADVISORY_SNAPSHOT_BUDGET_MS,
          timeoutToken
        );
      });

      let result: Awaited<typeof request> | typeof timeoutToken;
      try {
        result = await Promise.race([request, timeout]);
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }

      if (result === timeoutToken) {
        request.catch(() => {
          // A timed-out advisory refresh remains best-effort in the background.
        });
        this.ports.logDebug(
          `getTeamData team=${teamName} member runtime advisories exceeded ${MEMBER_RUNTIME_ADVISORY_SNAPSHOT_BUDGET_MS}ms budget; continuing without advisories for this snapshot`
        );
        return;
      }

      for (const member of members) {
        const advisory = result.get(member.name);
        if (advisory) {
          member.runtimeAdvisory = advisory;
        }
      }
    } catch {
      warnings.push('Member runtime advisories failed to load');
    }
  }

  private getRuntimeAdvisoryObservedAfterMs(
    launchSnapshot: PersistedTeamLaunchSnapshot | null
  ): number | null {
    if (!launchSnapshot) {
      return null;
    }
    const candidates = [
      launchSnapshot.updatedAt,
      ...Object.values(launchSnapshot.members).flatMap((member) => [
        member.lastEvaluatedAt,
        member.firstSpawnAcceptedAt,
        member.lastHeartbeatAt,
      ]),
    ];
    const validTimes = candidates
      .map((value) => (typeof value === 'string' ? Date.parse(value) : Number.NaN))
      .filter((value) => Number.isFinite(value) && value > 0);
    return validTimes.length > 0 ? Math.min(...validTimes) : null;
  }

  private async enrichMemberBranches(
    members: TeamMemberSnapshot[],
    config: TeamConfig
  ): Promise<void> {
    const leadEntry = config.members?.find((member) => isLeadMember(member));
    const leadCwd = leadEntry?.cwd ?? config.projectPath;
    if (!leadCwd) return;

    let leadBranch: string | null = null;
    try {
      leadBranch = await this.withTimeout(
        this.ports.resolveGitBranch(leadCwd),
        MEMBER_BRANCH_TIMEOUT_MS
      );
    } catch {
      return;
    }

    const candidates = members.filter((member) => member.cwd && member.cwd !== leadCwd);
    if (candidates.length === 0) return;

    const concurrency = Math.max(1, this.ports.memberBranchConcurrency);
    for (let index = 0; index < candidates.length; index += concurrency) {
      const batch = candidates.slice(index, index + concurrency);
      await Promise.all(
        batch.map(async (member) => {
          if (!member.cwd) return;
          try {
            const branch = await this.withTimeout(
              this.ports.resolveGitBranch(member.cwd),
              MEMBER_BRANCH_TIMEOUT_MS
            );
            if (branch && branch !== leadBranch) {
              member.gitBranch = branch;
            }
          } catch {
            // Member cwd may not be a git repo.
          }
        })
      );
    }
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), ms);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private logSlowSnapshot(input: {
    teamName: string;
    includeMemberBranches: boolean;
    startedAt: number;
    tasksCount: number;
    inboxNamesCount: number;
    membersCount: number;
    processesCount: number;
    warnings: string[];
    msSince(label: string): number;
    msBetween(from: string, to: string): number;
  }): void {
    const totalMs = this.now() - input.startedAt;
    if (totalMs < SLOW_SNAPSHOT_THRESHOLD_MS) {
      return;
    }
    const counts = `counts=tasks:${input.tasksCount},inboxNames:${input.inboxNamesCount},members:${input.membersCount},processes:${input.processesCount}`;
    const branchMode = input.includeMemberBranches ? 'full' : 'skipped';
    this.ports.logWarning(
      `getTeamData team=${input.teamName} slow total=${totalMs}ms config=${input.msSince(
        'config'
      )} tasks=${input.msSince('tasks')} inboxNames=${input.msSince(
        'inboxNames'
      )} membersMeta=${input.msSince('metaMembers')} kanban=${input.msSince(
        'kanbanState'
      )} kanbanGc=${input.msSince('kanbanGc')} post=${input.msBetween(
        'postStart',
        'attachKanban'
      )}/loadPresenceIndex=${input.msBetween(
        'attachKanban',
        'loadPresenceIndex'
      )}/changePresence=${input.msBetween(
        'loadPresenceIndex',
        'changePresence'
      )}/resolveMembers=${input.msBetween(
        'changePresence',
        'resolveMembers'
      )}/runtimeAdvisories=${input.msBetween(
        'resolveMembers',
        'runtimeAdvisories'
      )}/enrichBranches=${input.msBetween(
        'runtimeAdvisories',
        'enrichBranches'
      )}/processes=${input.msBetween(
        'syncComments',
        'processes'
      )} branchMode=${branchMode} ${counts}${
        input.warnings.length > 0 ? ` warnings=${input.warnings.join('|')}` : ''
      }`
    );
  }
}
