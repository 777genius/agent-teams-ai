import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useContinuousScrollNav } from '@renderer/hooks/useContinuousScrollNav';
import { useViewedFiles } from '@renderer/hooks/useViewedFiles';
import { buildSelectionInfo, SELECTION_DEBOUNCE_MS } from '@renderer/utils/codemirrorSelectionInfo';

import {
  buildGlobalDiffLoadingState,
  buildReviewFileLabels,
  buildWatchedReviewFilePathsKey,
  findActiveReviewFile,
  resolveReviewFileLabel,
  sortChangeReviewFiles,
} from '../view-models/changeReviewPresentation';

import type { ChangeReviewCollapsedFilesStoragePort } from '../ports/changeReviewDialogInteractionPorts';
import type {
  ChangeReviewChangeSet,
  GlobalDiffLoadingState,
} from '../view-models/changeReviewPresentation';
import type { EditorView } from '@codemirror/view';
import type { FileChangeSummary, FileChangeWithContent, ReviewUndoAction } from '@shared/types';
import type { EditorSelectionInfo } from '@shared/types/editor';
import type { Dispatch, RefObject, SetStateAction } from 'react';

type ContinuousScrollNavigation = ReturnType<typeof useContinuousScrollNav>;
type ViewedFiles = ReturnType<typeof useViewedFiles>;

export interface ChangeReviewDialogViewStatePolicy {
  buildInitialScrollKey: (
    changeSet: ChangeReviewChangeSet | null,
    initialFilePath: string | undefined
  ) => string | null;
  getHistoryActionFilePath: (action: ReviewUndoAction) => string | null;
  resolveFilePath: (
    files: readonly Pick<FileChangeSummary, 'filePath'>[],
    requestedPath: string | undefined
  ) => string | null;
}

interface UseChangeReviewDialogViewStateInput {
  open: boolean;
  hasData: boolean;
  teamName: string;
  scopeKey: string;
  collapseStorageKey: string;
  initialFilePath: string | undefined;
  activeChangeSet: ChangeReviewChangeSet | null;
  fileContents: Record<string, FileChangeWithContent>;
  fileContentsLoading: Record<string, boolean>;
  storage: ChangeReviewCollapsedFilesStoragePort;
  policy: ChangeReviewDialogViewStatePolicy;
  reportError: (message: string) => void;
}

export interface ChangeReviewDialogViewState {
  activeFile: FileChangeSummary | null;
  activeFilePath: string | null;
  activeFilePathRef: RefObject<string | null>;
  activeEditorViewRef: RefObject<EditorView | null>;
  autoViewed: boolean;
  clearSelection: () => void;
  collapsedFiles: Set<string>;
  containerRect: DOMRect;
  diffContentRef: RefObject<HTMLDivElement | null>;
  editorViewMapRef: RefObject<Map<string, EditorView>>;
  getEditorFilePathForTarget: (target: Element | null) => string | null;
  globalDiffLoadingState: GlobalDiffLoadingState | null;
  handleFullyViewed: (filePath: string) => void;
  handleHistoryActionNavigation: (action: ReviewUndoAction) => void;
  handleSelectionChange: (info: EditorSelectionInfo | null) => void;
  handleTreeFileClick: (filePath: string) => void;
  handleVisibleFileChange: (filePath: string) => void;
  isProgrammaticScroll: ContinuousScrollNavigation['isProgrammaticScroll'];
  markViewed: ViewedFiles['markViewed'];
  resolveReviewFileLabel: (filePath: string) => string;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  scrollToFile: ContinuousScrollNavigation['scrollToFile'];
  selectionInfo: EditorSelectionInfo | null;
  setAutoViewed: Dispatch<SetStateAction<boolean>>;
  setTimelineOpen: Dispatch<SetStateAction<boolean>>;
  sortedFiles: FileChangeSummary[];
  timelineOpen: boolean;
  toggleCollapsedFile: (filePath: string) => void;
  unmarkViewed: ViewedFiles['unmarkViewed'];
  viewedCount: number;
  viewedProgress: number;
  viewedSet: Set<string>;
  viewedTotalCount: number;
  watchedReviewFilePathsKey: string;
}

