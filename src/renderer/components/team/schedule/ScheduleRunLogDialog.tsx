import React, { useEffect, useState } from 'react';

import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { useStore } from '@renderer/store';
import { AlertTriangle, Clock, Loader2, Terminal } from 'lucide-react';

import { CliLogsRichView } from '../CliLogsRichView';
import { RunStatusBadge } from './ScheduleStatusBadge';

import type { ScheduleRun } from '@shared/types';

// =============================================================================
// Props
// =============================================================================

interface ScheduleRunLogDialogProps {
  open: boolean;
  /** Initial run snapshot — used to identify the run; live data comes from store */
  run: ScheduleRun | null;
  scheduleId: string;
  onClose: () => void;
}

// =============================================================================
// Helpers
// =============================================================================

function formatTime(isoString: string): string {
  try {
    return new Date(isoString).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return isoString;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

// =============================================================================
// Component
// =============================================================================

export const ScheduleRunLogDialog = ({
  open,
  run: initialRun,
  scheduleId,
  onClose,
}: ScheduleRunLogDialogProps): React.JSX.Element => {
  // Read live run data from store — falls back to initial prop if not found
  const liveRun = useStore((s) => {
    if (!initialRun) return null;
    const runs = s.scheduleRuns[scheduleId] ?? [];
    return runs.find((r) => r.id === initialRun.id) ?? initialRun;
  });
  const run = liveRun ?? initialRun;

  const [logs, setLogs] = useState<{ stdout: string; stderr: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runStatus = run?.status;
  const runId = run?.id;

  useEffect(() => {
    if (!open || !run) {
      setLogs(null);
      setError(null);
      return;
    }

    // Only fetch logs for completed/failed runs (not running/pending)
    const hasLogs =
      runStatus === 'completed' || runStatus === 'failed' || runStatus === 'failed_interrupted';
    if (!hasLogs) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const result = await api.schedules.getRunLogs(scheduleId, runId!);
        if (!cancelled) {
          setLogs(result);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load logs');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, runId, runStatus, scheduleId]);

  if (!run) return <></>;

  const isRunning =
    run.status === 'running' ||
    run.status === 'warming_up' ||
    run.status === 'warm' ||
    run.status === 'pending';
  const hasStderr = logs?.stderr && logs.stderr.trim().length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Terminal className="size-4" />
            Run Log
          </DialogTitle>
        </DialogHeader>

        {/* Metadata */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
          <RunStatusBadge status={run.status} />

          <span className="flex items-center gap-1 text-[var(--color-text-muted)]">
            <Clock className="size-3" />
            {formatTime(run.startedAt)}
          </span>

          {run.durationMs != null ? (
            <span className="text-[var(--color-text-muted)]">{formatDuration(run.durationMs)}</span>
          ) : null}

          {run.exitCode != null ? (
            <span
              className={`font-mono ${run.exitCode === 0 ? 'text-emerald-400' : 'text-red-400'}`}
            >
              exit {run.exitCode}
            </span>
          ) : null}

          {run.retryCount > 0 ? (
            <span className="text-[var(--color-text-muted)]">retry {run.retryCount}/2</span>
          ) : null}
        </div>

        {/* Content */}
        <div className="space-y-3">
          {/* Running state */}
          {isRunning ? (
            <div className="flex items-center gap-2 rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-xs text-[var(--color-text-secondary)]">
              <Loader2 className="size-4 animate-spin" />
              Task is still running...
              {run.summary ? (
                <span className="ml-2 truncate text-[var(--color-text-muted)]">{run.summary}</span>
              ) : null}
            </div>
          ) : null}

          {/* Loading */}
          {loading ? (
            <div className="flex items-center justify-center py-6 text-xs text-[var(--color-text-muted)]">
              <Loader2 className="mr-2 size-4 animate-spin" />
              Loading logs...
            </div>
          ) : null}

          {/* Error loading logs */}
          {error ? (
            <div className="flex items-start gap-2 rounded border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

          {/* Stdout — rich stream-json view (falls back to plain text for old logs) */}
          {logs ? (
            <>
              <CliLogsRichView
                cliLogsTail={logs.stdout}
                order="oldest-first"
                className="max-h-[400px]"
              />

              {/* Stderr */}
              {hasStderr ? (
                <div>
                  <div className="mb-1 text-[11px] font-medium text-red-400">Errors</div>
                  <pre className="max-h-[200px] overflow-auto whitespace-pre-wrap rounded border border-red-500/30 bg-red-500/5 p-3 font-mono text-xs leading-relaxed text-red-300">
                    {logs.stderr}
                  </pre>
                </div>
              ) : null}
            </>
          ) : null}

          {/* Run error message (from ScheduleRun.error) */}
          {!isRunning && run.error && !logs ? (
            <div className="flex items-start gap-2 rounded border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span className="whitespace-pre-wrap">{run.error}</span>
            </div>
          ) : null}
        </div>

        <DialogFooter className="pt-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
