import * as React from 'react';

import { cn } from '@renderer/lib/utils';

interface AutoResizeTextareaProps extends React.ComponentProps<'textarea'> {
  minRows?: number;
  maxRows?: number;
}

const AutoResizeTextarea = React.forwardRef<HTMLTextAreaElement, AutoResizeTextareaProps>(
  ({ className, minRows = 2, maxRows = 12, onChange, ...props }, forwardedRef) => {
    const internalRef = React.useRef<HTMLTextAreaElement | null>(null);

    const setRefs = React.useCallback(
      (node: HTMLTextAreaElement | null) => {
        internalRef.current = node;
        if (typeof forwardedRef === 'function') {
          forwardedRef(node);
        } else if (forwardedRef) {
          // eslint-disable-next-line no-param-reassign -- ref merging requires mutation
          forwardedRef.current = node;
        }
      },
      [forwardedRef]
    );

    const adjustHeight = React.useCallback(() => {
      const textarea = internalRef.current;
      if (!textarea) return;

      const computedStyle = window.getComputedStyle(textarea);
      const lineHeight = parseFloat(computedStyle.lineHeight) || 20;
      const paddingTop = parseFloat(computedStyle.paddingTop) || 0;
      const paddingBottom = parseFloat(computedStyle.paddingBottom) || 0;
      const borderTop = parseFloat(computedStyle.borderTopWidth) || 0;
      const borderBottom = parseFloat(computedStyle.borderBottomWidth) || 0;

      const minHeight =
        minRows * lineHeight + paddingTop + paddingBottom + borderTop + borderBottom;
      const maxHeight =
        maxRows * lineHeight + paddingTop + paddingBottom + borderTop + borderBottom;

      textarea.style.height = 'auto';
      const scrollHeight = textarea.scrollHeight;
      const clampedHeight = Math.min(Math.max(scrollHeight, minHeight), maxHeight);

      textarea.style.height = `${clampedHeight}px`;
      textarea.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
    }, [minRows, maxRows]);

    React.useEffect(() => {
      adjustHeight();
    }, [adjustHeight, props.value]);

    const handleChange = React.useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        onChange?.(e);
        adjustHeight();
      },
      [onChange, adjustHeight]
    );

    return (
      <textarea
        className={cn(
          'flex w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm shadow-sm transition-[height] duration-100 ease-in-out placeholder:text-[var(--color-text-muted)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-emphasis)] disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        ref={setRefs}
        rows={minRows}
        onChange={handleChange}
        {...props}
      />
    );
  }
);
AutoResizeTextarea.displayName = 'AutoResizeTextarea';

export { AutoResizeTextarea };
export type { AutoResizeTextareaProps };
