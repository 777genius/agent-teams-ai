import { keepOnlyMappedUsageEvents } from './attributionPolicy';
import { addEventToSummary, addRunToSummary, ZERO_TOKEN_USAGE_SUMMARY } from './tokenUsageTotals';

import type {
  TokenUsageAnalyticsSnapshotDto,
  TokenUsageBreakdownItemDto,
  TokenUsageCommandRunDto,
  TokenUsageEventDto,
  TokenUsageRecentRunDto,
  TokenUsageRunDto,
  TokenUsageSessionRunDto,
  TokenUsageSnapshotRequest,
  TokenUsageSourceKind,
  TokenUsageTaskAttributionDto,
  TokenUsageTaskBreakdownItemDto,
  TokenUsageTimeSeriesPointDto,
} from '../../contracts';

const RECENT_RUN_LIMIT = 20;
const EXPENSIVE_RUN_LIMIT = 10;
const COMMAND_RUN_LIMIT = 30;
const SESSION_RUN_LIMIT = 30;
const TREND_BUCKET_LIMIT = 14;
const HEATMAP_ALL_TIME_YEAR_LIMIT = 10;
const HEATMAP_DAY_LIMIT = 366 * HEATMAP_ALL_TIME_YEAR_LIMIT;

interface BuildSnapshotInput {
  runs: readonly TokenUsageRunDto[];
  events: readonly TokenUsageEventDto[];
  tasks?: readonly TokenUsageTaskAttributionDto[];
  request?: TokenUsageSnapshotRequest;
  nowIso: string;
  degraded?: boolean;
}

interface NormalizedTaskAttribution {
  key: string;
  task: TokenUsageTaskAttributionDto;
  label: string;
  intervals: NormalizedTaskWorkInterval[];
}

interface NormalizedTaskWorkInterval {
  startedAt: string;
  completedAt?: string;
  startMs: number;
  endMs: number;
}

export function buildTokenUsageSnapshot(input: BuildSnapshotInput): TokenUsageAnalyticsSnapshotDto {
  const runs = filterRuns(input.runs, input.request);
  const eventsForRequest = filterEvents(input.events, input.request);
  const attribution = keepOnlyMappedUsageEvents({ runs, events: eventsForRequest });
  const events = attribution.attributed;

  const eventsByRun = groupEventsByRun(events);
  const runById = new Map(runs.map((run) => [run.appRunId, run]));
  const summary = runs.reduce(
    (acc, run) => addRunToSummary(acc, run.status === 'running'),
    events.reduce(addEventToSummary, { ...ZERO_TOKEN_USAGE_SUMMARY })
  );

  return {
    updatedAt: input.nowIso,
    stale: false,
    degraded: input.degraded === true,
    summary,
    byTeam: buildBreakdown(runs, events, runTeamKey),
    byAgent: buildBreakdown(runs, events, runAgentKey),
    byCommand: buildBreakdown(runs, events, runCommandKey),
    bySession: buildBreakdown(runs, events, runSessionKey),
    byProject: buildBreakdown(runs, events, runProjectKey),
    byRuntime: buildBreakdown(runs, events, runRuntimeKey),
    byModel: buildBreakdown(
      runs,
      events,
      (run) => runModelKey(run, eventsByRun.get(run.appRunId)),
      compareBreakdownItemsByTokens
    ),
    byTask: buildTaskBreakdown(input.tasks ?? [], events, input.nowIso),
    commandRuns: buildCommandRuns(runs, events, runById, eventsByRun, input.nowIso),
    sessionRuns: buildSessionRuns(runs, eventsByRun, input.nowIso),
    tokenTrend: buildTokenTrend(events),
    usageHeatmap: buildUsageHeatmap(events, input.request, input.nowIso),
    recentRuns: buildRecentRuns(runs, eventsByRun, 'recent'),
    expensiveRuns: buildRecentRuns(runs, eventsByRun, 'expensive'),
    unmappedEventCount: attribution.unmappedEventCount,
    sourceCounts: buildSourceCounts(events),
  };
}

