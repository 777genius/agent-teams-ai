import { useLayoutEffect, useRef, useState } from 'react';

import { cn } from '@renderer/lib/utils';

const FLOATING_FOOTER_FADE_HEIGHT = 28;

interface MessagesThreadViewProps {
  variant: 'sidebar' | 'wide';
  header?: React.ReactNode;
  search?: React.ReactNode;
  composer: React.ReactNode;
  status: React.ReactNode;
  composerStatus?: React.ReactNode;
  timeline: React.ReactNode;
  scrollRef: React.Ref<HTMLDivElement>;
  composerRef?: React.Ref<HTMLDivElement>;
  searchRef?: React.Ref<HTMLDivElement>;
  latestControl?: React.ReactNode;
  onScroll?: React.UIEventHandler<HTMLDivElement>;
  floatingFooter?: boolean;
  onFloatingFooterResize?: () => void;
}

/** Shared, fixed thread tree used by sidebar, Full Screen, and Bottom Sheet. */
export const MessagesThreadView = ({
  variant,
  header,
  search,
  composer,
  status,
  composerStatus,
  timeline,
  scrollRef,
  composerRef,
  searchRef,
  latestControl,
  onScroll,
  floatingFooter = false,
  onFloatingFooterResize,
}: Readonly<MessagesThreadViewProps>): React.JSX.Element => {
  const wide = variant === 'wide';
  const rootRef = useRef<HTMLDivElement>(null);
  const [floatingFooterHeight, setFloatingFooterHeight] = useState(0);

  useLayoutEffect(() => {
    if (!floatingFooter) return;
    const footer = rootRef.current?.querySelector<HTMLElement>('[data-messages-thread-footer]');
    if (!footer) return;
    const measure = (): void => {
      const height = Math.ceil(footer.getBoundingClientRect().height);
      setFloatingFooterHeight((previous) => (previous === height ? previous : height));
    };
    measure();
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    resizeObserver?.observe(footer);
    // ResizeObserver may be paused while Electron is occluded. React can still
    // update status rows or textarea styles in that state, so keep the reserve
    // in sync before the window becomes visible again.
    const mutationObserver = new MutationObserver(measure);
    mutationObserver.observe(footer, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    document.addEventListener('visibilitychange', measure);
    window.addEventListener('resize', measure);
    return () => {
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
      document.removeEventListener('visibilitychange', measure);
      window.removeEventListener('resize', measure);
    };
  }, [floatingFooter]);

  useLayoutEffect(() => {
    if (floatingFooter && floatingFooterHeight > 0) onFloatingFooterResize?.();
  }, [floatingFooter, floatingFooterHeight, onFloatingFooterResize]);

  return (
    <div
      ref={rootRef}
      className={cn(
        'relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--color-surface-sidebar)]',
        wide && 'bg-[var(--color-surface)]'
      )}
      data-messages-thread-layout={variant}
    >
      {header ? (
        <div className="shrink-0 border-b border-[var(--color-border)] px-4 py-2.5">{header}</div>
      ) : null}
      {search ? (
        <div ref={searchRef} className="shrink-0 border-b border-[var(--color-border)] px-3 py-1.5">
          {search}
        </div>
      ) : null}
      <div className="relative min-h-0 min-w-0 flex-1">
        <div
          ref={scrollRef}
          className={cn(
            'size-full overflow-y-auto overflow-x-hidden',
            wide ? 'touch-pan-y overscroll-contain px-4 py-2' : 'px-3 py-2'
          )}
          onScroll={onScroll}
          data-messages-thread-scroll="true"
        >
          {status}
          <div className="min-w-0">{timeline}</div>
          {floatingFooter ? (
            <div
              aria-hidden="true"
              style={{ height: floatingFooterHeight + FLOATING_FOOTER_FADE_HEIGHT }}
            />
          ) : null}
        </div>
        {floatingFooter && floatingFooterHeight > 0 ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 z-[5]"
            data-messages-thread-footer-fade="true"
            style={{
              bottom: floatingFooterHeight,
              height: FLOATING_FOOTER_FADE_HEIGHT,
              background: 'linear-gradient(to bottom, transparent, var(--color-surface))',
            }}
          />
        ) : null}
        {latestControl ? (
          <div
            className={cn('pointer-events-none absolute right-3 z-10', !floatingFooter && 'bottom-3')}
            style={
              floatingFooter
                ? { bottom: floatingFooterHeight + FLOATING_FOOTER_FADE_HEIGHT + 12 }
                : undefined
            }
          >
            <div className="pointer-events-auto">{latestControl}</div>
          </div>
        ) : null}
      </div>
      <div
        ref={composerRef}
        data-messages-thread-footer="true"
        className={cn(
          'min-h-0 overflow-y-auto',
          floatingFooter
            ? 'absolute inset-x-0 bottom-0 z-20 max-h-[calc(100%-6rem)] bg-[var(--color-surface)] px-3 pb-3 pt-0'
            : 'max-h-full border-t border-[var(--color-border)] px-3 py-2'
        )}
      >
        {composerStatus ? (
          <div className={cn(floatingFooter && 'max-h-[min(24vh,10rem)] overflow-y-auto')}>
            {composerStatus}
          </div>
        ) : null}
        <div data-messages-composer-content="true">{composer}</div>
      </div>
    </div>
  );
};
