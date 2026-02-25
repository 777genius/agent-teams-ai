import { useEffect, useRef, useState } from 'react';

import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { cn } from '@renderer/lib/utils';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';

import { MarkdownViewer } from '../chat/viewers/MarkdownViewer';

import { CliLogsRichView } from './CliLogsRichView';
import { STEP_LABELS, STEP_ORDER } from './provisioningSteps';

import type { ProvisioningStep } from './provisioningSteps';

export interface ProvisioningProgressBlockProps {
  /** Title above the steps, e.g. "Launching team" */
  title: string;
  /** Optional status message */
  message?: string | null;
  /** Index of the current step in STEP_ORDER (0-based), or -1 if unknown */
  currentStepIndex: number;
  /** Show spinner next to title */
  loading?: boolean;
  /** Cancel button label and handler */
  onCancel?: (() => void) | null;
  /** ISO timestamp when provisioning started */
  startedAt?: string;
  /** PID of the CLI process */
  pid?: number;
  /** Tail of CLI logs */
  cliLogsTail?: string;
  /** Accumulated assistant text output for live preview */
  assistantOutput?: string;
  className?: string;
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function useElapsedTimer(startedAt?: string): string | null {
  const [elapsed, setElapsed] = useState<string | null>(null);

  useEffect(() => {
    if (!startedAt) return () => setElapsed(null);
    const startMs = Date.parse(startedAt);
    if (isNaN(startMs)) return () => setElapsed(null);

    const tick = (): void => {
      const seconds = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
      setElapsed(formatElapsed(seconds));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [startedAt]);

  if (!startedAt) return null;
  return elapsed;
}

export const ProvisioningProgressBlock = ({
  title,
  message,
  currentStepIndex,
  loading = false,
  onCancel,
  startedAt,
  pid,
  cliLogsTail,
  assistantOutput,
  className,
}: ProvisioningProgressBlockProps): React.JSX.Element => {
  const elapsed = useElapsedTimer(startedAt);
  const [logsOpen, setLogsOpen] = useState(false);
  const outputScrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll assistant output
  useEffect(() => {
    if (outputScrollRef.current) {
      outputScrollRef.current.scrollTop = outputScrollRef.current.scrollHeight;
    }
  }, [assistantOutput]);

  return (
    <div
      className={cn(
        'rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2',
        className
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {loading ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-[var(--color-text-muted)]" />
          ) : null}
          <p className="text-xs font-medium text-[var(--color-text)]">{title}</p>
          {elapsed !== null ? (
            <span className="text-[10px] tabular-nums text-[var(--color-text-muted)]">
              {elapsed}
            </span>
          ) : null}
          {pid !== undefined ? (
            <span className="text-[10px] text-[var(--color-text-muted)]">PID {pid}</span>
          ) : null}
        </div>
        {onCancel ? (
          <Button
            variant="outline"
            size="sm"
            className="h-6 shrink-0 px-2 text-xs"
            onClick={onCancel}
          >
            Cancel
          </Button>
        ) : null}
      </div>
      {message ? <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">{message}</p> : null}
      <div className="mt-2 flex items-center gap-1 overflow-x-auto pb-0.5">
        {STEP_ORDER.filter((s): s is ProvisioningStep => s !== 'ready').map((step, index) => {
          const isDone = currentStepIndex >= 0 && index < currentStepIndex;
          const isCurrent = currentStepIndex >= 0 && index === currentStepIndex;

          return (
            <div key={step} className="flex items-center gap-1">
              {/* eslint-disable tailwindcss/no-custom-classname -- theme CSS vars */}
              <Badge
                variant="secondary"
                className={cn(
                  'whitespace-nowrap px-2 py-0.5 text-[11px] font-normal',
                  isDone && 'border-emerald-400/60 bg-emerald-500/10 text-emerald-200',
                  isCurrent &&
                    'border-[var(--color-accent)]/70 bg-[var(--color-accent)]/15 text-[var(--color-text)]'
                )}
              >
                <span className="mr-1 inline-flex size-4 items-center justify-center rounded-full border border-current text-[10px]">
                  {index + 1}
                </span>
                {STEP_LABELS[step]}
              </Badge>
              {/* eslint-enable tailwindcss/no-custom-classname -- end theme CSS vars block */}
              {index < STEP_ORDER.filter((s) => s !== 'ready').length - 1 ? (
                <span className="text-[var(--color-text-muted)]">&rarr;</span>
              ) : null}
            </div>
          );
        })}
      </div>
      {assistantOutput ? (
        <div className="mt-2">
          <p className="mb-1 text-[11px] font-medium text-[var(--color-text-muted)]">Live output</p>
          <div
            ref={outputScrollRef}
            className="max-h-[400px] overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2"
          >
            <MarkdownViewer content={assistantOutput} bare maxHeight="max-h-none" />
          </div>
        </div>
      ) : null}
      {cliLogsTail ? (
        <div className="mt-2">
          <button
            type="button"
            className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
            onClick={() => setLogsOpen((v) => !v)}
          >
            {logsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            CLI logs
          </button>
          {logsOpen ? <CliLogsRichView cliLogsTail={cliLogsTail} className="mt-1" /> : null}
        </div>
      ) : null}
    </div>
  );
};
