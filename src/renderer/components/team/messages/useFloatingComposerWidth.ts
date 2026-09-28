import { type CSSProperties, type RefObject, useLayoutEffect, useState } from 'react';

import { stripEncodedTaskReferenceMetadata } from '@renderer/utils/taskReferenceUtils';

const MIN_WIDTH = 350;
const MAX_WIDTH = 500;
const TEXT_BUFFER = 4;

export function useFloatingComposerWidth({
  enabled,
  text,
  attachmentCount,
  textareaRef,
}: {
  enabled: boolean;
  text: string;
  attachmentCount: number;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}): CSSProperties | undefined {
  const [width, setWidth] = useState(MIN_WIDTH);

  useLayoutEffect(() => {
    if (!enabled) return;
    if (attachmentCount > 0) {
      setWidth(MAX_WIDTH);
      return;
    }

    const textarea = textareaRef.current;
    if (!textarea) return;

    const visibleText = stripEncodedTaskReferenceMetadata(text);
    if (visibleText.length === 0) {
      setWidth(MIN_WIDTH);
      return;
    }

    const computedStyle = window.getComputedStyle(textarea);
    const context = document.createElement('canvas').getContext('2d');
    if (!context) return;

    context.font =
      computedStyle.font ||
      [
        computedStyle.fontStyle,
        computedStyle.fontVariant,
        computedStyle.fontWeight,
        computedStyle.fontSize,
        computedStyle.fontFamily,
      ]
        .filter(Boolean)
        .join(' ');

    const longestLineWidth = visibleText
      .split(/\r\n|\r|\n/)
      .reduce((maxWidth, line) => Math.max(maxWidth, context.measureText(line).width), 0);
    const horizontalInset =
      (Number.parseFloat(computedStyle.paddingLeft) || 0) +
      (Number.parseFloat(computedStyle.paddingRight) || 0) +
      (Number.parseFloat(computedStyle.borderLeftWidth) || 0) +
      (Number.parseFloat(computedStyle.borderRightWidth) || 0) +
      TEXT_BUFFER;
    const nextWidth = Math.min(
      MAX_WIDTH,
      Math.max(MIN_WIDTH, Math.ceil(longestLineWidth + horizontalInset))
    );

    setWidth((currentWidth) => (currentWidth === nextWidth ? currentWidth : nextWidth));
  }, [attachmentCount, enabled, text, textareaRef]);

  return enabled ? { width, maxWidth: `min(${MAX_WIDTH}px, calc(100vw - 2rem))` } : undefined;
}
