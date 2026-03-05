import { useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import { cn } from '@renderer/lib/utils';
import { Terminal } from 'lucide-react';

import { CollapsibleTeamSection } from './CollapsibleTeamSection';
import { CliLogsRichView } from './CliLogsRichView';

import type { TeamClaudeLogsResponse } from '@shared/types';

const PAGE_SIZE = 100;
const POLL_MS = 2000;
const ONLINE_WINDOW_MS = 10_000;

interface ClaudeLogsSectionProps {
  teamName: string;
}

function isRecent(updatedAt: string | undefined): boolean {
  if (!updatedAt) return false;
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return false;
  return Date.now() - t <= ONLINE_WINDOW_MS;
}

function normalizeToStreamJsonText(linesNewestFirst: string[]): string {
  // We want to feed CliLogsRichView the exact format it expects:
  // - marker lines: "[stdout]" / "[stderr]"
  // - raw JSON lines without any "[stdout] " prefix
  const chronological = [...linesNewestFirst].reverse();

  const out: string[] = [];
  let lastStream: 'stdout' | 'stderr' | null = null;

  const pushMarker = (stream: 'stdout' | 'stderr'): void => {
    if (lastStream === stream) return;
    lastStream = stream;
    out.push(stream === 'stdout' ? '[stdout]' : '[stderr]');
  };

  for (const rawLine of chronological) {
    const line = rawLine ?? '';
    if (line === '[stdout]' || line === '[stderr]') {
      lastStream = line === '[stdout]' ? 'stdout' : 'stderr';
      out.push(line);
      continue;
    }

    if (line.startsWith('[stdout] ')) {
      pushMarker('stdout');
      out.push(line.slice('[stdout] '.length));
      continue;
    }
    if (line.startsWith('[stderr] ')) {
      pushMarker('stderr');
      out.push(line.slice('[stderr] '.length));
      continue;
    }

    out.push(line);
  }

  return out.join('\n');
}

export const ClaudeLogsSection = ({ teamName }: ClaudeLogsSectionProps): React.JSX.Element => {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [data, setData] = useState<TeamClaudeLogsResponse>({ lines: [], total: 0, hasMore: false });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
    setData({ lines: [], total: 0, hasMore: false });
    setError(null);
  }, [teamName]);

  useEffect(() => {
    let cancelled = false;

    const fetchLogs = async (): Promise<void> => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        setLoading(true);
        const next = await api.teams.getClaudeLogs(teamName, { offset: 0, limit: visibleCount });
        if (cancelled) return;
        setData(next);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        inFlightRef.current = false;
        if (!cancelled) setLoading(false);
      }
    };

    void fetchLogs();
    const id = window.setInterval(() => void fetchLogs(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [teamName, visibleCount]);

  const online = useMemo(() => isRecent(data.updatedAt), [data.updatedAt]);
  const badge = data.total > 0 ? data.total : undefined;
  const showMoreVisible = data.hasMore;

  const headerExtra = online ? (
    <span className="pointer-events-none relative inline-flex size-2 shrink-0" title="Updating">
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50" />
      <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
    </span>
  ) : null;

  return (
    <CollapsibleTeamSection
      sectionId="claude-logs"
      title="Claude logs"
      icon={<Terminal size={14} />}
      badge={badge}
      headerExtra={headerExtra}
      defaultOpen
      contentClassName="pt-0"
    >
      <div className="flex items-center justify-between gap-2 pb-2">
        <span className="text-[11px] text-[var(--color-text-muted)]">
          {data.total > 0 ? (
            <>
              Showing <span className="font-mono">{Math.min(data.total, visibleCount)}</span> of{' '}
              <span className="font-mono">{data.total}</span>
            </>
          ) : (
            'No logs yet.'
          )}
        </span>
        {showMoreVisible && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
          >
            Show more
          </Button>
        )}
      </div>

      <div
        className={cn(
          'rounded',
          loading && 'opacity-80'
        )}
      >
        {error ? <p className="p-2 text-xs text-red-300">{error}</p> : null}
        {!error && data.lines.length > 0 ? (
          <CliLogsRichView
            // Parser expects chronological order; UI shows newest-first.
            cliLogsTail={normalizeToStreamJsonText(data.lines)}
            order="newest-first"
            className="max-h-[320px] p-2"
          />
        ) : null}
        {!error && data.lines.length === 0 ? (
          <p className="p-2 text-xs text-[var(--color-text-muted)]">
            {loading ? 'Loading…' : 'No logs captured.'}
          </p>
        ) : null}
      </div>
    </CollapsibleTeamSection>
  );
};

