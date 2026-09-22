export type TeamRefreshFanoutSurface =
  | 'team-change-listener'
  | 'provisioning-progress'
  | 'pending-reply-fallback'
  | 'manual-refresh';

export type TeamRefreshFanoutPhase = 'scheduled' | 'coalesced' | 'executed' | 'skipped';

export type TeamRefreshFanoutOperation =
  | 'fetchTeams'
  | 'fetchAllTasks'
  | 'refreshTeamData'
  | 'selectTeam'
  | 'fetchTeamMessageHead'
  | 'fetchMemberSpawnStatuses'
  | 'fetchTeamAgentRuntime'
  | 'refreshTaskChangePresence'
  | 'wouldUseProcessLite'
  | 'wouldKeepStructuralProcess';

export interface TeamRefreshFanoutNote {
  teamName: string;
  surface: TeamRefreshFanoutSurface;
  phase: TeamRefreshFanoutPhase;
  reason: string;
  operation: TeamRefreshFanoutOperation;
  eventType?: string;
  tabId?: string;
  selected?: boolean;
  visible?: boolean;
  activeTab?: boolean;
}

export interface TeamRefreshFanoutRecentNote {
  at: number;
  surface: TeamRefreshFanoutSurface;
  phase: TeamRefreshFanoutPhase;
  reason: string;
  operation: TeamRefreshFanoutOperation;
  eventType?: string;
  tabId?: string;
  selected?: boolean;
  visible?: boolean;
  activeTab?: boolean;
}

export interface TeamRefreshFanoutSnapshot {
  counts: Record<string, number>;
  structuredCounts: Record<string, TeamRefreshFanoutStructuredCount>;
  recent: TeamRefreshFanoutRecentNote[];
  lastAt: number;
}

export interface TeamRefreshFanoutStructuredCount {
  key: string;
  count: number;
  surface: TeamRefreshFanoutSurface;
  reason: string;
  operation: TeamRefreshFanoutOperation;
  phase: TeamRefreshFanoutPhase;
}

export type TeamRefreshFanoutSummaryRow = TeamRefreshFanoutStructuredCount;

export interface TeamRefreshFanoutSummary {
  generatedAt: number;
  teamName?: string;
  total: number;
  rows: TeamRefreshFanoutSummaryRow[];
}

interface TeamRefreshFanoutBucket {
  counts: Record<string, number>;
  structuredCounts: Record<string, TeamRefreshFanoutStructuredCount>;
  recent: TeamRefreshFanoutRecentNote[];
  lastAt: number;
}

export const MAX_TEAM_REFRESH_DIAGNOSTIC_TEAMS = 100;
export const MAX_TEAM_REFRESH_DIAGNOSTIC_RECENT_NOTES = 50;

const buckets = new Map<string, TeamRefreshFanoutBucket>();

function createEmptyBucket(): TeamRefreshFanoutBucket {
  return {
    counts: {},
    structuredCounts: {},
    recent: [],
    lastAt: 0,
  };
}

function ensureTeamBucket(teamName: string): TeamRefreshFanoutBucket {
  if (!buckets.has(teamName) && buckets.size >= MAX_TEAM_REFRESH_DIAGNOSTIC_TEAMS) {
    const oldestKey = buckets.keys().next().value;
    if (oldestKey) {
      buckets.delete(oldestKey);
    }
  }

  let bucket = buckets.get(teamName);
  if (!bucket) {
    bucket = createEmptyBucket();
    buckets.set(teamName, bucket);
  }

  return bucket;
}

function cloneBucket(
  bucket: TeamRefreshFanoutBucket | undefined
): TeamRefreshFanoutSnapshot | null {
  if (!bucket) {
    return null;
  }

  return {
    counts: { ...bucket.counts },
    structuredCounts: Object.fromEntries(
      Object.entries(bucket.structuredCounts).map(([key, value]) => [key, { ...value }])
    ),
    recent: bucket.recent.map((note) => ({ ...note })),
    lastAt: bucket.lastAt,
  };
}

export function buildTeamRefreshFanoutCountKey(note: TeamRefreshFanoutNote): string {
  return `${note.surface}:${note.reason}:${note.operation}:${note.phase}`;
}

export function noteTeamRefreshFanout(note: TeamRefreshFanoutNote): void {
  if (!note.teamName || !note.reason || !note.operation) {
    return;
  }

  const bucket = ensureTeamBucket(note.teamName);
  const key = buildTeamRefreshFanoutCountKey(note);
  const now = Date.now();

  bucket.counts[key] = (bucket.counts[key] ?? 0) + 1;
  const existingStructured = bucket.structuredCounts[key];
  bucket.structuredCounts[key] = {
    key,
    count: (existingStructured?.count ?? 0) + 1,
    surface: note.surface,
    reason: note.reason,
    operation: note.operation,
    phase: note.phase,
  };
  bucket.lastAt = now;
  bucket.recent.push({
    at: now,
    surface: note.surface,
    phase: note.phase,
    reason: note.reason,
    operation: note.operation,
    eventType: note.eventType,
    tabId: note.tabId,
    selected: note.selected,
    visible: note.visible,
    activeTab: note.activeTab,
  });

  if (bucket.recent.length > MAX_TEAM_REFRESH_DIAGNOSTIC_RECENT_NOTES) {
    bucket.recent.splice(0, bucket.recent.length - MAX_TEAM_REFRESH_DIAGNOSTIC_RECENT_NOTES);
  }
}

function collectStructuredCounts(teamName?: string): TeamRefreshFanoutStructuredCount[] {
  if (teamName) {
    const bucket = buckets.get(teamName);
    return bucket ? Object.values(bucket.structuredCounts).map((row) => ({ ...row })) : [];
  }

  return Array.from(buckets.values()).flatMap((bucket) =>
    Object.values(bucket.structuredCounts).map((row) => ({ ...row }))
  );
}

export function getTeamRefreshFanoutSnapshot(
  teamName?: string
): TeamRefreshFanoutSnapshot | Record<string, TeamRefreshFanoutSnapshot> | null {
  if (teamName) {
    return cloneBucket(buckets.get(teamName));
  }

  return Object.fromEntries(
    Array.from(buckets.entries(), ([key, bucket]) => [key, cloneBucket(bucket)])
  ) as Record<string, TeamRefreshFanoutSnapshot>;
}

export function resetTeamRefreshFanoutDiagnostics(): void {
  buckets.clear();
}

export function summarizeTeamRefreshFanout(teamName?: string): TeamRefreshFanoutSummary {
  const aggregate = new Map<string, TeamRefreshFanoutSummaryRow>();

  for (const row of collectStructuredCounts(teamName)) {
    const existing = aggregate.get(row.key);
    aggregate.set(row.key, {
      ...row,
      count: (existing?.count ?? 0) + row.count,
    });
  }

  const rows = Array.from(aggregate.values()).sort(
    (a, b) =>
      b.count - a.count ||
      a.operation.localeCompare(b.operation) ||
      a.reason.localeCompare(b.reason) ||
      a.phase.localeCompare(b.phase)
  );

  return {
    generatedAt: Date.now(),
    ...(teamName ? { teamName } : {}),
    total: rows.reduce((sum, row) => sum + row.count, 0),
    rows,
  };
}

export const getTeamRefreshFanoutSnapshotForTests = getTeamRefreshFanoutSnapshot;
export const __resetTeamRefreshFanoutDiagnosticsForTests = resetTeamRefreshFanoutDiagnostics;
