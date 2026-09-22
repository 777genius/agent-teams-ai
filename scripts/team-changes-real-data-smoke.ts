/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { TeamTask, TeamTaskChangeSummaryItem, TeamTaskWithKanban } from '../src/shared/types';

process.env.CLAUDE_TEAM_ENABLE_PERSISTED_TASK_CHANGE_CACHE = '0';

const FIRST_STAGE_REQUESTS = 3;
const SECOND_STAGE_REQUESTS = 9;
const FIRST_STAGE_UNKNOWN_SCAN_LIMIT = 3;
const SECOND_STAGE_UNKNOWN_SCAN_LIMIT = 6;
const DEFAULT_TEAM_LIMIT = 3;

interface Args {
  teams: string[];
  limit: number;
}

interface PresenceEntry {
  presence?: string;
}

interface CandidateSuccess {
  teamName: string;
  tasks: TeamTaskWithKanban[];
  taskCount: number;
  changedPresenceCount: number;
  eligibleCount: number;
  presenceCounts: Record<string, number>;
}

interface CandidateFailure {
  teamName: string;
  error: string;
}

type Candidate = CandidateSuccess | CandidateFailure;

interface RuntimeModules {
  TeamTaskReader: typeof import('../src/main/services/team/TeamTaskReader')['TeamTaskReader'];
  ChangeExtractorService: typeof import('../src/main/services/team/ChangeExtractorService')['ChangeExtractorService'];
  TeamMemberLogsFinder: typeof import('../src/main/services/team/TeamMemberLogsFinder')['TeamMemberLogsFinder'];
  TaskBoundaryParser: typeof import('../src/main/services/team/TaskBoundaryParser')['TaskBoundaryParser'];
  TaskChangeWorkerClient: typeof import('../src/main/services/team/TaskChangeWorkerClient')['TaskChangeWorkerClient'];
  buildTeamChangeRequestPlan: typeof import('../src/renderer/components/team/teamChangesRequestPlan')['buildTeamChangeRequestPlan'];
  TEAM_CHANGES_MAX_REQUESTS: typeof import('../src/renderer/components/team/teamChangesRequestPlan')['TEAM_CHANGES_MAX_REQUESTS'];
}

interface StageReport {
  label: string;
  requested: number;
  duplicateRequests: string[];
  responseItems: number;
  truncated: boolean;
  ms: number;
  deferredBeforeResponse: number;
  satisfiedAfterStage: number;
  itemErrors: number;
  nullItems: number;
  countableItems: number;
  fileRows: number;
  confidenceCounts: Record<string, number>;
  sourceKindCounts: Record<string, number>;
  firstTaskIds: string[];
}

interface TeamSmokeReport {
  kind: 'team-smoke';
  teamName: string;
  taskCount: number;
  changedPresenceCount: number;
  eligibleCount: number;
  stages: StageReport[];
}

interface ForceRefreshSmokeReport {
  kind: 'force-refresh-smoke';
  teamName: string;
  requested: number;
  allForceFresh: boolean;
  responseItems: number;
  ms: number;
  taskIds: string[];
}

function parseArgs(argv: string[]): Args {
  const teams: string[] = [];
  let limit = DEFAULT_TEAM_LIMIT;
  let index = 0;

  while (index < argv.length) {
    const arg = argv[index];
    const next = argv[index + 1] ?? '';
    if (arg === '--team' || arg === '--teams') {
      teams.push(...next.split(',').map((teamName) => teamName.trim()).filter(Boolean));
      index += 2;
      continue;
    }
    if (arg === '--limit') {
      const parsedLimit = Number.parseInt(next, 10);
      if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
        limit = parsedLimit;
      }
      index += 2;
      continue;
    }
    index += 1;
  }

  return { teams: [...new Set(teams)], limit };
}

