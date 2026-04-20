import { useEffect, useRef, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { cn } from '@renderer/lib/utils';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Info,
  Loader2,
  X,
} from 'lucide-react';

import { MarkdownViewer } from '../chat/viewers/MarkdownViewer';

import { CliLogsRichView } from './CliLogsRichView';
import { DISPLAY_STEPS } from './provisioningSteps';
import { StepProgressBar } from './StepProgressBar';

import type { StepProgressBarStep } from './StepProgressBar';

/** Pre-built step definitions for the provisioning stepper. */
const PROVISIONING_STEPS: StepProgressBarStep[] = DISPLAY_STEPS.map((s) => ({
  key: s.key,
  label: s.label,
}));

export interface ProvisioningProgressBlockProps {
  /** Title above the steps, e.g. "Launching team" */
  title: string;
  /** Optional status message */
  message?: string | null;
  /** Visual severity for the message subtitle */
  messageSeverity?: 'error' | 'warning' | 'info';
  /** Visual tone (e.g. highlight errors) */
  tone?: 'default' | 'error';
  /** Whether Live output is expanded by default */
  defaultLiveOutputOpen?: boolean;
  /** Whether CLI logs are expanded by default */
  defaultLogsOpen?: boolean;
  /** Display step index (0-3 for active steps, 4 for ready/all done, -1 for terminal) */
  currentStepIndex: number;
  /** If set, this step index shows a red error indicator */
  errorStepIndex?: number;
  /** Show spinner next to title */
  loading?: boolean;
  /** Cancel button label and handler */
  onCancel?: (() => void) | null;
  /** Success message shown inside the block header (e.g. "Team launched — all N teammates online") */
  successMessage?: string | null;
  /** Visual tone for the status banner above the block. */
  successMessageSeverity?: 'success' | 'warning' | 'info';
  /** Dismiss handler — renders an X button in the block header top-right */
  onDismiss?: (() => void) | null;
  /** ISO timestamp when provisioning started */
  startedAt?: string;
  /** PID of the CLI process */
  pid?: number;
  /** CLI logs captured during launch */
  cliLogsTail?: string;
  /** Accumulated assistant text output for live preview */
  assistantOutput?: string;
  /** Visual surface chrome for the outer block */
  surface?: 'raised' | 'flat';
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
  messageSeverity,
  tone = 'default',
  defaultLiveOutputOpen = true,
  defaultLogsOpen,
  currentStepIndex,
  errorStepIndex,
  loading = false,
  onCancel,
  successMessage,
  successMessageSeverity = 'success',
  onDismiss,
  startedAt,
  pid,
  cliLogsTail,
  assistantOutput,
  surface = 'raised',
  className,
}: ProvisioningProgressBlockProps): React.JSX.Element => {
  const elapsed = useElapsedTimer(startedAt, loading);
  const [logsOpen, setLogsOpen] = useState(() => defaultLogsOpen ?? false);
  const [liveOutputOpen, setLiveOutputOpen] = useState(defaultLiveOutputOpen);
  const outputScrollRef = useRef<HTMLDivElement>(null);
  const isError = tone === 'error';
  const displayAssistantOutput = sanitizeAssistantOutput(assistantOutput, isError);

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

  useEffect(() => {
    if (defaultLogsOpen === undefined) {
      return;
    }
    setLogsOpen(defaultLogsOpen);
  }, [defaultLogsOpen]);

  // On error with logs available, prioritize logs view over noisy live stream payload.
  useEffect(() => {
    if (isError && cliLogsTail) {
      setLogsOpen(true);
      setLiveOutputOpen(false);
    }
  }, [isError, cliLogsTail]);

  return (
    <div
      className={cn(
        surface === 'flat'
          ? 'rounded-none border-0 bg-transparent p-0'
          : 'rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2',
        isError && 'border-red-500/40 bg-red-500/10',
        className
      )}
    >
      {successMessage ? (
        <div className="mb-1.5 flex items-center gap-2">
          {successMessageSeverity === 'warning' ? (
            <AlertTriangle size={14} className="shrink-0 text-amber-400" />
          ) : successMessageSeverity === 'info' ? (
            <Info size={14} className="shrink-0 text-sky-400" />
          ) : (
            <CheckCircle2 size={14} className="shrink-0 text-[var(--step-done-text)]" />
          )}
          <p
            className={cn(
              'flex-1 text-xs',
              successMessageSeverity === 'warning'
                ? 'text-amber-400'
                : successMessageSeverity === 'info'
                  ? 'text-sky-400'
                  : 'text-[var(--step-success-text)]'
            )}
          >
            {successMessage}
          </p>
          {onDismiss ? (
            <Button
              variant="ghost"
              size="sm"
              className="size-6 shrink-0 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              onClick={onDismiss}
            >
              <X size={12} />
            </Button>
          ) : null}
        </div>
      ) : onDismiss ? (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="size-6 shrink-0 p-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            onClick={onDismiss}
          >
            <X size={12} />
          </Button>
        </div>
      ) : null}
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
            isError || messageSeverity === 'error'
              ? 'text-red-400'
              : messageSeverity === 'warning'
                ? 'text-amber-400'
                : messageSeverity === 'info'
                  ? 'text-sky-400'
                  : 'text-[var(--color-text-muted)]'
          )}
        >
          {message}
        </p>
      ) : null}
      <div className="mt-2 px-2">
        <StepProgressBar
          steps={PROVISIONING_STEPS}
          currentIndex={currentStepIndex}
          errorIndex={errorStepIndex}
        />
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