function filterRuns(
  runs: readonly TokenUsageRunDto[],
  request: TokenUsageSnapshotRequest | undefined
): TokenUsageRunDto[] {
  const teamFilter = buildTeamFilter(request);
  return runs.filter((run) => {
    if (teamFilter && !matchesTeamFilter(run.teamName, teamFilter)) return false;
    if (request?.agentId && run.agentId !== request.agentId) return false;
    if (request?.commandId && run.commandId !== request.commandId) return false;
    if (request?.commandInvocationId && run.commandInvocationId !== request.commandInvocationId) {
      return false;
    }
    if (request?.nativeSessionId && !hasNativeSessionId(run, request.nativeSessionId)) {
      return false;
    }
    return runOverlapsRange(run, request);
  });
}

function filterEvents(
  events: readonly TokenUsageEventDto[],
  request: TokenUsageSnapshotRequest | undefined
): TokenUsageEventDto[] {
  const teamFilter = buildTeamFilter(request);
  return events.filter((event) => {
    if (teamFilter && !matchesTeamFilter(event.teamName, teamFilter)) return false;
    if (request?.agentId && event.agentId !== request.agentId) return false;
    if (request?.commandId && event.commandId !== request.commandId) return false;
    if (request?.commandInvocationId && event.commandInvocationId !== request.commandInvocationId) {
      return false;
    }
    if (request?.nativeSessionId && event.nativeSessionId !== request.nativeSessionId) {
      return false;
    }
    return isWithinRange(event.occurredAt, request);
  });
}

function buildTeamFilter(
  request: TokenUsageSnapshotRequest | undefined
): ReadonlySet<string> | undefined {
  const names = (request?.teamNames ?? [])
    .map((teamName) => teamName.trim())
    .filter((teamName, index, items) => teamName.length > 0 && items.indexOf(teamName) === index);
  if (names.length > 0) return new Set(names);
  return request?.teamName ? new Set([request.teamName]) : undefined;
}

function matchesTeamFilter(teamName: string | undefined, filter: ReadonlySet<string>): boolean {
  return teamName !== undefined && filter.has(teamName);
}

function runOverlapsRange(
  run: TokenUsageRunDto,
  request: TokenUsageSnapshotRequest | undefined
): boolean {
  const startedAt = parseIso(run.startedAt);
  const endedAt = parseIso(run.endedAt ?? run.startedAt);
  const from = request?.from ? parseIso(request.from) : undefined;
  const to = request?.to ? parseIso(request.to) : undefined;
  if (from !== undefined && endedAt !== undefined && endedAt < from) return false;
  if (to !== undefined && startedAt !== undefined && startedAt > to) return false;
  return true;
}

function isWithinRange(iso: string, request: TokenUsageSnapshotRequest | undefined): boolean {
  const time = parseIso(iso);
  if (time === undefined) return true;
  const from = request?.from ? parseIso(request.from) : undefined;
  const to = request?.to ? parseIso(request.to) : undefined;
  if (from !== undefined && time < from) return false;
  if (to !== undefined && time > to) return false;
  return true;
}

function groupEventsByRun(
  events: readonly TokenUsageEventDto[]
): Map<string, TokenUsageEventDto[]> {
  const grouped = new Map<string, TokenUsageEventDto[]>();
  for (const event of events) {
    const current = grouped.get(event.appRunId) ?? [];
    current.push(event);
    grouped.set(event.appRunId, current);
  }
  return grouped;
}

function buildBreakdown(
  runs: readonly TokenUsageRunDto[],
  events: readonly TokenUsageEventDto[],
  keyForRun: (run: TokenUsageRunDto) => {
    id: string;
    label: string;
    teamName?: string;
    agentName?: string;
  },
  compareItems: (
    left: TokenUsageBreakdownItemDto,
    right: TokenUsageBreakdownItemDto
  ) => number = compareBreakdownItems
): TokenUsageBreakdownItemDto[] {
  const groups = new Map<string, TokenUsageBreakdownItemDto>();

  for (const run of runs) {
    const key = keyForRun(run);
    const current = groups.get(key.id) ?? {
      id: key.id,
      label: key.label,
      teamName: key.teamName,
      agentName: key.agentName,
      summary: { ...ZERO_TOKEN_USAGE_SUMMARY },
      lastActivityAt: undefined,
    };
    current.summary = addRunToSummary(current.summary, run.status === 'running');
    current.lastActivityAt = maxIso(current.lastActivityAt, run.endedAt ?? run.startedAt);
    groups.set(key.id, current);
  }

  const runById = new Map(runs.map((run) => [run.appRunId, run]));
  for (const event of events) {
    const run = runById.get(event.appRunId);
    if (!run) continue;
    const key = keyForRun(run);
    const current = groups.get(key.id);
    if (!current) continue;
    current.summary = addEventToSummary(current.summary, event);
    current.lastActivityAt = maxIso(current.lastActivityAt, event.occurredAt);
  }

  return [...groups.values()].sort(compareItems);
}