async function loadRuntimeModules(): Promise<RuntimeModules> {
  const { TeamTaskReader } = await import('../src/main/services/team/TeamTaskReader');
  const { ChangeExtractorService } = await import(
    '../src/main/services/team/ChangeExtractorService'
  );
  const { TeamMemberLogsFinder } = await import('../src/main/services/team/TeamMemberLogsFinder');
  const { TaskBoundaryParser } = await import('../src/main/services/team/TaskBoundaryParser');
  const { TaskChangeWorkerClient } = await import(
    '../src/main/services/team/TaskChangeWorkerClient'
  );
  const { buildTeamChangeRequestPlan, TEAM_CHANGES_MAX_REQUESTS } = await import(
    '../src/renderer/components/team/teamChangesRequestPlan'
  );

  return {
    TeamTaskReader,
    ChangeExtractorService,
    TeamMemberLogsFinder,
    TaskBoundaryParser,
    TaskChangeWorkerClient,
    buildTeamChangeRequestPlan,
    TEAM_CHANGES_MAX_REQUESTS,
  };
}

async function readTeamNames(): Promise<string[]> {
  const teamsDir = path.join(os.homedir(), '.claude', 'teams');
  const entries = await fs.readdir(teamsDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function readPresence(teamName: string): Promise<Record<string, PresenceEntry>> {
  const filePath = path.join(
    os.homedir(),
    '.claude',
    'task-change-presence',
    `${encodeURIComponent(teamName)}.json`
  );
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, PresenceEntry>)
      : {};
  } catch {
    return {};
  }
}

function overlayPresence(
  tasks: TeamTask[],
  presenceByTaskId: Record<string, PresenceEntry>
): TeamTaskWithKanban[] {
  return tasks.map((task) => {
    const presence = presenceByTaskId[task.id]?.presence;
    if (
      presence === 'has_changes' ||
      presence === 'needs_attention' ||
      presence === 'no_changes' ||
      presence === 'unknown'
    ) {
      return { ...task, changePresence: presence };
    }
    return task;
  });
}

function increment(counts: Record<string, number>, rawKey: string | undefined): void {
  const key = rawKey && rawKey.trim().length > 0 ? rawKey : 'unknown';
  counts[key] = (counts[key] ?? 0) + 1;
}

function isCandidateSuccess(candidate: Candidate): candidate is CandidateSuccess {
  return !('error' in candidate);
}

function isCountableSummary(item: TeamTaskChangeSummaryItem): boolean {
  if (item.error) return true;
  const changeSet = item.changeSet;
  if (!changeSet) return false;
  const fileCount = Array.isArray(changeSet.files) ? changeSet.files.length : 0;
  const diagnosticCount = Array.isArray(changeSet.reviewDiagnostics)
    ? changeSet.reviewDiagnostics.length
    : 0;
  const warningCount = Array.isArray(changeSet.warnings) ? changeSet.warnings.length : 0;
  return (
    fileCount > 0 ||
    diagnosticCount > 0 ||
    warningCount > 0
  );
}

function isSatisfiedSummary(item: TeamTaskChangeSummaryItem): boolean {
  return !item.error && item.changeSet !== null;
}

function createChangeExtractorService(modules: RuntimeModules): InstanceType<
  RuntimeModules['ChangeExtractorService']
> {
  return new modules.ChangeExtractorService(
    new modules.TeamMemberLogsFinder(),
    new modules.TaskBoundaryParser(),
    undefined,
    undefined,
    new modules.TaskChangeWorkerClient({ enabled: false }),
    null
  );
}

