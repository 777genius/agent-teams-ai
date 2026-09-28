/** Opaque identity is scoped by the source. Display names are never navigation keys. */
export interface TeamDirectoryIdentity {
  readonly scopeKey: string;
  readonly targetKey: string;
}

/** The adapter must provide runtime evidence; a lifecycle label alone is insufficient. */
export type TeamDirectoryRuntime = 'running' | 'offline' | 'unknown';

interface TeamDirectoryRowBase extends TeamDirectoryIdentity {
  readonly displayName: string;
  readonly runtime: TeamDirectoryRuntime;
}

export interface DesktopTeamDirectoryRow extends TeamDirectoryRowBase {
  readonly source: 'desktop';
  readonly teamName: string;
  readonly description: string;
  readonly matchesCurrentProject: boolean;
  /** Boundary-normalized finite timestamp, or null when no valid activity fact exists. */
  readonly lastActivityMs: number | null;
}

export interface HostedTeamDirectoryRow extends TeamDirectoryRowBase {
  readonly source: 'hosted';
  /** Only fields explicitly supplied by the Hosted source may be included. */
  readonly safeSearchTokens?: readonly string[];
}

export type TeamDirectoryRow = DesktopTeamDirectoryRow | HostedTeamDirectoryRow;

export interface TeamDirectoryFilter {
  readonly query: string;
  /** An empty selection means All. Selected statuses are combined as a union. */
  readonly selectedStatuses: ReadonlySet<'running' | 'offline'>;
}

function identityOrder(a: TeamDirectoryIdentity, b: TeamDirectoryIdentity): number {
  return a.scopeKey.localeCompare(b.scopeKey) || a.targetKey.localeCompare(b.targetKey);
}

function rowMatchesQuery(row: TeamDirectoryRow, query: string): boolean {
  if (!query) return true;
  const fields =
    row.source === 'desktop'
      ? [row.teamName, row.displayName, row.description]
      : [row.displayName, ...(row.safeSearchTokens ?? [])];
  return fields.some((field) => field.toLowerCase().includes(query));
}

function compareRows(a: TeamDirectoryRow, b: TeamDirectoryRow): number {
  // A known running row is first. Unknown and known offline retain source ordering.
  const running = Number(b.runtime === 'running') - Number(a.runtime === 'running');
  if (running) return running;

  if (a.source === 'desktop' && b.source === 'desktop') {
    const project = Number(b.matchesCurrentProject) - Number(a.matchesCurrentProject);
    if (project) return project;
    const activity =
      (b.lastActivityMs !== null && Number.isFinite(b.lastActivityMs) ? b.lastActivityMs : 0) -
      (a.lastActivityMs !== null && Number.isFinite(a.lastActivityMs) ? a.lastActivityMs : 0);
    if (activity) return activity;
    return a.teamName.localeCompare(b.teamName) || identityOrder(a, b);
  }

  if (a.source === 'hosted' && b.source === 'hosted') {
    return a.displayName.localeCompare(b.displayName) || identityOrder(a, b);
  }

  // Mixed-source snapshots are not expected, but still have a stable order.
  return a.source.localeCompare(b.source) || identityOrder(a, b);
}

/** Pure projection of an already complete source snapshot. It never loads or caches rows. */
export function buildTeamDirectoryRows<T extends TeamDirectoryRow>(
  rows: readonly T[],
  filter: TeamDirectoryFilter
): T[] {
  const query = filter.query.trim().toLowerCase();
  return rows
    .filter(
      (row) =>
        rowMatchesQuery(row, query) &&
        (filter.selectedStatuses.size === 0 ||
          (row.runtime !== 'unknown' && filter.selectedStatuses.has(row.runtime)))
    )
    .sort(compareRows);
}

export interface TeamDirectoryOpenIntent extends TeamDirectoryIdentity {
  readonly readEpoch: number;
}

/** Re-resolve a click against the current scope and read epoch before navigation. */
export function resolveTeamDirectoryOpenIntent<T extends TeamDirectoryRow>(
  intent: TeamDirectoryOpenIntent,
  current: Readonly<{
    scopeKey: string;
    readEpoch: number;
    rows: readonly T[];
  }>
): T | null {
  if (intent.scopeKey !== current.scopeKey || intent.readEpoch !== current.readEpoch) {
    return null;
  }
  return (
    current.rows.find(
      (row) => row.scopeKey === intent.scopeKey && row.targetKey === intent.targetKey
    ) ?? null
  );
}