export function useChangeReviewDialogViewState({
  open,
  hasData,
  teamName,
  scopeKey,
  collapseStorageKey,
  initialFilePath,
  activeChangeSet,
  fileContents,
  fileContentsLoading,
  storage,
  policy,
  reportError,
}: UseChangeReviewDialogViewStateInput): ChangeReviewDialogViewState {
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [autoViewed, setAutoViewed] = useState(true);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(() =>
    storage.read(collapseStorageKey)
  );
  const [selectionInfo, setSelectionInfo] = useState<EditorSelectionInfo | null>(null);
  const [containerRect, setContainerRect] = useState<DOMRect>(new DOMRect());

  const diffContentRef = useRef<HTMLDivElement>(null);
  const selectionTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const activeSelectionFileRef = useRef<string | null>(null);
  const editorViewMapRef = useRef(new Map<string, EditorView>());
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const activeEditorViewRef = useRef<EditorView | null>(null);
  const activeFilePathRef = useRef<string | null>(null);
  const initialScrollDoneKeyRef = useRef<string | null>(null);

  const { scrollToFile, isProgrammaticScroll } = useContinuousScrollNav({
    scrollContainerRef,
  });
  const sortedFiles = useMemo(
    () => sortChangeReviewFiles(activeChangeSet?.files ?? []),
    [activeChangeSet]
  );
  const reviewFileLabels = useMemo(() => buildReviewFileLabels(sortedFiles), [sortedFiles]);
  const resolveFileLabel = useCallback(
    (filePath: string): string => resolveReviewFileLabel(reviewFileLabels, filePath),
    [reviewFileLabels]
  );
  const watchedFilePathsKey = useMemo(
    () => buildWatchedReviewFilePathsKey(sortedFiles),
    [sortedFiles]
  );
  const globalDiffLoadingState = useMemo(
    () =>
      buildGlobalDiffLoadingState({
        files: sortedFiles,
        activeFilePath,
        fileContentsLoading,
        fileContents,
      }),
    [activeFilePath, fileContents, fileContentsLoading, sortedFiles]
  );
  const allFilePaths = useMemo(() => sortedFiles.map((file) => file.filePath), [sortedFiles]);
  const viewed = useViewedFiles(teamName, scopeKey, allFilePaths);
  const activeFile = useMemo(
    () => findActiveReviewFile(activeChangeSet, activeFilePath),
    [activeChangeSet, activeFilePath]
  );

  useEffect(() => {
    activeFilePathRef.current = activeFilePath;
    activeEditorViewRef.current = activeFilePath
      ? (editorViewMapRef.current.get(activeFilePath) ?? null)
      : null;
  }, [activeFilePath]);

  const getEditorFilePathForTarget = useCallback((target: Element | null): string | null => {
    if (!target) return null;
    for (const [filePath, view] of editorViewMapRef.current.entries()) {
      if (view.dom.contains(target)) return filePath;
    }
    return null;
  }, []);

  const handleVisibleFileChange = useCallback((filePath: string): void => {
    setActiveFilePath(filePath);
  }, []);

  const handleTreeFileClick = useCallback(
    (filePath: string): void => {
      scrollToFile(filePath);
      setActiveFilePath(filePath);
    },
    [scrollToFile]
  );

  const handleHistoryActionNavigation = useCallback(
    (action: ReviewUndoAction): void => {
      const actionFilePath = policy.getHistoryActionFilePath(action);
      if (!actionFilePath) return;
      const resolvedPath = policy.resolveFilePath(sortedFiles, actionFilePath);
      if (!resolvedPath) {
        reportError('The file from this review action is no longer in the current change set.');
        return;
      }
      handleTreeFileClick(resolvedPath);
    },
    [handleTreeFileClick, policy, reportError, sortedFiles]
  );

  const handleFullyViewed = useCallback(
    (filePath: string): void => {
      if (autoViewed && !viewed.isViewed(filePath)) viewed.markViewed(filePath);
    },
    [autoViewed, viewed]
  );

  const handleSelectionChange = useCallback((info: EditorSelectionInfo | null): void => {
    if (!info) {
      if (selectionTimerRef.current) clearTimeout(selectionTimerRef.current);
      setSelectionInfo(null);
      return;
    }
    activeSelectionFileRef.current = info.filePath;
    if (selectionTimerRef.current) clearTimeout(selectionTimerRef.current);
    selectionTimerRef.current = setTimeout(() => {
      setSelectionInfo(info);
    }, SELECTION_DEBOUNCE_MS);
  }, []);

  const clearSelection = useCallback((): void => {
    setSelectionInfo(null);
  }, []);

  useEffect(() => {
    if (!hasData) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    let animationFrameId = 0;
    const onScroll = (): void => {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = requestAnimationFrame(() => {
        const filePath = activeSelectionFileRef.current;
        if (!filePath) return;
        const view = editorViewMapRef.current.get(filePath);
        if (!view) return;
        const selection = view.state.selection.main;
        if (selection.empty) {
          setSelectionInfo(null);
          return;
        }
        const info = buildSelectionInfo(view, selection);
        setSelectionInfo(info ? { ...info, filePath } : null);
      });
    };

    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(animationFrameId);
      container.removeEventListener('scroll', onScroll);
    };
  }, [hasData]);

  useEffect(() => {
    const element = diffContentRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setContainerRect(element.getBoundingClientRect());
    });
    observer.observe(element);
    setContainerRect(element.getBoundingClientRect());
    return () => observer.disconnect();
  }, [hasData]);

  const toggleCollapsedFile = useCallback((filePath: string): void => {
    setCollapsedFiles((previous) => {
      const next = new Set(previous);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const timeoutId = setTimeout(() => {
      storage.write(collapseStorageKey, collapsedFiles);
    }, 200);
    return () => clearTimeout(timeoutId);
  }, [collapseStorageKey, collapsedFiles, open, storage]);

  useEffect(() => {
    if (!activeChangeSet) return;
    const allowed = new Set(activeChangeSet.files.map((file) => file.filePath));
    setCollapsedFiles((previous) => {
      const next = new Set<string>();
      for (const filePath of previous) {
        if (allowed.has(filePath)) next.add(filePath);
      }
      return next.size === previous.size ? previous : next;
    });
  }, [activeChangeSet]);

  useEffect(() => {
    const scrollKey = policy.buildInitialScrollKey(activeChangeSet, initialFilePath);
    if (!activeChangeSet || !initialFilePath || !scrollKey) return;
    if (initialScrollDoneKeyRef.current === scrollKey) return;
    const targetFilePath = policy.resolveFilePath(activeChangeSet.files, initialFilePath);
    if (!targetFilePath) return;
    initialScrollDoneKeyRef.current = scrollKey;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => scrollToFile(targetFilePath));
    });
  }, [activeChangeSet, initialFilePath, policy, scrollToFile]);

  useEffect(() => {
    if (!open) {
      setSelectionInfo(null);
      activeSelectionFileRef.current = null;
      if (selectionTimerRef.current) clearTimeout(selectionTimerRef.current);
    }
  }, [open]);

  return {
    activeFile,
    activeFilePath,
    activeFilePathRef,
    activeEditorViewRef,
    autoViewed,
    clearSelection,
    collapsedFiles,
    containerRect,
    diffContentRef,
    editorViewMapRef,
    globalDiffLoadingState,
    handleFullyViewed,
    handleHistoryActionNavigation,
    handleSelectionChange,
    handleTreeFileClick,
    handleVisibleFileChange,
    isProgrammaticScroll,
    resolveReviewFileLabel: resolveFileLabel,
    scrollContainerRef,
    scrollToFile,
    setAutoViewed,
    setTimelineOpen,
    sortedFiles,
    timelineOpen,
    toggleCollapsedFile,
    viewedCount: viewed.viewedCount,
    viewedProgress: viewed.progress,
    viewedSet: viewed.viewedSet,
    viewedTotalCount: viewed.totalCount,
    markViewed: viewed.markViewed,
    unmarkViewed: viewed.unmarkViewed,
    watchedReviewFilePathsKey: watchedFilePathsKey,
    getEditorFilePathForTarget,
    selectionInfo,
  };
}
