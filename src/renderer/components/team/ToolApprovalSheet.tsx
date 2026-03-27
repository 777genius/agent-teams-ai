import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getTeamColorSet, getThemedBadge } from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { useStore } from '@renderer/store';
import { shortenDisplayPath } from '@renderer/utils/pathDisplay';
import { highlightLines } from '@renderer/utils/syntaxHighlighter';
import { AlertTriangle, FileText, Search, Terminal } from 'lucide-react';

import { ToolApprovalSettingsPanel } from './dialogs/ToolApprovalSettingsPanel';
import { FileIcon } from './editor/FileIcon';
import { ToolApprovalDiffPreview } from './ToolApprovalDiffPreview';

import type { ToolApprovalRequest } from '@shared/types';

// ---------------------------------------------------------------------------
// Tool icon mapping
// ---------------------------------------------------------------------------

function getToolIcon(toolName: string): React.JSX.Element {
  const cls = 'size-4 shrink-0';
  switch (toolName) {
    case 'Bash':
      return <Terminal className={cls} />;
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return <FileText className={cls} />;
    case 'Grep':
    case 'Glob':
      return <Search className={cls} />;
    default:
      return <Terminal className={cls} />;
  }
}

// ---------------------------------------------------------------------------
// Smart input preview
// ---------------------------------------------------------------------------

function renderToolInput(
  toolName: string,
  input: Record<string, unknown>,
  projectPath?: string
): string {
  switch (toolName) {
    case 'Bash':
      return typeof input.command === 'string' ? input.command : JSON.stringify(input, null, 2);
    case 'Edit':
    case 'Read':
    case 'Write':
    case 'NotebookEdit': {
      const fp = typeof input.file_path === 'string' ? input.file_path : null;
      if (!fp) return JSON.stringify(input, null, 2);
      return projectPath ? shortenDisplayPath(fp, projectPath, 200) : fp;
    }
    case 'Grep':
    case 'Glob':
      return typeof input.pattern === 'string' ? input.pattern : JSON.stringify(input, null, 2);
    default:
      return JSON.stringify(input, null, 2);
  }
}

/** Map tool name to a virtual filename for syntax highlighting. */
function getToolInputFileName(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return 'command.sh';
    case 'Edit':
    case 'Read':
    case 'Write':
    case 'NotebookEdit':
      return typeof input.file_path === 'string' ? input.file_path : 'input.json';
    case 'Grep':
    case 'Glob':
      return 'pattern.txt';
    default:
      return 'input.json';
  }
}

// ---------------------------------------------------------------------------
// Elapsed timer hook
// ---------------------------------------------------------------------------