function buildTaskBreakdown(
  tasks: readonly TokenUsageTaskAttributionDto[],
  events: readonly TokenUsageEventDto[],
  nowIso: string
): TokenUsageTaskBreakdownItemDto[] {
  const tasksByTeam = groupTaskAttributionsByTeam(tasks, nowIso);
  const groups = new Map<string, TokenUsageTaskBreakdownItemDto>();

  for (const event of events) {
    const task = selectTaskForEvent(event, tasksByTeam);
    if (!task) continue;

    const current = groups.get(task.key) ?? {
      id: task.key,
      taskId: task.task.id,
      displayId: task.task.displayId,
      subject: task.task.subject,
      owner: task.task.owner,
      status: task.task.status,
      label: task.label,
      teamName: task.task.teamName,
      agentName: task.task.owner,
      summary: { ...ZERO_TOKEN_USAGE_SUMMARY },
      lastActivityAt: undefined,
    };
    current.summary = addEventToSummary(current.summary, event);
    current.lastActivityAt = maxIso(current.lastActivityAt, event.occurredAt);
    groups.set(task.key, current);
  }

  return [...groups.values()].sort(compareBreakdownItems);
}

function groupTaskAttributionsByTeam(
  tasks: readonly TokenUsageTaskAttributionDto[],
  nowIso: string
): Map<string, NormalizedTaskAttribution[]> {
  const nowMs = parseIso(nowIso);
  const byTeam = new Map<string, NormalizedTaskAttribution[]>();

  for (const task of tasks) {
    const teamName = task.teamName.trim();
    if (!teamName) continue;

    const intervals = task.workIntervals
      .map((interval): NormalizedTaskWorkInterval | null => {
        const startMs = parseIso(interval.startedAt);
        const endMs = parseIso(interval.completedAt ?? nowIso) ?? nowMs;
        if (startMs === undefined || endMs === undefined || endMs < startMs) return null;
        return {
          startedAt: interval.startedAt,
          completedAt: interval.completedAt,
          startMs,
          endMs,
        };
      })
      .filter((interval): interval is NormalizedTaskWorkInterval => interval !== null);

    if (intervals.length === 0) continue;

    const current = byTeam.get(teamName) ?? [];
    current.push({
      key: taskBreakdownId(teamName, task.id),
      task,
      label: taskLabel(task),
      intervals,
    });
    byTeam.set(teamName, current);
  }

  return byTeam;
}

function selectTaskForEvent(
  event: TokenUsageEventDto,
  tasksByTeam: Map<string, NormalizedTaskAttribution[]>
): NormalizedTaskAttribution | null {
  if (!event.teamName) return null;
  const eventMs = parseIso(event.occurredAt);
  if (eventMs === undefined) return null;

  let best: {
    task: NormalizedTaskAttribution;
    ownerScore: number;
    intervalMs: number;
    startedAtMs: number;
  } | null = null;

  for (const task of tasksByTeam.get(event.teamName) ?? []) {
    const ownerScore = taskOwnerScore(task.task.owner, event);
    if (ownerScore < 0) continue;

    for (const interval of task.intervals) {
      if (eventMs < interval.startMs || eventMs > interval.endMs) continue;
      const candidate = {
        task,
        ownerScore,
        intervalMs: interval.endMs - interval.startMs,
        startedAtMs: interval.startMs,
      };
      if (!best || compareTaskCandidate(candidate, best) < 0) {
        best = candidate;
      }
    }
  }

  return best?.task ?? null;
}

