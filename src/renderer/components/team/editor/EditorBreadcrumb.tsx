/**
 * Breadcrumb navigation for the active file in the editor.
 *
 * Each segment is clickable — expands and scrolls the folder in the file tree.
 */

import { useCallback, useMemo } from 'react';

import { useStore } from '@renderer/store';
import { isWindowsishPath, joinPath, splitPath } from '@shared/utils/platformPath';
import { ChevronRight } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { FileIcon } from './FileIcon';

// =============================================================================
// Component
// =============================================================================

export const EditorBreadcrumb = (): React.ReactElement | null => {
  const { activeTabId, projectPath } = useStore(
    useShallow((s) => ({
      activeTabId: s.editorActiveTabId,
      projectPath: s.editorProjectPath,
    }))
  );
  const expandDirectory = useStore((s) => s.expandDirectory);

  const segments = useMemo(() => {
    if (!activeTabId) return [];
    if (!projectPath) return splitPath(activeTabId);

    const fullParts = splitPath(activeTabId);
    const rootParts = splitPath(projectPath);
    if (rootParts.length === 0) return fullParts;

    const win = isWindowsishPath(projectPath);
    const eq = (a: string, b: string) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);
    const hasPrefix =
      fullParts.length >= rootParts.length && rootParts.every((seg, i) => eq(seg, fullParts[i]));

    return hasPrefix ? fullParts.slice(rootParts.length) : fullParts;
  }, [activeTabId, projectPath]);

  const handleSegmentClick = useCallback(
    (segmentIndex: number): void => {
      if (!projectPath) return;
      const dirSegments = segments.slice(0, segmentIndex + 1);
      const dirPath = joinPath(projectPath, ...dirSegments);
      void expandDirectory(dirPath);
    },
    [segments, projectPath, expandDirectory]
  );

  if (segments.length === 0) return null;

  const fileName = segments[segments.length - 1];

  return (
    <div className="flex items-center gap-0.5 overflow-x-auto px-3 py-1 text-xs text-text-muted">
      {segments.map((segment, idx) => {
        const isLast = idx === segments.length - 1;
        return (
          <span key={idx} className="flex shrink-0 items-center gap-0.5">
            {idx > 0 && <ChevronRight className="text-text-muted/50 size-3" />}
            {isLast ? (
              <span className="flex items-center gap-1 text-text-secondary">
                <FileIcon fileName={fileName} className="size-3" />
                {segment}
              </span>
            ) : (
              <button
                onClick={() => handleSegmentClick(idx)}
                className="rounded px-0.5 transition-colors hover:bg-surface-raised hover:text-text-secondary"
              >
                {segment}
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
};
