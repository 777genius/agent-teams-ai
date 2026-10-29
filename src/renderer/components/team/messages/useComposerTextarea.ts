import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { FocusEvent, MutableRefObject, Ref } from 'react';

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

/** Keep the footer stable while pointer or keyboard focus moves to Composer controls. */
export function useComposerFocus() {
  const [isTextareaFocused, setIsTextareaFocused] = useState(false);
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const onTextareaFocus = useCallback(() => {
    setIsTextareaFocused(true);
    setIsComposerFocused(true);
  }, []);
  const onTextareaBlur = useCallback(() => setIsTextareaFocused(false), []);
  const onBlurCapture = useCallback((event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !event.currentTarget.contains(next)) setIsComposerFocused(false);
  }, []);
  return {
    isTextareaFocused,
    isComposerFocused,
    onTextareaFocus,
    onTextareaBlur,
    onBlurCapture,
  };
}
