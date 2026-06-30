import { useEffect, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
import { selectTeamDataForName } from '@renderer/store/team/teamDataSelectors';
import { formatTokensCompact } from '@shared/utils/tokenFormatting';
import { AlertCircle, BarChart3, Loader2, RefreshCw } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import type { MemberFullStats, TeamMemberSnapshot } from '@shared/types';

interface TeamUsageTabProps {
  teamName: string;
}

interface MemberUsageRow {
  member: TeamMemberSnapshot;
  stats: MemberFullStats | null;
  error: string | null;
}

function totalTokens(stats: MemberFullStats): number {
  return stats.inputTokens + stats.outputTokens + stats.cacheReadTokens;
}

function formatNumber(value: number): string {
  return value.toLocaleString();
}

function translate(
  t: ReturnType<typeof useAppTranslation>['t'],
  key: string,
  fallback: string,
  options?: Record<string, unknown>
): string {
  return (t as (translationKey: string, options?: Record<string, unknown>) => string)(key, {
    ...options,
    defaultValue: fallback,
  });
}

const UsageMetric = ({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}): React.JSX.Element => (
  <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-4 py-3">
    <div className="text-xl font-semibold tabular-nums text-[var(--color-text)]">{value}</div>
    <div className="mt-1 text-xs text-[var(--color-text-muted)]">{label}</div>
    {sub ? <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{sub}</div> : null}
  </div>
);

export const TeamUsageTab = ({ teamName }: TeamUsageTabProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [rows, setRows] = useState<MemberUsageRow[]>([]);
  const [statsLoading, setStatsLoading] = useState(false);

  const { data, teamLoading, teamError, selectTeam } = useStore(
    useShallow((s) => ({
      data: selectTeamDataForName(s, teamName),
      teamLoading: s.selectedTeamName === teamName ? s.selectedTeamLoading : false,
      teamError: s.selectedTeamName === teamName ? s.selectedTeamError : null,
      selectTeam: s.selectTeam,
    }))
  );

  useEffect(() => {
    if (!data && !teamLoading) {
      void selectTeam(teamName);
    }
  }, [data, selectTeam, teamLoading, teamName]);

  const members = useMemo(() => data?.members ?? [], [data?.members]);
  const memberNamesKey = useMemo(() => members.map((member) => member.name).join('\0'), [members]);

  useEffect(() => {
    if (members.length === 0) {
      setRows([]);
      setStatsLoading(false);
      return;
    }

    let cancelled = false;
    setStatsLoading(true);

    void (async () => {
      const nextRows = await Promise.all(
        members.map(async (member): Promise<MemberUsageRow> => {
          try {
            const stats = await api.teams.getMemberStats(teamName, member.name);
            return { member, stats, error: null };
          } catch (error) {
            return {
              member,
              stats: null,
              error: error instanceof Error ? error.message : 'Unknown error',
            };
          }
        })
      );

      if (!cancelled) {
        setRows(nextRows);
        setStatsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [memberNamesKey, members, refreshNonce, teamName]);

  const sortedRows = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const aTokens = a.stats ? totalTokens(a.stats) : -1;
        const bTokens = b.stats ? totalTokens(b.stats) : -1;
        if (aTokens !== bTokens) return bTokens - aTokens;
        return a.member.name.localeCompare(b.member.name);
      }),
    [rows]
  );

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, row) => {
          if (!row.stats) return acc;
          acc.total += totalTokens(row.stats);
          acc.input += row.stats.inputTokens;
          acc.output += row.stats.outputTokens;
          acc.cacheRead += row.stats.cacheReadTokens;
          acc.messages += row.stats.messageCount;
          acc.sessions += row.stats.sessionCount;
          return acc;
        },
        { total: 0, input: 0, output: 0, cacheRead: 0, messages: 0, sessions: 0 }
      ),
    [rows]
  );

  const teamDisplayName = data?.config.name || teamName;
  const maxMemberTokens = Math.max(
    ...rows.map((row) => (row.stats ? totalTokens(row.stats) : 0)),
    0
  );
  const failedCount = rows.filter((row) => row.error).length;
  const loading = teamLoading || statsLoading;

  return (
    <div className="flex-1 overflow-auto bg-[var(--color-surface)]">
      <div className="mx-auto w-full max-w-5xl px-6 py-6">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <BarChart3 className="size-5 text-[var(--color-text-muted)]" />
              <h1 className="truncate text-lg font-semibold text-[var(--color-text)]">
                {translate(t, 'usage.title', '{{team}} Usage', { team: teamDisplayName })}
              </h1>
            </div>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              {translate(t, 'usage.description', 'Token usage by team member.')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setRefreshNonce((value) => value + 1)}
            disabled={loading || members.length === 0}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-raised)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
            {translate(t, 'usage.refresh', 'Refresh')}
          </button>
        </div>

        {teamError ? (
          <div className="mb-4 flex items-center gap-2 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            <AlertCircle className="size-4" />
            {teamError}
          </div>
        ) : null}

        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <UsageMetric
            label={translate(t, 'usage.totalTokens', 'Total tokens')}
            value={formatTokensCompact(totals.total)}
          />
          <UsageMetric
            label={translate(t, 'usage.inputTokens', 'Input')}
            value={formatTokensCompact(totals.input)}
          />
          <UsageMetric
            label={translate(t, 'usage.outputTokens', 'Output')}
            value={formatTokensCompact(totals.output)}
          />
          <UsageMetric
            label={translate(t, 'usage.messages', 'Messages')}
            value={formatNumber(totals.messages)}
            sub={translate(t, 'usage.sessions', '{{count}} sessions', { count: totals.sessions })}
          />
        </div>

        <div className="overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
          <div className="grid grid-cols-[minmax(180px,1.4fr)_minmax(160px,1fr)_repeat(4,minmax(80px,0.7fr))] gap-3 border-b border-[var(--color-border)] px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
            <div>{translate(t, 'usage.member', 'Member')}</div>
            <div>{translate(t, 'usage.share', 'Share')}</div>
            <div className="text-right">{translate(t, 'usage.total', 'Total')}</div>
            <div className="text-right">{translate(t, 'usage.input', 'Input')}</div>
            <div className="text-right">{translate(t, 'usage.output', 'Output')}</div>
            <div className="text-right">{translate(t, 'usage.cacheRead', 'Cache')}</div>
          </div>

          {loading && rows.length === 0 ? (
            <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-[var(--color-text-muted)]">
              <Loader2 className="size-4 animate-spin" />
              {translate(t, 'usage.loading', 'Loading usage...')}
            </div>
          ) : members.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-[var(--color-text-muted)]">
              {translate(t, 'usage.empty', 'No team members yet.')}
            </div>
          ) : (
            <div className="divide-y divide-[var(--color-border-subtle)]">
              {sortedRows.map((row) => {
                const stats = row.stats;
                const memberTokens = stats ? totalTokens(stats) : 0;
                const share = maxMemberTokens > 0 ? (memberTokens / maxMemberTokens) * 100 : 0;

                return (
                  <div
                    key={row.member.name}
                    className="grid grid-cols-[minmax(180px,1.4fr)_minmax(160px,1fr)_repeat(4,minmax(80px,0.7fr))] items-center gap-3 px-4 py-3 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium text-[var(--color-text)]">
                        {row.member.name}
                      </div>
                      <div className="truncate text-xs text-[var(--color-text-muted)]">
                        {row.member.role || row.member.agentType || row.member.providerId || '-'}
                      </div>
                    </div>
                    <div>
                      <div className="h-2 overflow-hidden rounded-full bg-[var(--color-surface-raised)]">
                        <div
                          className="h-full rounded-full bg-emerald-500/60"
                          style={{ width: `${share}%` }}
                        />
                      </div>
                      {row.error ? (
                        <div className="mt-1 truncate text-[11px] text-red-300" title={row.error}>
                          {row.error}
                        </div>
                      ) : null}
                    </div>
                    <div className="text-right tabular-nums text-[var(--color-text)]">
                      {stats ? formatTokensCompact(memberTokens) : '-'}
                    </div>
                    <div className="text-right tabular-nums text-[var(--color-text-muted)]">
                      {stats ? formatTokensCompact(stats.inputTokens) : '-'}
                    </div>
                    <div className="text-right tabular-nums text-[var(--color-text-muted)]">
                      {stats ? formatTokensCompact(stats.outputTokens) : '-'}
                    </div>
                    <div className="text-right tabular-nums text-[var(--color-text-muted)]">
                      {stats ? formatTokensCompact(stats.cacheReadTokens) : '-'}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {failedCount > 0 ? (
          <p className="mt-3 text-xs text-[var(--color-text-muted)]">
            {translate(t, 'usage.partialFailure', '{{count}} member stats failed to load.', {
              count: failedCount,
            })}
          </p>
        ) : null}
      </div>
    </div>
  );
};