function compareTaskCandidate(
  left: {
    ownerScore: number;
    intervalMs: number;
    startedAtMs: number;
  },
  right: {
    ownerScore: number;
    intervalMs: number;
    startedAtMs: number;
  }
): number {
  return (
    right.ownerScore - left.ownerScore ||
    left.intervalMs - right.intervalMs ||
    right.startedAtMs - left.startedAtMs
  );
}

function taskOwnerScore(owner: string | undefined, event: TokenUsageEventDto): number {
  const normalizedOwner = normalizeIdentity(owner);
  if (!normalizedOwner) return 0;

  const eventAgents = [
    event.agentName,
    event.agentId,
    event.agentId?.includes(':') ? event.agentId.split(':').pop() : undefined,
  ]
    .map(normalizeIdentity)
    .filter((value): value is string => Boolean(value));

  if (eventAgents.length === 0) return 0;
  return eventAgents.includes(normalizedOwner) ? 1 : -1;
}

function taskBreakdownId(teamName: string, taskId: string): string {
  return `task:${teamName}:${taskId}`;
}

function taskLabel(task: TokenUsageTaskAttributionDto): string {
  const displayId = task.displayId?.trim();
  const subject = task.subject.trim();
  if (displayId && subject) return `${displayId} ${subject}`;
  return subject || displayId || task.id;
}

