/**
 * Proportional scroll synchronization between CodeMirror and a preview pane.
 *
 * Uses the fraction-based approach: fraction = scrollTop / (scrollHeight - clientHeight).
 * Feedback loop prevention via ref-based ignore flags reset with requestAnimationFrame.
 *
 * The hook auto-attaches/detaches the CodeMirror scroll listener internally:
 * - Retry logic handles CodeMirror mount delay (up to 500ms)
 * - `viewKey` triggers re-attachment when the EditorView changes (e.g. file switch)
 * - Full cleanup on disable/unmount
 */

import { useCallback, useEffect, useRef } from 'react';

import { editorBridge } from '@renderer/utils/editorBridge';

// =============================================================================
// Constants
// =============================================================================

/** Max attempts to find CodeMirror scrollDOM before giving up */
const MAX_ATTACH_ATTEMPTS = 10;
/** Interval between retry attempts (ms) */
const ATTACH_RETRY_INTERVAL = 50;

// =============================================================================
// Types
// =============================================================================

export interface UseMarkdownScrollSyncResult {
  previewScrollRef: React.RefObject<HTMLDivElement | null>;
  /** Attach to editor scroll container when using a local CodeMirror instance */
  handleCodeScroll: () => void;
  /** Attach to preview div's onScroll */
  handlePreviewScroll: () => void;
}

interface UseMarkdownScrollSyncOptions {
  editorScrollRef?: React.RefObject<HTMLElement | null>;
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Bidirectional scroll sync between CodeMirror and a preview pane.
 *
 * @param enabled - Whether sync is active (typically `mode === 'split'`)
 * @param viewKey - Changes when the underlying EditorView changes (e.g. `activeTabId`).
 *                  Triggers re-attachment of the code scroll listener.
 */
export function useMarkdownScrollSync(
  enabled: boolean,
  viewKey?: string | null,
  options?: UseMarkdownScrollSyncOptions
): UseMarkdownScrollSyncResult {
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const ignoreCodeScroll = useRef(false);
  const ignorePreviewScroll = useRef(false);
  const codeRafRef = useRef(0);
  const previewRafRef = useRef(0);
  const getEditorScrollElement = useCallback(() => {
    return options?.editorScrollRef?.current ?? editorBridge.getView()?.scrollDOM ?? null;
  }, [options?.editorScrollRef]);

  // Code → Preview: proportional scroll
  const handleCodeScroll = useCallback(() => {
    if (!enabled) return;
    if (ignoreCodeScroll.current) {
      ignoreCodeScroll.current = false;
      return;
    }

    const scrollDOM = getEditorScrollElement();
    const preview = previewScrollRef.current;
    if (!scrollDOM || !preview) return;

    const maxCode = scrollDOM.scrollHeight - scrollDOM.clientHeight;
    if (maxCode <= 0) return;

    const fraction = scrollDOM.scrollTop / maxCode;
    const maxPreview = preview.scrollHeight - preview.clientHeight;
    if (maxPreview <= 0) return;

    cancelAnimationFrame(previewRafRef.current);
    previewRafRef.current = requestAnimationFrame(() => {
      ignorePreviewScroll.current = true;
      preview.scrollTop = fraction * maxPreview;
    });
  }, [enabled, getEditorScrollElement]);

  // Preview → Code: proportional scroll
  const handlePreviewScroll = useCallback(() => {
    if (!enabled) return;
    if (ignorePreviewScroll.current) {
      ignorePreviewScroll.current = false;
      return;
    }

    const scrollDOM = getEditorScrollElement();
    const preview = previewScrollRef.current;
    if (!scrollDOM || !preview) return;

    const maxPreview = preview.scrollHeight - preview.clientHeight;
    if (maxPreview <= 0) return;

    const fraction = preview.scrollTop / maxPreview;
    const maxCode = scrollDOM.scrollHeight - scrollDOM.clientHeight;
    if (maxCode <= 0) return;

    cancelAnimationFrame(codeRafRef.current);
    codeRafRef.current = requestAnimationFrame(() => {
      ignoreCodeScroll.current = true;
      scrollDOM.scrollTop = fraction * maxCode;
    });
  }, [enabled, getEditorScrollElement]);

  // Auto-attach code scroll listener with retry on mount/viewKey change
  useEffect(() => {
    if (!enabled) return;

    let scrollCleanup: (() => void) | undefined;
    let retryTimer: ReturnType<typeof setTimeout>;
    let attempts = 0;

    const tryAttach = (): void => {
      const scrollDOM = getEditorScrollElement();
      if (!scrollDOM) {
        if (attempts < MAX_ATTACH_ATTEMPTS) {
          attempts++;
          retryTimer = setTimeout(tryAttach, ATTACH_RETRY_INTERVAL);
        }
        return;
      }

      scrollDOM.addEventListener('scroll', handleCodeScroll, { passive: true });
      scrollCleanup = () => {
        scrollDOM.removeEventListener('scroll', handleCodeScroll);
      };
    };

    tryAttach();

    return () => {
      clearTimeout(retryTimer);
      scrollCleanup?.();
      cancelAnimationFrame(codeRafRef.current);
      cancelAnimationFrame(previewRafRef.current);
    };
  }, [enabled, viewKey, handleCodeScroll, getEditorScrollElement]);

  return {
    previewScrollRef,
    handleCodeScroll,
    handlePreviewScroll,
  };
}
