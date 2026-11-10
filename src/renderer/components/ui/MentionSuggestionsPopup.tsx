import { MentionSuggestionList } from './MentionSuggestionList';
import { Popover, PopoverAnchor, PopoverContent } from './popover';

import type { ComponentProps, RefObject } from 'react';

interface Props extends ComponentProps<typeof MentionSuggestionList> {
  placement?: 'above';
  anchorRef: RefObject<HTMLDivElement | null>;
  open: boolean;
  top?: number;
  dismiss: () => void;
}

export const MentionSuggestionsPopup = ({
  placement,
  anchorRef,
  open,
  top,
  dismiss,
  ...list
}: Props): React.JSX.Element | null => {
  if (placement !== 'above')
    return open && top != null ? (
      <div className="absolute left-0 z-50 w-full" style={{ top }}>
        <MentionSuggestionList {...list} />
      </div>
    ) : null;
  return (
    <Popover
      modal={false}
      open={open}
      onOpenChange={(value) => {
        if (!value) dismiss();
      }}
    >
      <PopoverAnchor
        virtualRef={{
          current: {
            getBoundingClientRect: () =>
              anchorRef.current?.getBoundingClientRect() ?? new DOMRect(),
          },
        }}
      />
      <PopoverContent
        side="top"
        align="start"
        collisionPadding={8}
        data-mention-suggestions="above"
        className="overflow-hidden p-0"
        style={{
          width: 'var(--radix-popover-trigger-width)',
          maxHeight: 'var(--radix-popover-content-available-height)',
        }}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (event.target instanceof Node && anchorRef.current?.contains(event.target))
            event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          // Textarea's existing keyboard handler owns Escape and IME.
          event.preventDefault();
        }}
      >
        <MentionSuggestionList
          {...list}
          maxHeight="min(15rem, var(--radix-popover-content-available-height))"
        />
      </PopoverContent>
    </Popover>
  );
};
