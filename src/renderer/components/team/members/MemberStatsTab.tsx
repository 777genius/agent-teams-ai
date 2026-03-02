import { useEffect, useState } from 'react';

import { api } from '@renderer/api';
import { cn } from '@renderer/lib/utils';
import { formatRelativeTime } from '@renderer/utils/formatters';
import { getBasename } from '@shared/utils/platformPath';
import { formatTokensCompact } from '@shared/utils/tokenFormatting';
import {
  AlertCircle,
  BarChart3,
  ChevronDown,
  ChevronRight,
  FileCode,
  Info,
  Loader2,
} from 'lucide-react';

import type { FileLineStats, MemberFullStats } from '@shared/types';

interface MemberStatsTabProps {
  teamName: string;
  memberName: string;
  prefetchedStats?: MemberFullStats | null;
  prefetchedLoading?: boolean;
  prefetchedError?: string | null;
  onFileClick?: (filePath: string) => void;
  onShowAllFiles?: () => void;
}

export const MemberStatsTab = ({
  teamName,
  memberName,
  prefetchedStats,
  prefetchedLoading,
  prefetchedError,
  onFileClick,
  onShowAllFiles,
}: MemberStatsTabProps): React.JSX.Element => {
  const usePrefetched = prefetchedStats !== undefined;

  const [localStats, setLocalStats] = useState<MemberFullStats | null>(null);
  const [localLoading, setLocalLoading] = useState(!usePrefetched);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (usePrefetched) return;

    let cancelled = false;
    setLocalLoading(true);
    setLocalError(null);

    void (async () => {
      try {
        const result = await api.teams.getMemberStats(teamName, memberName);
        if (!cancelled) setLocalStats(result);
      } catch (e) {
        if (!cancelled) setLocalError(e instanceof Error ? e.message : 'Unknown error');
      } finally {
        if (!cancelled) setLocalLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [teamName, memberName, usePrefetched]);

  const stats = usePrefetched ? (prefetchedStats ?? null) : localStats;
  const loading = usePrefetched ? (prefetchedLoading ?? false) : localLoading;
  const error = usePrefetched ? (prefetchedError ?? null) : localError;

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-xs text-[var(--color-text-muted)]">
        <Loader2 size={14} className="animate-spin" />
        Computing stats...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-xs text-red-400">
        <AlertCircle size={14} />
        {error}
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="py-8 text-center text-xs text-[var(--color-text-muted)]">
        <BarChart3 size={20} className="mx-auto mb-2 opacity-40" />
        No stats available
      </div>
    );
  }

  const totalTokens = stats.inputTokens + stats.outputTokens;
  const totalToolCalls = Object.values(stats.toolUsage).reduce((sum, c) => sum + c, 0);

  return (
    <div className="max-h-[400px] space-y-3 overflow-y-auto pr-1">
      <SummaryCards stats={stats} totalTokens={totalTokens} totalToolCalls={totalToolCalls} />
      <ToolUsageBars toolUsage={stats.toolUsage} />
      <FilesTouchedSection
        files={stats.filesTouched}
        fileStats={stats.fileStats}
        onFileClick={onFileClick}
        onShowAll={onShowAllFiles}
      />
      <StatsFooter stats={stats} />
    </div>
  );
};

const StatCard = ({
  label,
  value,
  sub,
  info,
}: {
  label: string;
  value: string | number;
  sub?: string;
  info?: string;
}): React.JSX.Element => (
  <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2">
    <p className="text-lg font-semibold text-[var(--color-text)]">{value}</p>
    <div className="flex items-center gap-1">
      <p className="text-[11px] text-[var(--color-text-muted)]">{label}</p>
      {info && (
        <span className="group relative">
          <Info
            size={10}
            className="cursor-help text-[var(--color-text-muted)] opacity-50 hover:opacity-80"
          />
          <span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 w-52 -translate-x-1/2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-overlay)] px-2.5 py-2 text-[10px] leading-relaxed text-[var(--color-text-secondary)] opacity-0 shadow-lg transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
            {info}
          </span>
        </span>
      )}
    </div>
    {sub && <p className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">{sub}</p>}
  </div>
);

