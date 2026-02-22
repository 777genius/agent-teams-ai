import { useEffect, useState } from 'react';

import { api } from '@renderer/api';
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

import type { MemberFullStats } from '@shared/types';

interface MemberStatsTabProps {
  teamName: string;
  memberName: string;
}

export const MemberStatsTab = ({
  teamName,
  memberName,
}: MemberStatsTabProps): React.JSX.Element => {
  const [stats, setStats] = useState<MemberFullStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const result = await api.teams.getMemberStats(teamName, memberName);
        if (!cancelled) {
          setStats(result);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Unknown error');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [teamName, memberName]);

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
      <FilesTouchedSection files={stats.filesTouched} />
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

const FilesTouchedSection = ({ files }: { files: string[] }): React.JSX.Element | null => {
  const [expanded, setExpanded] = useState(false);
  if (files.length === 0) return null;

  const visibleFiles = expanded ? files : files.slice(0, 5);
  const hiddenCount = files.length - 5;

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <p className="mb-2 text-[11px] font-medium text-[var(--color-text-secondary)]">
        Files Touched ({files.length})
      </p>
      <div className="space-y-0.5">
        {visibleFiles.map((filePath) => {
          const basename = filePath.split('/').pop() ?? filePath;
          return (
            <div
              key={filePath}
              className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]"
              title={filePath}
            >
              <FileCode size={10} className="shrink-0 opacity-50" />
              <span className="truncate">{basename}</span>
            </div>
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

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMin / 60);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return date.toLocaleDateString();
}