async function loadCandidate(
  modules: RuntimeModules,
  taskReader: InstanceType<RuntimeModules['TeamTaskReader']>,
  teamName: string
): Promise<Candidate> {
  try {
    const rawTasks = await taskReader.getTasks(teamName);
    const presence = await readPresence(teamName);
    const tasks = overlayPresence(rawTasks, presence);
    const eligiblePlan = modules.buildTeamChangeRequestPlan(tasks, 0, false, {
      maxRequests: modules.TEAM_CHANGES_MAX_REQUESTS,
    });
    const presenceCounts: Record<string, number> = {};
    for (const entry of Object.values(presence)) {
      increment(presenceCounts, entry.presence);
    }

    return {
      teamName,
      tasks,
      taskCount: rawTasks.length,
      changedPresenceCount:
        (presenceCounts.has_changes ?? 0) + (presenceCounts.needs_attention ?? 0),
      eligibleCount: eligiblePlan.eligibleCount,
      presenceCounts,
    };
  } catch (error) {
    return {
      teamName,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function selectCandidates(candidates: Candidate[], limit: number): CandidateSuccess[] {
  return candidates
    .filter(isCandidateSuccess)
    .sort((left, right) => {
      const leftScore = left.taskCount + left.changedPresenceCount;
      const rightScore = right.taskCount + right.changedPresenceCount;
      return (
        rightScore - leftScore ||
        right.changedPresenceCount - left.changedPresenceCount ||
        right.taskCount - left.taskCount ||
        left.teamName.localeCompare(right.teamName)
      );
    })
    .slice(0, limit);
}

function summarizeStageItems(
  items: TeamTaskChangeSummaryItem[],
  satisfiedTaskIds: Set<string>
): Omit<
  StageReport,
  | 'label'
  | 'requested'
  | 'duplicateRequests'
  | 'responseItems'
  | 'truncated'
  | 'ms'
  | 'deferredBeforeResponse'
  | 'satisfiedAfterStage'
  | 'firstTaskIds'
> {
  const confidenceCounts: Record<string, number> = {};
  const sourceKindCounts: Record<string, number> = {};
  let itemErrors = 0;
  let nullItems = 0;
  let countableItems = 0;
  let fileRows = 0;

  for (const item of items) {
    if (item.error) itemErrors += 1;
    if (!item.changeSet) nullItems += 1;
    if (isCountableSummary(item)) countableItems += 1;
    if (isSatisfiedSummary(item)) satisfiedTaskIds.add(item.taskId);
    fileRows += Array.isArray(item.changeSet?.files) ? item.changeSet.files.length : 0;
    increment(confidenceCounts, item.changeSet?.confidence);
    increment(sourceKindCounts, item.changeSet?.provenance?.sourceKind);
  }

  return { itemErrors, nullItems, countableItems, fileRows, confidenceCounts, sourceKindCounts };
}

async function runTeamSmoke(
  modules: RuntimeModules,
  team: CandidateSuccess
): Promise<TeamSmokeReport> {
  const service = createChangeExtractorService(modules);
  const satisfiedTaskIds = new Set<string>();
  const requestedTaskIds = new Set<string>();
  let cursor = 0;
  const stages: StageReport[] = [];
  const stageInputs = [
    {
      label: 'stage1-first-paint',
      maxRequests: FIRST_STAGE_REQUESTS,
      unknownScanLimit: FIRST_STAGE_UNKNOWN_SCAN_LIMIT,
    },
    {
      label: 'stage2-expand',
      maxRequests: SECOND_STAGE_REQUESTS,
      unknownScanLimit: SECOND_STAGE_UNKNOWN_SCAN_LIMIT,
    },
    {
      label: 'stage3-full',
      maxRequests: modules.TEAM_CHANGES_MAX_REQUESTS,
      unknownScanLimit: undefined,
    },
  ];

  for (const stage of stageInputs) {
    const plan = modules.buildTeamChangeRequestPlan(team.tasks, cursor, false, {
      maxRequests: stage.maxRequests,
      unknownScanLimit: stage.unknownScanLimit,
      satisfiedTaskIds,
    });
    cursor = plan.nextUnknownScanCursor;
    if (plan.requests.length === 0) break;

    const duplicateRequests = plan.requests
      .map((request) => request.taskId)
      .filter((taskId) => requestedTaskIds.has(taskId));
    for (const request of plan.requests) {
      requestedTaskIds.add(request.taskId);
    }

    const startedAt = Date.now();
    const response = await service.getTeamTaskChangeSummaries(team.teamName, plan.requests);
    const summary = summarizeStageItems(response.items, satisfiedTaskIds);
    stages.push({
      label: stage.label,
      requested: plan.requests.length,
      duplicateRequests,
      responseItems: response.items.length,
      truncated: response.truncated === true,
      ms: Date.now() - startedAt,
      deferredBeforeResponse: plan.deferredCount,
      satisfiedAfterStage: satisfiedTaskIds.size,
      firstTaskIds: plan.requests.slice(0, 5).map((request) => request.taskId.slice(0, 8)),
      ...summary,
    });

    if (plan.deferredCount === 0) break;
  }

  return {
    kind: 'team-smoke',
    teamName: team.teamName,
    taskCount: team.taskCount,
    changedPresenceCount: team.changedPresenceCount,
    eligibleCount: team.eligibleCount,
    stages,
  };
}

function assertTeamSmoke(report: TeamSmokeReport): void {
  const problems: string[] = [];
  if (report.eligibleCount > 0 && report.stages.length === 0) {
    problems.push('eligible tasks produced no staged requests');
  }
  for (const stage of report.stages) {
    if (stage.duplicateRequests.length > 0) {
      problems.push(`${stage.label} duplicated ${stage.duplicateRequests.join(', ')}`);
    }
    if (stage.responseItems > stage.requested) {
      problems.push(`${stage.label} returned more items than requested`);
    }
    if (stage.requested === 0) {
      problems.push(`${stage.label} was recorded with zero requests`);
    }
  }
  const lastStage = report.stages.at(-1);
  if (lastStage && lastStage.deferredBeforeResponse > 0 && lastStage.label !== 'stage3-full') {
    problems.push(`${lastStage.label} left deferred work without reaching the full stage`);
  }
  if (problems.length > 0) {
    throw new Error(`Team Changes real-data smoke failed for ${report.teamName}: ${problems.join('; ')}`);
  }
}

async function runForceRefreshSmoke(
  modules: RuntimeModules,
  team: CandidateSuccess
): Promise<ForceRefreshSmokeReport> {
  const service = createChangeExtractorService(modules);
  const plan = modules.buildTeamChangeRequestPlan(team.tasks, 0, true, {
    maxRequests: FIRST_STAGE_REQUESTS,
    unknownScanLimit: FIRST_STAGE_UNKNOWN_SCAN_LIMIT,
  });
  const startedAt = Date.now();
  const response = await service.getTeamTaskChangeSummaries(team.teamName, plan.requests);
  return {
    kind: 'force-refresh-smoke',
    teamName: team.teamName,
    requested: plan.requests.length,
    allForceFresh: plan.requests.every((request) => request.options?.forceFresh === true),
    responseItems: response.items.length,
    ms: Date.now() - startedAt,
    taskIds: plan.requests.map((request) => request.taskId.slice(0, 8)),
  };
}

function assertForceRefreshSmoke(report: ForceRefreshSmokeReport): void {
  const problems: string[] = [];
  if (report.requested > 0 && !report.allForceFresh) {
    problems.push('not every force refresh request carried forceFresh=true');
  }
  if (report.responseItems > report.requested) {
    problems.push('force refresh returned more items than requested');
  }
  if (problems.length > 0) {
    throw new Error(`Team Changes force-refresh smoke failed for ${report.teamName}: ${problems.join('; ')}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const modules = await loadRuntimeModules();
  const taskReader = new modules.TeamTaskReader();
  const teamNames = args.teams.length > 0 ? args.teams : await readTeamNames();
  const candidates = await Promise.all(
    teamNames.map((teamName) => loadCandidate(modules, taskReader, teamName))
  );
  const selected = selectCandidates(candidates, args.limit);
  const report: unknown[] = [
    {
      kind: 'selection',
      selected: selected.map(
        ({ teamName, taskCount, changedPresenceCount, eligibleCount, presenceCounts }) => ({
          teamName,
          taskCount,
          changedPresenceCount,
          eligibleCount,
          presenceCounts,
        })
      ),
      skipped: candidates.filter((candidate) => !isCandidateSuccess(candidate)),
    },
  ];

  for (const team of selected) {
    const teamReport = await runTeamSmoke(modules, team);
    assertTeamSmoke(teamReport);
    report.push(teamReport);
  }
  if (selected[0]) {
    const forceRefreshReport = await runForceRefreshSmoke(modules, selected[0]);
    assertForceRefreshSmoke(forceRefreshReport);
    report.push(forceRefreshReport);
  }

  console.log(JSON.stringify(report, null, 2));
}

void main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  }
);
