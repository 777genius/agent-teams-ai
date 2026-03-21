import React, { useMemo, useState } from 'react';

import { computeDiffLineStats, DiffViewer } from '@renderer/components/chat/viewers/DiffViewer';
import { useToolApprovalDiff } from '@renderer/hooks/useToolApprovalDiff';
import { AlertTriangle, ChevronDown, ChevronRight, FileDiff, Loader2 } from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

interface ToolApprovalDiffPreviewProps {
  toolName: string;
  toolInput: Record<string, unknown>;
  requestId: string;
  onExpandedChange?: (expanded: boolean) => void;
}

const DIFF_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
const STORAGE_KEY = 'tool-approval:preview-expanded';

function loadExpandedPref(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveExpandedPref(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // quota or disabled — ignore
  }
}

// =============================================================================
// Quick stats from toolInput (before IPC, for Write tool)
// =============================================================================

function computeQuickStats(
  toolName: string,
  toolInput: Record<string, unknown>
): { added: number; removed: number } | null {
  if (toolName === 'Write' && typeof toolInput.content === 'string') {
    const lines = toolInput.content.split(/\r?\n/).length;
    return { added: lines, removed: 0 };
  }
  return null;
}

// =============================================================================
// Component
// =============================================================================

export const ToolApprovalDiffPreview: React.FC<ToolApprovalDiffPreviewProps> = ({
  toolName,
  toolInput,
  requestId,
  onExpandedChange,
}) => {
  const [expanded, setExpanded] = useState(loadExpandedPref);
  const diff = useToolApprovalDiff(toolName, toolInput, requestId, expanded);

  // Stats from actual diff data (after IPC), using the same algorithm as DiffViewer
  const diffStats = useMemo(() => {
    if (!diff.hasDiff || diff.loading || diff.isBinary || diff.error) return null;
    if (!diff.oldString && !diff.newString) return null;
    return computeDiffLineStats(diff.oldString, diff.newString);
  }, [diff.hasDiff, diff.loading, diff.isBinary, diff.error, diff.oldString, diff.newString]);

  // Quick stats from toolInput (available immediately, before diff loads)
  const quickStats = useMemo(
    () => computeQuickStats(toolName, toolInput),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toolInput identity tied to requestId
    [toolName, requestId]
  );

  // Prefer accurate diffStats when available, fall back to quickStats
  const stats = diffStats ?? quickStats;

  if (!DIFF_TOOLS.has(toolName)) return null;

  const toggleExpanded = (): void => {
    const next = !expanded;
    setExpanded(next);
    saveExpandedPref(next);
    onExpandedChange?.(next);
  };

  return (
    <div className="border-t px-4 py-2" style={{ borderColor: 'var(--color-border)' }}>
      {/* Toggle button */}
      <button
        type="button"
        onClick={toggleExpanded}
        className="flex items-center gap-1.5 rounded px-2 py-1 text-[11px] transition-colors"
        style={{ color: 'var(--color-text-muted)' }}
        onMouseEnter={(e) => {
          Object.assign(e.currentTarget.style, {
            backgroundColor: 'var(--color-surface-raised)',
          });
        }}
        onMouseLeave={(e) => {
          Object.assign(e.currentTarget.style, { backgroundColor: 'transparent' });
        }}
      >
        <FileDiff className="size-3" />
        <span>Preview changes</span>
        {stats && (
          <>
            {stats.added > 0 && <span style={{ color: 'rgb(46, 160, 67)' }}>+{stats.added}</span>}
            {stats.removed > 0 && (
              <span style={{ color: 'rgb(248, 81, 73)' }}>-{stats.removed}</span>
            )}
          </>
        )}
        {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
      </button>

      {/* Collapsible content */}
      {expanded && (
        <div className="mt-2">
          {diff.loading && (
            <div
              className="flex items-center gap-2 rounded-md border px-3 py-3 text-xs"
              style={{
                backgroundColor: 'var(--color-surface)',
                borderColor: 'var(--color-border)',
                color: 'var(--color-text-muted)',
              }}
            >
              <Loader2 className="size-3.5 animate-spin" />
              <span>Reading file...</span>
            </div>
          )}

          {diff.isBinary && (
            <div
              className="flex items-center gap-2 rounded-md border px-3 py-2.5 text-xs"
              style={{
                backgroundColor: 'rgba(234, 179, 8, 0.08)',
                borderColor: 'rgba(234, 179, 8, 0.25)',
                color: 'rgb(234, 179, 8)',
              }}
            >
              <AlertTriangle className="size-3.5 shrink-0" />
              <span>Binary file — cannot preview</span>
            </div>
          )}

          {diff.error && !diff.loading && (
            <div
              className="flex items-start gap-2 rounded-md border px-3 py-2.5 text-xs"
              style={{
                backgroundColor: 'rgba(234, 179, 8, 0.08)',
                borderColor: 'rgba(234, 179, 8, 0.25)',
                color: 'rgb(234, 179, 8)',
              }}
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span className="break-words">{diff.error}</span>
            </div>
          )}

          {diff.truncated && !diff.loading && (
            <div
              className="mb-2 flex items-center gap-2 rounded-md border px-3 py-1.5 text-[10px]"
              style={{
                backgroundColor: 'rgba(234, 179, 8, 0.06)',
                borderColor: 'rgba(234, 179, 8, 0.2)',
                color: 'rgb(234, 179, 8)',
              }}
            >
              <AlertTriangle className="size-3 shrink-0" />
              <span>File truncated at 2MB — diff may be incomplete</span>
            </div>
          )}

          {!diff.loading && !diff.isBinary && !diff.error && (diff.oldString || diff.newString) && (
            <div>
              {diff.isNewFile && (
                <span
                  className="mb-1.5 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium"
                  style={{
                    backgroundColor: 'rgba(46, 160, 67, 0.15)',
                    color: 'rgb(46, 160, 67)',
                  }}
                >
                  New file
                </span>
              )}
              <DiffViewer
                fileName={diff.fileName}
                oldString={diff.oldString}
                newString={diff.newString}
                maxHeight="max-h-[300px]"
                syntaxHighlight
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
};
