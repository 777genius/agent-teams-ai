import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useLazyFileContent } from '@renderer/hooks/useLazyFileContent';
import { useVisibleFileSection } from '@renderer/hooks/useVisibleFileSection';

import { acceptAllChunks, rejectAllChunks, replayHunkDecisions } from './CodeMirrorDiffUtils';
import { FileSectionDiff } from './FileSectionDiff';
import { FileSectionHeader } from './FileSectionHeader';
import { FileSectionPlaceholder } from './FileSectionPlaceholder';

import type { EditorView } from '@codemirror/view';
import type { FileChangeWithContent, HunkDecision } from '@shared/types';
import type { FileChangeSummary } from '@shared/types/review';

interface ContinuousScrollViewProps {
  files: FileChangeSummary[];
  fileContents: Record<string, FileChangeWithContent>;
  fileContentsLoading: Record<string, boolean>;
  viewedSet: Set<string>;
  editedContents: Record<string, string>;
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
  collapseUnchanged: boolean;
  applying: boolean;
  autoViewed: boolean;
  discardCounter: number;
  onHunkAccepted: (filePath: string, hunkIndex: number) => void;
  onHunkRejected: (filePath: string, hunkIndex: number) => void;
  onFullyViewed: (filePath: string) => void;
  onContentChanged: (filePath: string, content: string) => void;
  onDiscard: (filePath: string) => void;
  onSave: (filePath: string) => void;
  onVisibleFileChange: (filePath: string) => void;
  scrollContainerRef: React.RefObject<HTMLDivElement>;
  editorViewMapRef: React.MutableRefObject<Map<string, EditorView>>;
  isProgrammaticScroll: React.RefObject<boolean>;
  teamName: string;
  memberName: string | undefined;
  fetchFileContent: (
    teamName: string,
    memberName: string | undefined,
    filePath: string
  ) => Promise<void>;
}

export const ContinuousScrollView = ({
  files,
  fileContents,
  fileContentsLoading,
  viewedSet,
  editedContents,
  hunkDecisions,
  fileDecisions,
  collapseUnchanged,
  applying,
  autoViewed,
  discardCounter,
  onHunkAccepted,
  onHunkRejected,
  onFullyViewed,
  onContentChanged,
  onDiscard,
  onSave,
  onVisibleFileChange,
  scrollContainerRef,
  editorViewMapRef,
  isProgrammaticScroll,
  teamName,
  memberName,
  fetchFileContent,
}: ContinuousScrollViewProps): React.ReactElement => {
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());

  const handleToggleCollapse = useCallback((filePath: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  }, []);

  const filePaths = useMemo(() => files.map((f) => f.filePath), [files]);

  const { registerFileSectionRef } = useVisibleFileSection({
    onVisibleFileChange,
    scrollContainerRef,
    isProgrammaticScroll,
  });

  const { registerLazyRef } = useLazyFileContent({
    teamName,
    memberName,
    filePaths,
    scrollContainerRef,
    fileContents,
    fileContentsLoading,
    fetchFileContent,
    enabled: true,
  });

  // Combined ref callback: registers element in both scroll-spy and lazy-load observers
  const combinedRef = useCallback(
    (filePath: string) => {
      const sectionRef = registerFileSectionRef(filePath);
      const lazyRef = registerLazyRef(filePath);

      return (element: HTMLElement | null) => {
        sectionRef(element);
        lazyRef(element);
      };
    },
    [registerFileSectionRef, registerLazyRef]
  );

  // Refs to avoid stale closures — decisions change frequently
  const fileDecisionsRef = useRef(fileDecisions);
  const hunkDecisionsRef = useRef(hunkDecisions);
  useEffect(() => {
    fileDecisionsRef.current = fileDecisions;
    hunkDecisionsRef.current = hunkDecisions;
  });

  const handleEditorViewReady = useCallback(
    (filePath: string, view: EditorView | null) => {
      if (view) {
        editorViewMapRef.current.set(filePath, view);

        const fileDecision = fileDecisionsRef.current[filePath];
        if (fileDecision === 'accepted' || fileDecision === 'rejected') {
          // Sync file-level "Accept All" / "Reject All" decisions
          requestAnimationFrame(() => {
            if (fileDecision === 'accepted') {
              acceptAllChunks(view);
            } else {
              rejectAllChunks(view);
            }
          });
        } else {
          // Replay individual per-hunk decisions persisted from previous session
          requestAnimationFrame(() => {
            replayHunkDecisions(view, filePath, hunkDecisionsRef.current);
          });
        }
      } else {
        editorViewMapRef.current.delete(filePath);
      }
    },
    [editorViewMapRef]
  );

  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-muted">
        No file changes detected
      </div>
    );
  }

  return (
    <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
      {files.map((file) => {
        const filePath = file.filePath;
        const content = fileContents[filePath] ?? null;
        const hasContent = filePath in fileContents;
        const hasEdits = filePath in editedContents;
        const isViewed = viewedSet.has(filePath);
        const decision = fileDecisions[filePath];

        const isCollapsed = collapsedFiles.has(filePath);

        return (
          <div key={filePath} ref={combinedRef(filePath)} className="border-b border-border">
            <FileSectionHeader
              file={file}
              fileContent={content}
              fileDecision={decision}
              hasEdits={hasEdits}
              applying={applying}
              isCollapsed={isCollapsed}
              onToggleCollapse={handleToggleCollapse}
              onDiscard={onDiscard}
              onSave={onSave}
            />

            {!isCollapsed &&
              (hasContent ? (
                <FileSectionDiff
                  file={file}
                  fileContent={content}
                  isLoading={false}
                  collapseUnchanged={collapseUnchanged}
                  onHunkAccepted={onHunkAccepted}
                  onHunkRejected={onHunkRejected}
                  onFullyViewed={onFullyViewed}
                  onContentChanged={onContentChanged}
                  onEditorViewReady={handleEditorViewReady}
                  discardCounter={discardCounter}
                  autoViewed={autoViewed}
                  isViewed={isViewed}
                />
              ) : (
                <FileSectionPlaceholder fileName={file.relativePath} />
              ))}
          </div>
        );
      })}
    </div>
  );
};