function normalizeIdentity(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function buildRecentRuns(
  runs: readonly TokenUsageRunDto[],
  eventsByRun: Map<string, TokenUsageEventDto[]>,
  mode: 'recent' | 'expensive'
): TokenUsageRecentRunDto[] {
  const items = runs.map((run) => {
    const events = eventsByRun.get(run.appRunId) ?? [];
    const summary = summarizeRun(run, events);
    const model = firstModeledEventModel(events) ?? run.model;
    return {
      appRunId: run.appRunId,
      teamName: run.teamName,
      agentName: run.agentName,
      runtimeKind: run.runtimeKind,
      providerId: run.providerId,
      billingMode: run.billingMode,
      model,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      summary,
      sources: run.sources,
    };
  });

  return items
    .sort((left, right) =>
      mode === 'expensive'
        ? right.summary.estimatedCostUsd - left.summary.estimatedCostUsd ||
          right.summary.totalTokens - left.summary.totalTokens
        : Date.parse(right.endedAt ?? right.startedAt) - Date.parse(left.endedAt ?? left.startedAt)
    )
    .slice(0, mode === 'expensive' ? EXPENSIVE_RUN_LIMIT : RECENT_RUN_LIMIT);
}

function buildSessionRuns(
  runs: readonly TokenUsageRunDto[],
  eventsByRun: Map<string, TokenUsageEventDto[]>,
  nowIso: string
): TokenUsageSessionRunDto[] {
  return runs
    .map((run) => {
      const source = primaryRunSource(run);
      const sessionId = source?.nativeSessionId;
      const nativeLogPath = source?.nativeLogPath;
      const id = sessionId ?? nativeLogPath ?? run.appRunId;
      const events = eventsByRun.get(run.appRunId) ?? [];
      const summary = summarizeRun(run, events);
      const model = firstModeledEventModel(events) ?? run.model;
      return {
        id,
        label: buildSessionLabel(run, id),
        appRunId: run.appRunId,
        teamName: run.teamName,
        agentId: run.agentId,
        agentName: run.agentName,
        runtimeKind: run.runtimeKind,
        providerId: run.providerId,
        billingMode: run.billingMode,
        model,
        nativeSessionId: sessionId,
        nativeLogPath,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        durationMs: durationMs(run.startedAt, run.endedAt ?? nowIso),
        status: run.status,
        summary,
        sources: run.sources,
      };
    })
    .sort((left, right) =>
      compareIsoDesc(left.endedAt ?? left.startedAt, right.endedAt ?? right.startedAt)
    )
    .slice(0, SESSION_RUN_LIMIT);
}

function buildCommandRuns(
  runs: readonly TokenUsageRunDto[],
  events: readonly TokenUsageEventDto[],
  runById: Map<string, TokenUsageRunDto>,
  eventsByRun: Map<string, TokenUsageEventDto[]>,
  nowIso: string
): TokenUsageCommandRunDto[] {
  interface CommandRunGroup {
    id: string;
    label: string;
    commandId?: string;
    commandInvocationId?: string;
    teamName?: string;
    agentNames: Set<string>;
    runtimeKinds: Set<TokenUsageCommandRunDto['runtimeKinds'][number]>;
    models: Set<string>;
    runCount: number;
    startedAt: string;
    endedAt?: string;
    statuses: TokenUsageRunDto['status'][];
    summary: TokenUsageCommandRunDto['summary'];
  }

  const groups = new Map<string, CommandRunGroup>();
  for (const run of runs) {
    const key = runCommandRunKey(run);
    const current = groups.get(key.id) ?? {
      id: key.id,
      label: key.label,
      commandId: run.commandId,
      commandInvocationId: run.commandInvocationId,
      teamName: run.teamName,
      agentNames: new Set<string>(),
      runtimeKinds: new Set<TokenUsageCommandRunDto['runtimeKinds'][number]>(),
      models: new Set<string>(),
      runCount: 0,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      statuses: [],
      summary: { ...ZERO_TOKEN_USAGE_SUMMARY },
    };
    if (run.agentName) current.agentNames.add(run.agentName);
    current.runtimeKinds.add(run.runtimeKind);
    const concreteModels = modeledEventModels(eventsByRun.get(run.appRunId));
    if (concreteModels.length > 0) {
      for (const model of concreteModels) current.models.add(model);
    } else if (run.model) {
      current.models.add(run.model);
    }
    current.runCount += 1;
    current.startedAt = minIso(current.startedAt, run.startedAt) ?? current.startedAt;
    current.endedAt = maxCommandEnd(current.endedAt, run.endedAt);
    current.statuses.push(run.status);
    current.summary = addRunToSummary(current.summary, run.status === 'running');
    groups.set(key.id, current);
  }

  for (const event of events) {
    const run = runById.get(event.appRunId);
    if (!run) continue;
    const key = runCommandRunKey(run);
    const current = groups.get(key.id);
    if (!current) continue;
    current.summary = addEventToSummary(current.summary, event);
  }

  return [...groups.values()]
    .map((group) => ({
      id: group.id,
      label: group.label,
      commandId: group.commandId,
      commandInvocationId: group.commandInvocationId,
      teamName: group.teamName,
      agentNames: [...group.agentNames].sort((left, right) => left.localeCompare(right)),
      runtimeKinds: [...group.runtimeKinds].sort((left, right) => left.localeCompare(right)),
      models: [...group.models].sort((left, right) => left.localeCompare(right)),
      runCount: group.runCount,
      startedAt: group.startedAt,
      endedAt: group.statuses.includes('running') ? undefined : group.endedAt,
      durationMs: durationMs(
        group.startedAt,
        group.statuses.includes('running') ? nowIso : (group.endedAt ?? nowIso)
      ),
      status: aggregateRunStatus(group.statuses),
      summary: group.summary,
    }))
    .sort((left, right) =>
      compareIsoDesc(left.endedAt ?? left.startedAt, right.endedAt ?? right.startedAt)
    )
    .slice(0, COMMAND_RUN_LIMIT);
}

function summarizeRun(
  run: TokenUsageRunDto,
  events: readonly TokenUsageEventDto[]
): TokenUsageRecentRunDto['summary'] {
  return events.reduce(
    addEventToSummary,
    addRunToSummary({ ...ZERO_TOKEN_USAGE_SUMMARY }, run.status === 'running')
  );
}

function buildTokenTrend(events: readonly TokenUsageEventDto[]): TokenUsageTimeSeriesPointDto[] {
  const buckets = new Map<string, TokenUsageTimeSeriesPointDto>();

  for (const event of events) {
    const bucket = trendBucketForIso(event.occurredAt);
    if (!bucket) continue;
    const current = getTrendBucket(buckets, bucket);
    current.summary = addEventToSummary(current.summary, event);
  }

  return [...buckets.values()]
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    .slice(-TREND_BUCKET_LIMIT);
}

function buildUsageHeatmap(
  events: readonly TokenUsageEventDto[],
  request: TokenUsageSnapshotRequest | undefined,
  nowIso: string
): TokenUsageTimeSeriesPointDto[] {
  const range = resolveHeatmapRange(events, request, nowIso);
  const buckets = new Map<string, TokenUsageTimeSeriesPointDto>();
  let cursor = dateKeyToUtcDate(range.fromDateKey);
  const end = dateKeyToUtcDate(range.toDateKey);

  while (cursor <= end) {
    const dateKey = utcDateKey(cursor);
    buckets.set(dateKey, emptyDailyBucket(dateKey));
    cursor = addUtcDays(cursor, 1);
  }

  for (const event of events) {
    const dateKey = dayKeyForIso(event.occurredAt);
    if (!dateKey || dateKey < range.fromDateKey || dateKey > range.toDateKey) continue;
    const bucket = buckets.get(dateKey) ?? emptyDailyBucket(dateKey);
    bucket.summary = addEventToSummary(bucket.summary, event);
    buckets.set(dateKey, bucket);
  }

  return [...buckets.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

function resolveHeatmapRange(
  events: readonly TokenUsageEventDto[],
  request: TokenUsageSnapshotRequest | undefined,
  nowIso: string
): { fromDateKey: string; toDateKey: string } {
  const requestedFrom = request?.from ? dayKeyForIso(request.from) : undefined;
  const requestedTo = request?.to ? dayKeyForIso(request.to) : undefined;

  if (requestedFrom && requestedTo) {
    return limitHeatmapRange(requestedFrom, requestedTo, HEATMAP_DAY_LIMIT);
  }

  const nowKey = dayKeyForIso(nowIso) ?? utcDateKey(new Date());
  const latestEventKey = latestEventDateKey(events);
  const earliestEventKey = earliestEventDateKey(events);
  const toDateKey = requestedTo ?? endOfUtcYear(latestEventKey ?? nowKey);
  const fromDateKey = requestedFrom ?? startOfUtcYear(earliestEventKey ?? nowKey);
  return limitHeatmapRange(fromDateKey, toDateKey, HEATMAP_DAY_LIMIT);
}

function limitHeatmapRange(
  fromDateKey: string,
  toDateKey: string,
  maxDays: number
): { fromDateKey: string; toDateKey: string } {
  const [fromKey, toKey] =
    fromDateKey <= toDateKey ? [fromDateKey, toDateKey] : [toDateKey, fromDateKey];
  const dayCount = diffUtcDays(dateKeyToUtcDate(fromKey), dateKeyToUtcDate(toKey)) + 1;
  if (dayCount <= maxDays) return { fromDateKey: fromKey, toDateKey: toKey };
  return {
    fromDateKey: utcDateKey(addUtcDays(dateKeyToUtcDate(toKey), -maxDays + 1)),
    toDateKey: toKey,
  };
}

function latestEventDateKey(events: readonly TokenUsageEventDto[]): string | undefined {
  return events.reduce<string | undefined>((latest, event) => {
    const dateKey = dayKeyForIso(event.occurredAt);
    if (!dateKey) return latest;
    return latest === undefined || dateKey > latest ? dateKey : latest;
  }, undefined);
}

function earliestEventDateKey(events: readonly TokenUsageEventDto[]): string | undefined {
  return events.reduce<string | undefined>((earliest, event) => {
    const dateKey = dayKeyForIso(event.occurredAt);
    if (!dateKey) return earliest;
    return earliest === undefined || dateKey < earliest ? dateKey : earliest;
  }, undefined);
}

function startOfUtcYear(dateKey: string): string {
  const year = Number(dateKey.slice(0, 4));
  return `${String(year).padStart(4, '0')}-01-01`;
}

function endOfUtcYear(dateKey: string): string {
  const year = Number(dateKey.slice(0, 4));
  return `${String(year).padStart(4, '0')}-12-31`;
}

function emptyDailyBucket(dateKey: string): TokenUsageTimeSeriesPointDto {
  return {
    id: dateKey,
    label: dateKey.slice(5),
    startedAt: `${dateKey}T00:00:00.000Z`,
    endedAt: `${dateKey}T23:59:59.999Z`,
    summary: { ...ZERO_TOKEN_USAGE_SUMMARY },
  };
}

function getTrendBucket(
  buckets: Map<string, TokenUsageTimeSeriesPointDto>,
  bucket: { id: string; startedAt: string; endedAt: string; label: string }
): TokenUsageTimeSeriesPointDto {
  const current =
    buckets.get(bucket.id) ??
    ({
      id: bucket.id,
      label: bucket.label,
      startedAt: bucket.startedAt,
      endedAt: bucket.endedAt,
      summary: { ...ZERO_TOKEN_USAGE_SUMMARY },
    } satisfies TokenUsageTimeSeriesPointDto);
  buckets.set(bucket.id, current);
  return current;
}

function trendBucketForIso(
  iso: string
): { id: string; startedAt: string; endedAt: string; label: string } | undefined {
  const timestamp = parseIso(iso);
  if (timestamp === undefined) return undefined;
  const date = new Date(timestamp);
  const id = utcDateKey(date);
  const startedAt = `${id}T00:00:00.000Z`;
  const endedAt = `${id}T23:59:59.999Z`;
  return {
    id,
    startedAt,
    endedAt,
    label: id.slice(5),
  };
}

function dayKeyForIso(iso: string): string | undefined {
  const timestamp = parseIso(iso);
  if (timestamp === undefined) return undefined;
  return utcDateKey(new Date(timestamp));
}

function buildSourceCounts(
  events: readonly TokenUsageEventDto[]
): Record<TokenUsageSourceKind, number> {
  const counts: Record<TokenUsageSourceKind, number> = {
    sdk_exact: 0,
    gateway_exact: 0,
    log_parsed: 0,
    tokenizer_estimated: 0,
    cost_estimated: 0,
  };
  for (const event of events) {
    counts[event.usageSourceKind] += 1;
  }
  return counts;
}

function runTeamKey(run: TokenUsageRunDto): { id: string; label: string; teamName?: string } {
  return {
    id: run.teamName ?? 'unassigned',
    label: run.teamName ?? 'Unassigned',
    teamName: run.teamName,
  };
}

function runAgentKey(run: TokenUsageRunDto): {
  id: string;
  label: string;
  teamName?: string;
  agentName?: string;
} {
  return {
    id: run.agentId ?? `${run.teamName ?? 'unassigned'}:${run.agentName ?? 'unknown'}`,
    label: run.agentName ?? run.agentId ?? 'Unknown agent',
    teamName: run.teamName,
    agentName: run.agentName,
  };
}

function runCommandKey(run: TokenUsageRunDto): { id: string; label: string; teamName?: string } {
  if (run.commandId) return { id: run.commandId, label: run.commandId, teamName: run.teamName };
  if (run.commandHash)
    return {
      id: `hash:${run.commandHash}`,
      label: `Command ${shortId(run.commandHash)}`,
      teamName: run.teamName,
    };
  return { id: 'unassigned-command', label: 'Unassigned command', teamName: run.teamName };
}

function runSessionKey(run: TokenUsageRunDto): { id: string; label: string; teamName?: string } {
  const source = primaryRunSource(run);
  const id = source?.nativeSessionId ?? source?.nativeLogPath ?? run.appRunId;
  return { id, label: buildSessionLabel(run, id), teamName: run.teamName };
}

function runProjectKey(run: TokenUsageRunDto): { id: string; label: string; teamName?: string } {
  const id = run.workspacePathHash ? `project:${run.workspacePathHash}` : 'unknown-project';
  const label =
    run.workspaceLabel ??
    (run.workspacePathHash ? `Project ${shortId(run.workspacePathHash)}` : 'Unknown project');
  return {
    id,
    label,
    teamName: run.teamName,
  };
}

function runRuntimeKey(run: TokenUsageRunDto): { id: string; label: string } {
  return { id: run.runtimeKind, label: run.runtimeKind };
}

function runModelKey(
  run: TokenUsageRunDto,
  events: readonly TokenUsageEventDto[] | undefined
): { id: string; label: string } {
  const model = firstModeledEventModel(events) ?? run.model;
  return { id: model ?? 'unknown-model', label: model ?? 'Unknown model' };
}

function firstModeledEventModel(
  events: readonly TokenUsageEventDto[] | undefined
): string | undefined {
  return events?.find((event) => event.model)?.model;
}

function modeledEventModels(events: readonly TokenUsageEventDto[] | undefined): string[] {
  const models = new Set<string>();
  for (const event of events ?? []) {
    if (event.model) models.add(event.model);
  }
  return [...models];
}

function compareBreakdownItems(
  left: TokenUsageBreakdownItemDto,
  right: TokenUsageBreakdownItemDto
): number {
  return (
    right.summary.estimatedCostUsd - left.summary.estimatedCostUsd ||
    right.summary.totalTokens - left.summary.totalTokens ||
    left.label.localeCompare(right.label)
  );
}

function compareBreakdownItemsByTokens(
  left: TokenUsageBreakdownItemDto,
  right: TokenUsageBreakdownItemDto
): number {
  return (
    right.summary.totalTokens - left.summary.totalTokens ||
    right.summary.estimatedCostUsd - left.summary.estimatedCostUsd ||
    left.label.localeCompare(right.label)
  );
}

function runCommandRunKey(run: TokenUsageRunDto): { id: string; label: string } {
  const id = run.commandInvocationId ?? run.appRunId;
  if (run.commandId && run.commandInvocationId) {
    if (run.commandInvocationId.startsWith(`${run.commandId}:`)) {
      return { id, label: run.commandId };
    }
    return { id, label: `${run.commandId} / ${shortId(run.commandInvocationId)}` };
  }
  if (run.commandId) {
    return { id, label: run.commandId };
  }
  if (run.commandHash) {
    return { id, label: `Command ${shortId(run.commandHash)}` };
  }
  return {
    id,
    label: `${run.agentName ?? 'App run'} / ${shortId(id)}`,
  };
}

function buildSessionLabel(run: TokenUsageRunDto, id: string): string {
  return `${run.agentName ?? run.runtimeKind} / ${shortId(id)}`;
}

function primaryRunSource(run: TokenUsageRunDto): TokenUsageRunDto['sources'][number] | undefined {
  return (
    run.sources.find((source) => source.nativeSessionId) ??
    run.sources.find((source) => source.nativeLogPath) ??
    run.sources[0]
  );
}

function hasNativeSessionId(run: TokenUsageRunDto, nativeSessionId: string): boolean {
  return run.sources.some((source) => source.nativeSessionId === nativeSessionId);
}

function aggregateRunStatus(
  statuses: readonly TokenUsageRunDto['status'][]
): TokenUsageRunDto['status'] {
  if (statuses.includes('running')) return 'running';
  if (statuses.length > 0 && statuses.every((status) => status === 'completed')) return 'completed';
  if (statuses.includes('failed')) return 'failed';
  return 'unknown';
}

function durationMs(startIso: string, endIso: string | undefined): number | undefined {
  const start = parseIso(startIso);
  const end = endIso ? parseIso(endIso) : undefined;
  if (start === undefined || end === undefined) return undefined;
  return Math.max(0, end - start);
}

function parseIso(iso: string): number | undefined {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : undefined;
}

function utcDateKey(date: Date): string {
  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function dateKeyToUtcDate(dateKey: string): Date {
  const [year = 1970, month = 1, day = 1] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

function diffUtcDays(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

function compareIsoDesc(left: string, right: string): number {
  return (parseIso(right) ?? 0) - (parseIso(left) ?? 0);
}

function minIso(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return (parseIso(right) ?? Number.POSITIVE_INFINITY) <
    (parseIso(left) ?? Number.POSITIVE_INFINITY)
    ? right
    : left;
}

function maxIso(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return (parseIso(right) ?? Number.NEGATIVE_INFINITY) >
    (parseIso(left) ?? Number.NEGATIVE_INFINITY)
    ? right
    : left;
}

function maxCommandEnd(left: string | undefined, right: string | undefined): string | undefined {
  if (!right) return left;
  return maxIso(left, right);
}

function shortId(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}
