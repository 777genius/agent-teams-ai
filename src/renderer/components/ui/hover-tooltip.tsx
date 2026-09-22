import React from 'react';

import { cn } from '@renderer/lib/utils';

type HoverTooltipSide = 'top' | 'bottom';
type HoverTooltipAlign = 'start' | 'center' | 'end';

interface HoverTooltipProps {
  children: React.ReactNode;
  content: React.ReactNode;
  align?: HoverTooltipAlign;
  as?: 'span' | 'div';
  className?: string;
  contentClassName?: string;
  disabled?: boolean;
  dismissOnClick?: boolean;
  side?: HoverTooltipSide;
  stopClickPropagation?: boolean;
  title?: string;
}

const sideClassBySide: Record<HoverTooltipSide, string> = {
  top: 'bottom-full mb-2',
  bottom: 'top-full mt-2',
};

const alignClassByAlign: Record<HoverTooltipAlign, string> = {
  start: 'left-0',
  center: 'left-1/2 -translate-x-1/2',
  end: 'right-0',
};

const renderTooltipContent = (content: React.ReactNode): React.JSX.Element => {
  return typeof content === 'string' ? (
    <span className="whitespace-pre-line">{content}</span>
  ) : (
    <span>{content}</span>
  );
};

export const HoverTooltip = ({
  children,
  content,
  align = 'center',
  as = 'span',
  className,
  contentClassName,
  disabled = false,
  dismissOnClick = false,
  side = 'top',
  stopClickPropagation = false,
  title,
}: Readonly<HoverTooltipProps>): React.JSX.Element => {
  const TooltipWrapper = as;
  const [dismissed, setDismissed] = React.useState(false);

  if (disabled || !content) {
    return <TooltipWrapper className={className}>{children}</TooltipWrapper>;
  }

  return (
    <TooltipWrapper
      className={cn('group/hover-tooltip relative inline-flex min-w-0', className)}
      title={dismissed ? undefined : title}
      onBlur={dismissOnClick ? () => setDismissed(false) : undefined}
      onClick={(event: React.MouseEvent) => {
        if (dismissOnClick) {
          setDismissed(true);
        }
        if (stopClickPropagation) {
          event.stopPropagation();
        }
      }}
      onMouseLeave={dismissOnClick ? () => setDismissed(false) : undefined}
    >
      {children}
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute z-[80] w-max max-w-72 rounded-md border border-[var(--color-border-emphasis)] bg-[var(--color-surface-overlay)] px-2.5 py-1.5 text-left text-xs font-normal leading-relaxed text-[var(--color-text)] opacity-0 shadow-2xl shadow-black/40 ring-1 ring-black/10 transition-opacity duration-100',
          !dismissed &&
            'group-focus-within/hover-tooltip:opacity-100 group-hover/hover-tooltip:opacity-100',
          sideClassBySide[side],
          alignClassByAlign[align],
          contentClassName
        )}
      >
        {renderTooltipContent(content)}
      </span>
    </TooltipWrapper>
  );
};
