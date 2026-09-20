import { cn } from '@renderer/lib/utils';

interface MessagesThreadViewProps {
  variant: 'sidebar' | 'wide';
  header?: React.ReactNode;
  search?: React.ReactNode;
  composer: React.ReactNode;
  status: React.ReactNode;
  timeline: React.ReactNode;
  scrollRef: React.Ref<HTMLDivElement>;
  composerRef?: React.Ref<HTMLDivElement>;
  onScroll?: React.UIEventHandler<HTMLDivElement>;
}

/** Shared, fixed thread tree used by sidebar, Full Screen, and Bottom Sheet. */
export const MessagesThreadView = ({
  variant,
  header,
  search,
  composer,
  status,
  timeline,
  scrollRef,
  composerRef,
  onScroll,
}: Readonly<MessagesThreadViewProps>): React.JSX.Element => {
  const wide = variant === 'wide';
  return (
    <div
      className={cn(
        'flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--color-surface-sidebar)]',
        wide && 'bg-[var(--color-surface)]'
      )}
      data-messages-thread-layout={variant}
    >
      {header ? (
        <div className="shrink-0 border-b border-[var(--color-border)] px-4 py-2.5">{header}</div>
      ) : null}
      {search ? (
        <div className="shrink-0 border-b border-[var(--color-border)] px-3 py-1.5">{search}</div>
      ) : null}
      <div
        ref={scrollRef}
        className={cn(
          'min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden',
          wide ? 'touch-pan-y overscroll-contain px-4 pb-4' : 'pb-14 pr-3 pt-2'
        )}
        onScroll={onScroll}
        data-messages-thread-scroll="true"
      >
        <div
          ref={composerRef}
          className={cn(
            'shrink-0',
            wide
              ? 'sticky top-0 z-[1] -mx-4 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 backdrop-blur'
              : 'pl-3'
          )}
        >
          {composer}
          {status}
        </div>
        <div className={cn('min-w-0', wide && 'mr-8 flex-1 px-3 pb-4 pt-2')}>{timeline}</div>
      </div>
    </div>
  );
};
