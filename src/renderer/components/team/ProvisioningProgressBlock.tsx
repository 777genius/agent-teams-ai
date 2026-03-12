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
  /** Visual tone (e.g. highlight errors) */
  tone?: 'default' | 'error';
  /** Whether Live output is expanded by default */
  defaultLiveOutputOpen?: boolean;
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
  /** CLI logs captured during launch */
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

function useElapsedTimer(startedAt?: string, isRunning = true): string | null {
  const [elapsedSeconds, setElapsedSeconds] = useState<number | null>(null);

  useEffect(() => {
    if (!startedAt) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync on prop change
      setElapsedSeconds(null);
      return;
    }

    const startMs = Date.parse(startedAt);
    if (isNaN(startMs)) {
      setElapsedSeconds(null);
      return;
    }

    const computeElapsedSeconds = (): number =>
      Math.max(0, Math.floor((Date.now() - startMs) / 1000));

    if (!isRunning) {
      // Freeze timer on terminal states (failed/ready/cancelled) instead of continuing to tick.
      setElapsedSeconds((prev) => (prev === null ? computeElapsedSeconds() : prev));
      return;
    }

    const tick = (): void => {
      setElapsedSeconds(computeElapsedSeconds());
    };

    tick();
    const id = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [startedAt, isRunning]);

  if (!startedAt) return null;
  if (elapsedSeconds === null) return null;
  return formatElapsed(elapsedSeconds);
}

function sanitizeAssistantOutput(raw?: string, isError = false): string | null {
  if (!raw) return null;
  if (!isError) return raw;

  const looksLikeRawApiEnvelope =
    raw.includes('API Error: 400') &&
    (raw.includes('"_requests"') ||
      raw.includes('"session_id"') ||
      raw.includes('"parent_tool_use_id"') ||
      raw.includes('\\u000'));

  if (!looksLikeRawApiEnvelope) {
    return raw;
  }

  return (
    'API Error: 400\n\n' +
    'Raw payload from CLI stream hidden because it contains encoded/binary-like content.\n\n' +
    'Open **CLI logs** below for readable diagnostics.'
  );
}

export const ProvisioningProgressBlock = ({
  title,
  message,
  tone = 'default',
  defaultLiveOutputOpen = true,
  currentStepIndex,
  loading = false,
  onCancel,
  startedAt,
  pid,
  cliLogsTail,
  assistantOutput,
  className,
}: ProvisioningProgressBlockProps): React.JSX.Element => {
  const elapsed = useElapsedTimer(startedAt, loading);
  const [logsOpen, setLogsOpen] = useState(() => tone === 'error' && Boolean(cliLogsTail));
  const [liveOutputOpen, setLiveOutputOpen] = useState(defaultLiveOutputOpen);
  const outputScrollRef = useRef<HTMLDivElement>(null);
  const isError = tone === 'error';
  const displayAssistantOutput = sanitizeAssistantOutput(assistantOutput, isError);
  const spawningStepIndex = STEP_ORDER.indexOf('spawning');
  const isCliLaunchMessage =
    message?.toLowerCase().includes('starting claude cli process') ?? false;
  const isCliStarting =
    !isError &&
    Boolean(cliLogsTail) &&
    loading &&
    (currentStepIndex <= spawningStepIndex || isCliLaunchMessage);
  const wasCliStartingRef = useRef(false);
  const hadCliStartingPhaseRef = useRef(false);

  // Auto-scroll assistant output
  useEffect(() => {
    if (liveOutputOpen && outputScrollRef.current) {
      outputScrollRef.current.scrollTop = outputScrollRef.current.scrollHeight;
    }
  }, [assistantOutput, liveOutputOpen]);

  // If parent changes the default (e.g. transitioning to "ready"), respect it.
  useEffect(() => {
    setLiveOutputOpen(defaultLiveOutputOpen);
  }, [defaultLiveOutputOpen]);

  // On error with logs available, prioritize logs view over noisy live stream payload.
  useEffect(() => {
    if (isError && cliLogsTail) {
      setLogsOpen(true);
      setLiveOutputOpen(false);
    }
  }, [isError, cliLogsTail]);

  // Keep CLI logs visible while the launch command is still starting,
  // then collapse them once the spawned process is actually running.
  useEffect(() => {
    if (isError || !cliLogsTail) {
      wasCliStartingRef.current = false;
      hadCliStartingPhaseRef.current = false;
      return;
    }

    if (isCliStarting && !wasCliStartingRef.current) {
      setLogsOpen(true);
    }

    if (!isCliStarting && wasCliStartingRef.current && hadCliStartingPhaseRef.current) {
      setLogsOpen(false);
    }

    wasCliStartingRef.current = isCliStarting;
    if (isCliStarting) {
      hadCliStartingPhaseRef.current = true;
    }
  }, [cliLogsTail, isCliStarting, isError]);

  return (
    <div
      className={cn(
        'rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2',
        isError && 'border-red-500/40 bg-red-500/10',
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
      {message ? (
        <p
          className={cn(
            'mt-1.5 text-xs',
            isError ? 'text-[var(--step-error-text)]' : 'text-[var(--color-text-muted)]'
          )}
        >
          {message}
        </p>
      ) : null}
      <div className="mt-2 flex items-center justify-center gap-1 overflow-x-auto pb-0.5">
        {STEP_ORDER.filter((s): s is ProvisioningStep => s !== 'ready').map((step, index) => {
          const isDone = currentStepIndex >= 0 && index < currentStepIndex;
          const isCurrent = currentStepIndex >= 0 && index === currentStepIndex;
          return (
            <div key={step} className="flex items-center gap-1">
              <Badge
                variant="secondary"
                className={cn(
                  'whitespace-nowrap px-2 py-0.5 text-[11px] font-normal',
                  isDone &&
                    'border-[var(--step-done-border)] bg-[var(--step-done-bg)] text-[var(--step-done-text)]',
                  isCurrent &&
                    'border-[var(--step-current-border)] bg-[var(--step-current-bg)] text-[var(--step-current-text)]'
                )}
              >
                <span className="mr-1 inline-flex size-4 items-center justify-center rounded-full border border-current text-[10px]">
                  {index + 1}
                </span>
                {STEP_LABELS[step]}
              </Badge>
              {index < STEP_ORDER.filter((s) => s !== 'ready').length - 1 ? (
                <span className="text-[var(--color-text-muted)]">&rarr;</span>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="mt-2">
        <button
          type="button"
          className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
          onClick={() => setLiveOutputOpen((v) => !v)}
        >
          {liveOutputOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Live output
        </button>
        {liveOutputOpen ? (
          <div
            ref={outputScrollRef}
            className={cn(
              'mt-1 max-h-[400px] overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2',
              isError && 'border-red-500/40'
            )}
          >
            {displayAssistantOutput ? (
              <MarkdownViewer content={displayAssistantOutput} bare maxHeight="max-h-none" />
            ) : (
              <p
                className={cn(
                  'text-[11px]',
                  isError ? 'text-[var(--step-error-text-dim)]' : 'text-[var(--color-text-muted)]'
                )}
              >
                No output captured yet.
              </p>
            )}
          </div>
        ) : null}
      </div>
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
          {logsOpen ? (
            <CliLogsRichView cliLogsTail={cliLogsTail} order="newest-first" className="mt-1" />
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
