import { useState } from 'react';
import ReactDOM from 'react-dom';

import { Terminal, X } from 'lucide-react';

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
  /** Called when the modal should close */
  onClose: () => void;
  /** Called when the PTY process exits */
  onExit?: (exitCode: number) => void;
}

export function TerminalModal({
  title = 'Terminal',
  command,
  args,
  cwd,
  onClose,
  onExit,
}: TerminalModalProps): React.JSX.Element {
  const [exited, setExited] = useState<number | null>(null);

  const handleExit = (exitCode: number): void => {
    setExited(exitCode);
    onExit?.(exitCode);
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  };

  return ReactDOM.createPortal(
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- modal backdrop
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onKeyDown={handleKeyDown}
    >
      <div className="flex h-[60vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border-emphasis bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-text">
            <Terminal size={16} className="text-text-secondary" />
            {title}
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-text-muted transition-colors hover:bg-surface-raised hover:text-text"
          >
            <X size={16} />
          </button>
        </div>

        {/* Terminal area */}
        <div className="relative flex min-h-0 flex-1 flex-col p-2">
          {exited === null ? (
            <EmbeddedTerminal command={command} args={args} cwd={cwd} onExit={handleExit} />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-text-secondary">
              <p className="text-sm">
                Process exited with code{' '}
                <span className="font-mono font-medium text-text">{exited}</span>
              </p>
              <button
                onClick={onClose}
                className="rounded-md bg-surface-raised px-4 py-1.5 text-sm text-text transition-colors hover:bg-border-emphasis"
              >
                Close
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
