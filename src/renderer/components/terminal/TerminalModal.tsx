import { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';

import { CheckCircle, Terminal, X, XCircle } from 'lucide-react';

import { EmbeddedTerminal } from './EmbeddedTerminal';

interface TerminalModalProps {
  /** Modal title */
  title?: string;
  /** Command to run */
  command?: string;
  /** Arguments for the command */
  args?: string[];
  /** Working directory */
  cwd?: string;
  /** Environment variables merged into the PTY process env */
  env?: Record<string, string>;
  /** Called when the modal should close */
  onClose: () => void;
  /** Called when the PTY process exits */
  onExit?: (exitCode: number) => void;
  /** Auto-close the modal after this many ms on success (exit code 0). 0 = disabled. */
  autoCloseOnSuccessMs?: number;
  /** Custom message shown on exit code 0. Default: "Completed successfully" */
  successMessage?: string;
  /** Custom message prefix for non-zero exit. Default: "Process failed" */
  failureMessage?: string;
}

export function TerminalModal({
  title = 'Terminal',
  command,
  args,
  cwd,
  env,
  onClose,
  onExit,
  autoCloseOnSuccessMs = 0,
  successMessage = 'Completed successfully',
  failureMessage = 'Process failed',
}: TerminalModalProps): React.JSX.Element {
  const [exited, setExited] = useState<number | null>(null);
  const [countdown, setCountdown] = useState<number>(0);
  const dialogRef = useRef<HTMLDivElement>(null);

  const handleExit = useCallback(
    (exitCode: number): void => {
      setExited(exitCode);
      onExit?.(exitCode);
      if (exitCode === 0 && autoCloseOnSuccessMs > 0) {
        setCountdown(Math.ceil(autoCloseOnSuccessMs / 1000));
      }
    },
    [onExit, autoCloseOnSuccessMs]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    },
    [onClose]
  );

  // Focus trap — focus dialog on mount
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  // Countdown timer for auto-close
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          onClose();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [countdown, onClose]);

  const totalSeconds = autoCloseOnSuccessMs > 0 ? Math.ceil(autoCloseOnSuccessMs / 1000) : 0;
  const progressPercent = totalSeconds > 0 ? (countdown / totalSeconds) * 100 : 0;

  return ReactDOM.createPortal(
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- modal backdrop handles Escape
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onKeyDown={handleKeyDown}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-label={title}
        aria-modal="true"
        tabIndex={-1}
        className="flex h-[60vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border-emphasis bg-surface shadow-2xl outline-none"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-text">
            <Terminal size={16} className="text-text-secondary" />
            {title}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-text-muted transition-colors hover:bg-surface-raised hover:text-text"
          >
            <X size={16} />
          </button>
        </div>

        {/* Terminal area — always visible, status bar overlaid at bottom */}
        <div className="relative flex min-h-0 flex-1 flex-col p-2">
          <EmbeddedTerminal command={command} args={args} cwd={cwd} env={env} onExit={handleExit} />

          {exited !== null && (
            <div
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="absolute inset-x-0 bottom-0 border-t px-4 py-3"
              style={{
                backgroundColor: 'rgba(20, 20, 22, 0.98)',
                borderColor:
                  exited === 0 ? 'rgba(74, 222, 128, 0.25)' : 'rgba(248, 113, 113, 0.25)',
                backdropFilter: 'blur(12px)',
              }}
            >
              <div className="flex items-center justify-between">
                {exited === 0 ? (
                  <div className="flex items-center gap-2.5">
                    <CheckCircle size={18} className="shrink-0 text-green-400" aria-hidden="true" />
                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-green-400">{successMessage}</span>
                      {countdown > 0 && (
                        <span className="text-xs text-text-muted">Closing in {countdown}s...</span>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2.5">
                    <XCircle size={18} className="shrink-0 text-red-400" aria-hidden="true" />
                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-red-400">
                        {failureMessage}{' '}
                        <span className="font-mono opacity-75">(exit code {exited})</span>
                      </span>
                      <span className="text-xs text-text-muted">
                        Check terminal output above for details
                      </span>
                    </div>
                  </div>
                )}
                <button
                  onClick={onClose}
                  className="shrink-0 rounded-md bg-surface-raised px-4 py-1.5 text-sm text-text transition-colors hover:bg-border-emphasis"
                >
                  Close
                </button>
              </div>

              {/* Progress bar for auto-close countdown */}
              {countdown > 0 && (
                <div
                  className="mt-2.5 h-0.5 w-full overflow-hidden rounded-full"
                  style={{ backgroundColor: 'rgba(255, 255, 255, 0.06)' }}
                >
                  <div
                    className="h-full rounded-full bg-green-400/50 transition-all duration-1000 ease-linear"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