function useElapsed(receivedAt: string): number {
  const [elapsed, setElapsed] = useState(() =>
    Math.max(0, Math.floor((Date.now() - new Date(receivedAt).getTime()) / 1000))
  );

  useEffect(() => {
    const computeElapsed = (): number =>
      Math.max(0, Math.floor((Date.now() - new Date(receivedAt).getTime()) / 1000));
    queueMicrotask(() => setElapsed(computeElapsed()));
    const id = setInterval(() => {
      setElapsed(computeElapsed());
    }, 1000);
    return () => clearInterval(id);
  }, [receivedAt]);

  return elapsed;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/** Max time (ms) to wait for the IPC before considering it stuck */
const RESPOND_TIMEOUT_MS = 10_000;

export const ToolApprovalSheet: React.FC = () => {
  const pendingApprovals = useStore((s) => s.pendingApprovals);
  const respondToToolApproval = useStore((s) => s.respondToToolApproval);
  const updateToolApprovalSettings = useStore((s) => s.updateToolApprovalSettings);
  const teams = useStore((s) => s.teams);
  const selectedTeamName = useStore((s) => s.selectedTeamName);
  const selectedTeamData = useStore((s) => s.selectedTeamData);
  const { isLight } = useTheme();

  const current: ToolApprovalRequest | undefined = pendingApprovals[0];
  const containerRef = useRef<HTMLDivElement>(null);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diffExpanded, setDiffExpanded] = useState(false);

  // Clear error when current approval changes
  useEffect(() => {
    setError(null);
  }, [current?.requestId]);

  const handleRespond = useCallback(
    (allow: boolean) => {
      if (!current || disabled) return;
      setDisabled(true);
      setError(null);

      // Safety timeout — if IPC hangs (e.g. stdin.write callback never fires),
      // re-enable the button so the user isn't stuck forever.
      const safetyTimer = setTimeout(() => {
        setDisabled(false);
        setError('Response timed out — process may be unresponsive. Try again or stop the team.');
      }, RESPOND_TIMEOUT_MS);

      respondToToolApproval(current.teamName, current.runId, current.requestId, allow)
        .then(() => {
          clearTimeout(safetyTimer);
          // Small delay before re-enabling to prevent accidental double-clicks
          setTimeout(() => setDisabled(false), 200);
        })
        .catch((err: unknown) => {
          clearTimeout(safetyTimer);
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg);
          setDisabled(false);
        });
    },
    [current, disabled, respondToToolApproval]
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Enter') {
        e.preventDefault();
        handleRespond(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleRespond(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleRespond]);

  if (!current) return null;

  // Prefer color from the approval itself (always available, even during provisioning),
  // fall back to teams list, then getTeamColorSet hashes unknown names into TEAMMATE_COLORS.
  const teamSummary = teams.find((t) => t.teamName === current.teamName);
  const colorName = current.teamColor ?? teamSummary?.color ?? current.teamName;
  const teamColor = getTeamColorSet(colorName);
  const displayName = current.teamDisplayName ?? teamSummary?.displayName ?? current.teamName;

  return (
    <div
      ref={containerRef}
      className={`fixed bottom-4 left-1/2 z-[55] w-full -translate-x-1/2 rounded-lg border shadow-xl outline-none transition-all duration-200 animate-in fade-in slide-in-from-bottom-4 ${diffExpanded ? 'max-w-screen-sm' : 'max-w-[480px]'}`}
      style={{
        backgroundColor: 'var(--color-surface-overlay)',
        borderColor: 'var(--color-border-emphasis)',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between border-b px-4 py-2.5"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="flex items-center gap-2">
          {getToolIcon(current.toolName)}
          <span className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
            {current.source !== 'lead' ? `${current.source} — ` : ''}
            {current.toolName}
          </span>
        </div>
        <div className="flex items-center gap-2.5">
          {selectedTeamName !== current.teamName && (
            <span
              className="rounded-full px-2 py-0.5 text-[10px] font-medium"
              style={{
                backgroundColor: getThemedBadge(teamColor, isLight),
                color: teamColor.text,
                border: `1px solid ${teamColor.border}`,
              }}
            >
              {displayName}
            </span>
          )}
          <ElapsedDisplay receivedAt={current.receivedAt} />
        </div>
      </div>

      {/* Tool input preview (syntax-highlighted) */}
      <ToolInputPreview
        toolName={current.toolName}
        toolInput={current.toolInput}
        projectPath={selectedTeamData?.config?.projectPath}
      />

      {/* Diff preview (Write/Edit/NotebookEdit only) */}
      <ToolApprovalDiffPreview
        toolName={current.toolName}
        toolInput={current.toolInput}
        requestId={current.requestId}
        onExpandedChange={setDiffExpanded}
      />

      {/* Error feedback */}
      {error && (
        <div
          className="mx-4 mb-1 flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
          style={{
            backgroundColor: 'rgba(239, 68, 68, 0.08)',
            borderColor: 'rgba(239, 68, 68, 0.25)',
            color: 'rgb(248, 113, 113)',
          }}
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      )}

      {/* Actions */}
      <div
        className="flex items-center justify-between border-t px-4 py-2.5"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => handleRespond(true)}
            className="rounded-md px-3.5 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-50"
            style={{ backgroundColor: 'rgb(5, 150, 105)' }}
            onMouseEnter={(e) => {
              if (!disabled)
                Object.assign(e.currentTarget.style, { backgroundColor: 'rgb(16, 185, 129)' });
            }}
            onMouseLeave={(e) => {
              Object.assign(e.currentTarget.style, { backgroundColor: 'rgb(5, 150, 105)' });
            }}
          >
            Allow
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => handleRespond(false)}
            className="rounded-md border px-3.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
            style={{
              borderColor: 'rgba(239, 68, 68, 0.5)',
              color: 'rgb(248, 113, 113)',
            }}
            onMouseEnter={(e) => {
              if (!disabled)
                Object.assign(e.currentTarget.style, {
                  backgroundColor: 'rgba(239, 68, 68, 0.1)',
                });
            }}
            onMouseLeave={(e) => {
              Object.assign(e.currentTarget.style, { backgroundColor: 'transparent' });
            }}
          >
            Deny
          </button>

          <div className="mx-1 h-4 w-px" style={{ backgroundColor: 'var(--color-border)' }} />

          <button
            type="button"
            onClick={() => void updateToolApprovalSettings({ autoAllowAll: true })}
            className="rounded-md border px-3.5 py-1.5 text-xs font-medium transition-colors"
            style={{
              color: 'var(--color-text-muted)',
              borderColor: 'var(--color-border-emphasis)',
            }}
            onMouseEnter={(e) => {
              Object.assign(e.currentTarget.style, {
                color: 'var(--color-text-secondary)',
                backgroundColor: 'var(--color-surface-raised)',
              });
            }}
            onMouseLeave={(e) => {
              Object.assign(e.currentTarget.style, {
                color: 'var(--color-text-muted)',
                backgroundColor: 'transparent',
              });
            }}
          >
            Allow all
          </button>
        </div>
        {pendingApprovals.length > 1 && (
          <span className="text-[11px] text-[var(--color-text-muted)]">
            {pendingApprovals.length - 1} pending
          </span>
        )}
      </div>

      {/* Settings panel (full-width, outside flex row) */}
      <ToolApprovalSettingsPanel />

      {/* Timeout progress bar */}
      <TimeoutProgress receivedAt={current.receivedAt} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Syntax-highlighted tool input preview
// ---------------------------------------------------------------------------

const FILE_TOOLS = new Set(['Edit', 'Read', 'Write', 'NotebookEdit']);

const ToolInputPreview = ({
  toolName,
  toolInput,
  projectPath,
}: {
  toolName: string;
  toolInput: Record<string, unknown>;
  projectPath?: string;
}): React.JSX.Element => {
  const text = renderToolInput(toolName, toolInput, projectPath);
  const fileName = getToolInputFileName(toolName, toolInput);
  const lines = useMemo(() => highlightLines(text, fileName), [text, fileName]);
  const rawFilePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : null;
  const isFileTool = FILE_TOOLS.has(toolName) && rawFilePath;

  return (
    <div className="px-4 py-2.5">
      <div
        className="custom-scrollbar max-h-[120px] overflow-auto rounded-md border p-2 font-mono text-xs"
        style={{
          backgroundColor: 'var(--color-surface)',
          borderColor: 'var(--color-border)',
          color: 'var(--color-text-secondary)',
        }}
      >
        {isFileTool ? (
          <div className="flex items-center gap-1.5">
            <FileIcon fileName={rawFilePath} className="size-3.5 shrink-0" />
            <span className="break-all">{text}</span>
          </div>
        ) : (
          /* highlightLines uses hljs which HTML-escapes all input text, producing only <span class="hljs-*"> tags.
             This is safe: the source is our own renderToolInput() output, not arbitrary user HTML.
             Same pattern used in ReviewDiffContent.tsx and DiffViewer for syntax highlighting. */
          lines.map((html, i) => (
            <div
              key={i}
              className="whitespace-pre-wrap break-all"
              dangerouslySetInnerHTML={{ __html: html || '&nbsp;' }}
            />
          ))
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Timeout progress bar sub-component
// ---------------------------------------------------------------------------

const TimeoutProgress = ({ receivedAt }: { receivedAt: string }): React.JSX.Element | null => {
  const settings = useStore((s) => s.toolApprovalSettings);
  const elapsed = useElapsed(receivedAt);

  if (settings.timeoutAction === 'wait') return null;

  const progress = Math.min(1, elapsed / settings.timeoutSeconds);
  const remaining = Math.max(0, settings.timeoutSeconds - elapsed);
  const color = settings.timeoutAction === 'allow' ? 'rgb(5, 150, 105)' : 'rgb(239, 68, 68)';

  return (
    <div
      className="flex items-center gap-2 border-t px-4 py-1.5"
      style={{ borderColor: 'var(--color-border)' }}
    >
      <div
        className="h-1 flex-1 overflow-hidden rounded-full"
        style={{ backgroundColor: 'var(--color-surface)' }}
      >
        <div
          className="h-full rounded-full transition-all duration-1000 ease-linear"
          style={{
            width: `${progress * 100}%`,
            backgroundColor: color,
          }}
        />
      </div>
      <span className="text-[10px] tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
        Auto-{settings.timeoutAction} in {formatElapsed(remaining)}
      </span>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Elapsed display sub-component (uses hook)
// ---------------------------------------------------------------------------

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

const ElapsedDisplay = ({ receivedAt }: { receivedAt: string }): React.JSX.Element => {
  const elapsed = useElapsed(receivedAt);
  return (
    <span className="text-[11px] tabular-nums text-[var(--color-text-muted)]">
      {formatElapsed(elapsed)}
    </span>
  );
};