const SummaryCards = ({
  stats,
  totalTokens,
  totalToolCalls,
}: {
  stats: MemberFullStats;
  totalTokens: number;
  totalToolCalls: number;
}): React.JSX.Element => (
  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
    <StatCard
      label="Lines"
      value={`+${stats.linesAdded}`}
      sub={stats.linesRemoved > 0 ? `-${stats.linesRemoved}` : undefined}
      info="Approximate. Accurate for Edit and Write tools. Bash file writes are estimated from command patterns (heredoc, echo, sed) and may be underreported."
    />
    <StatCard label="Files" value={stats.filesTouched.length} />
    <StatCard label="Tool Calls" value={totalToolCalls} />
    <StatCard label="Tokens" value={formatTokensCompact(totalTokens)} />
  </div>
);

const ToolUsageBars = ({
  toolUsage,
}: {
  toolUsage: Record<string, number>;
}): React.JSX.Element | null => {
  const entries = Object.entries(toolUsage).sort(([, a], [, b]) => b - a);
  if (entries.length === 0) return null;

  const maxCount = entries[0][1];

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <p className="mb-2 text-[11px] font-medium text-[var(--color-text-secondary)]">Tool Usage</p>
      <div className="space-y-1.5">
        {entries.map(([name, count]) => (
          <div key={name} className="flex items-center gap-2 text-[11px]">
            <span className="w-16 shrink-0 truncate text-right text-[var(--color-text-muted)]">
              {name}
            </span>
            <div className="h-3.5 flex-1 overflow-hidden rounded-sm bg-[var(--color-surface-raised)]">
              <div
                className="h-full rounded-sm bg-blue-500/40"
                style={{ width: `${(count / maxCount) * 100}%` }}
              />
            </div>
            <span className="w-8 shrink-0 text-right tabular-nums text-[var(--color-text-muted)]">
              {count}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

const TRAILING_PUNCT = ';.,';

function isInvalidPath(path: string): boolean {
  let trimmed = path.trim();
  let end = trimmed.length;
  while (end > 0 && TRAILING_PUNCT.includes(trimmed[end - 1])) {
    end--;
  }
  trimmed = trimmed.slice(0, end);
  return !trimmed || trimmed === 'null' || trimmed === 'undefined' || trimmed === 'None';
}

const FilesTouchedSection = ({
  files,
  fileStats,
  onFileClick,
  onShowAll,
}: {
  files: string[];
  fileStats?: Record<string, FileLineStats>;
  onFileClick?: (filePath: string) => void;
  onShowAll?: () => void;
}): React.JSX.Element | null => {
  const [expanded, setExpanded] = useState(false);

  const validFiles = files.filter((f) => !isInvalidPath(f));
  if (validFiles.length === 0) return null;

  const visibleFiles = expanded ? validFiles : validFiles.slice(0, 5);
  const hiddenCount = validFiles.length - 5;
  const isClickable = !!onFileClick;

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[11px] font-medium text-[var(--color-text-secondary)]">
          Files Touched ({validFiles.length})
        </p>
        {onShowAll && (
          <button className="text-[10px] text-blue-400 hover:text-blue-300" onClick={onShowAll}>
            View All Changes
          </button>
        )}
      </div>
      <div className="space-y-0.5">
        {visibleFiles.map((filePath) => {
          const basename = getBasename(filePath) || filePath;
          const fStats = fileStats?.[filePath];
          return (
            <button
              key={filePath}
              type="button"
              className={cn(
                'flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] text-[var(--color-text-muted)]',
                isClickable &&
                  'cursor-pointer hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text-secondary)]'
              )}
              title={filePath}
              onClick={() => onFileClick?.(filePath)}
              disabled={!isClickable}
            >
              <FileCode size={10} className="shrink-0 opacity-50" />
              <span className="min-w-0 truncate">{basename}</span>
              {fStats && (fStats.added > 0 || fStats.removed > 0) && (
                <span className="flex shrink-0 items-center gap-1 font-mono text-[10px]">
                  {fStats.added > 0 && <span className="text-emerald-400">+{fStats.added}</span>}
                  {fStats.removed > 0 && <span className="text-red-400">-{fStats.removed}</span>}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {hiddenCount > 0 && (
        <button
          className="mt-1.5 flex items-center gap-1 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          {expanded ? 'Show less' : `+${hiddenCount} more`}
        </button>
      )}
    </div>
  );
};

const StatsFooter = ({ stats }: { stats: MemberFullStats }): React.JSX.Element => {
  const computedAgo = formatRelativeTime(stats.computedAt);

  return (
    <div className="text-center text-[10px] text-[var(--color-text-muted)]">
      {stats.sessionCount} session{stats.sessionCount !== 1 ? 's' : ''} · computed {computedAgo}
    </div>
  );
};
