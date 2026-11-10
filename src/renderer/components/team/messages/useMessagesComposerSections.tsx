import { type ComponentProps, memo, type ReactNode } from 'react';

import { type MemberMessageComposerProps, MessageComposer } from './MessageComposer';
import { MessagesFloatingComposerModeControls } from './MessagesFloatingComposerModeControls';
import { ThreadAwareMessageComposer } from './ThreadAwareMessageComposer';

import type { TextMessageComposerProps } from './TextMessageComposer';

type ModeControlsProps = ComponentProps<typeof MessagesFloatingComposerModeControls>;

interface MessagesComposerSectionsOptions extends MemberMessageComposerProps {
  groupId: string | null | undefined;
  renderGroupComposer: (
    options?: Pick<TextMessageComposerProps, 'layout' | 'widthMode' | 'cornerActionPrefix'>
  ) => React.JSX.Element;
  groupArchiveAction: ReactNode;
  modeControls: ModeControlsProps;
}

// Keep the floating member composer identity stable across placement-hook calls.
// eslint-disable-next-line react-refresh/only-export-components
const MessagesComposerSection = memo(MessageComposer);

/** One placement boundary for the same conversation composer in every panel layout. */
export function useMessagesComposerSections({
  groupId,
  renderGroupComposer,
  groupArchiveAction,
  modeControls,
  ...sharedComposerProps
}: MessagesComposerSectionsOptions): {
  renderDefaultComposerSection: () => React.JSX.Element;
  renderCompactComposerSection: () => React.JSX.Element;
  renderFloatingComposerSection: () => React.JSX.Element;
} {
  const renderModeControls = (): React.JSX.Element => (
    <MessagesFloatingComposerModeControls {...modeControls} />
  );
  return {
    renderDefaultComposerSection: () =>
      groupId ? renderGroupComposer() : <ThreadAwareMessageComposer {...sharedComposerProps} />,
    renderCompactComposerSection: () =>
      groupId ? (
        renderGroupComposer({ layout: 'compact' })
      ) : (
        <ThreadAwareMessageComposer layout="compact" {...sharedComposerProps} />
      ),
    renderFloatingComposerSection: () =>
      groupId ? (
        renderGroupComposer({
          layout: 'compact',
          widthMode: 'floating-adaptive',
          cornerActionPrefix: (
            <>
              {groupArchiveAction}
              {renderModeControls()}
            </>
          ),
        })
      ) : (
        <MessagesComposerSection
          {...sharedComposerProps}
          layout="compact"
          widthMode="floating-adaptive"
          cornerActionPrefix={<div className="flex items-center gap-1">{renderModeControls()}</div>}
        />
      ),
  };
}
