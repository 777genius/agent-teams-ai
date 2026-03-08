import React, { useCallback, useEffect, useRef, useState } from 'react';

import { getTeamColorSet, getThemedBadge } from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import { useStore } from '@renderer/store';
import { FileText, Search, Terminal } from 'lucide-react';

import type { ToolApprovalRequest } from '@shared/types';

import { ToolApprovalSettingsPanel } from './dialogs/ToolApprovalSettingsPanel';

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

function renderToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return typeof input.command === 'string' ? input.command : JSON.stringify(input, null, 2);
    case 'Edit':
    case 'Read':
    case 'Write':
    case 'NotebookEdit':
      return typeof input.file_path === 'string' ? input.file_path : JSON.stringify(input, null, 2);
    case 'Grep':
    case 'Glob':
      return typeof input.pattern === 'string' ? input.pattern : JSON.stringify(input, null, 2);
    default:
      return JSON.stringify(input, null, 2);
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

export const ToolApprovalSheet: React.FC = () => {
  const pendingApprovals = useStore((s) => s.pendingApprovals);
  const respondToToolApproval = useStore((s) => s.respondToToolApproval);
  const teams = useStore((s) => s.teams);
  const { isLight } = useTheme();

  const current: ToolApprovalRequest | undefined = pendingApprovals[0];
  const containerRef = useRef<HTMLDivElement>(null);
  const [disabled, setDisabled] = useState(false);

  const handleRespond = useCallback(
    (allow: boolean) => {
      if (!current || disabled) return;
      setDisabled(true);
      void respondToToolApproval(current.teamName, current.runId, current.requestId, allow).finally(
        () => {
          setTimeout(() => setDisabled(false), 200);
        }
      );
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

  const teamSummary = teams.find((t) => t.teamName === current.teamName);
  const teamColor = teamSummary?.color ? getTeamColorSet(teamSummary.color) : null;

  return (
    <div
      ref={containerRef}
      className="fixed bottom-4 left-1/2 z-[55] w-full max-w-[480px] -translate-x-1/2 rounded-lg border shadow-xl outline-none duration-200 animate-in fade-in slide-in-from-bottom-4"
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
            {current.toolName}
          </span>
        </div>
        <div className="flex items-center gap-2.5">
          {teamColor ? (
            <span
              className="rounded-full px-2 py-0.5 text-[10px] font-medium"
              style={{
                backgroundColor: getThemedBadge(teamColor, isLight),
                color: teamColor.text,
                border: `1px solid ${teamColor.border}`,
              }}
            >
              {teamSummary?.displayName ?? current.teamName}
            </span>
          ) : (
            <span className="text-[10px] text-[var(--color-text-muted)]">{current.teamName}</span>
          )}
          <ElapsedDisplay receivedAt={current.receivedAt} />
        </div>
      </div>

      {/* Tool input preview */}
      <div className="px-4 py-2.5">
        <pre
          className="custom-scrollbar max-h-[120px] overflow-auto whitespace-pre-wrap break-all rounded-md border p-2 font-mono text-xs"
          style={{
            backgroundColor: 'var(--color-surface)',
            borderColor: 'var(--color-border)',
            color: 'var(--color-text-secondary)',
          }}
        >
          {renderToolInput(current.toolName, current.toolInput)}
        </pre>
      </div>

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
        Auto-{settings.timeoutAction} in {remaining}s
      </span>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Elapsed display sub-component (uses hook)
// ---------------------------------------------------------------------------

const ElapsedDisplay = ({ receivedAt }: { receivedAt: string }): React.JSX.Element => {
  const elapsed = useElapsed(receivedAt);
  return (
    <span className="text-[11px] tabular-nums text-[var(--color-text-muted)]">{elapsed}s</span>
  );
};
