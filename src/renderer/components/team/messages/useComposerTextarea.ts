import { useCallback, useEffect, useMemo, useRef } from 'react';

import type { MutableRefObject, Ref } from 'react';

export function useComposerTextarea(
  externalTextareaRef: Ref<HTMLTextAreaElement> | undefined,
  autoFocusKey?: number
): {
  textareaRef: (node: HTMLTextAreaElement | null) => void;
  internalTextareaRef: MutableRefObject<HTMLTextAreaElement | null>;
  focusComposerTextarea: () => void;
} {
  const internalTextareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = useMemo(() => {
    return (node: HTMLTextAreaElement | null) => {
      (internalTextareaRef as MutableRefObject<HTMLTextAreaElement | null>).current = node;
      if (typeof externalTextareaRef === 'function') {
        externalTextareaRef(node);
      } else if (externalTextareaRef) {
        (externalTextareaRef as MutableRefObject<HTMLTextAreaElement | null>).current = node;
      }
    };
  }, [externalTextareaRef]);
  const focusComposerTextarea = useCallback(() => {
    const focus = (): void => {
      internalTextareaRef.current?.focus();
    };
    focus();
    queueMicrotask(focus);
    window.requestAnimationFrame(focus);
  }, []);

  useEffect(() => {
    if (autoFocusKey === undefined || autoFocusKey <= 0) {
      return;
    }
    focusComposerTextarea();
  }, [autoFocusKey, focusComposerTextarea]);

  return { textareaRef, internalTextareaRef, focusComposerTextarea };
}
