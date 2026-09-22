import React, { memo } from 'react';

import { Slash } from 'lucide-react';

import { MarkdownViewer } from '../viewers';

import { BaseItem } from './BaseItem';

import type { SlashItem as SlashItemType } from '@renderer/types/groups';
import type { TriggerColor } from '@shared/constants/triggerColors';

interface SlashItemProps {
  slash: SlashItemType;
  onClick: () => void;
  isExpanded: boolean;
  /** Timestamp for display */
  timestamp?: Date;
  timestampFormat?: string;
  /** Additional classes for highlighting (e.g., error deep linking) */
  highlightClasses?: string;
  /** Inline styles for highlighting (used by custom hex colors) */
  highlightStyle?: React.CSSProperties;
  /** Notification dot color for custom triggers */
  notificationDotColor?: TriggerColor;
  titleText?: string;
}

/**
 * SlashItem displays a slash command invocation.
 * This unified component handles all slash types:
 * - Skills (e.g., /isolate-context)
 * - Built-in commands (e.g., /model, /context)
 * - Plugin commands
 * - MCP commands
 * - User-defined commands
 */
export const SlashItem = memo(
  ({
    slash,
    onClick,
    isExpanded,
    timestamp,
    timestampFormat,
    highlightClasses,
    highlightStyle,
    notificationDotColor,
    titleText,
  }: SlashItemProps): React.JSX.Element => {
    const hasInstructions = !!slash.instructions;

    // Display args or message as the description
    const description = slash.args ?? slash.message;

    return (
      <BaseItem
        icon={<Slash className="size-4" />}
        label={`/${slash.name}`}
        summary={description}
        tokenCount={slash.instructionsTokenCount}
        tokenLabel="tokens"
        status={hasInstructions ? 'ok' : undefined}
        timestamp={timestamp}
        timestampFormat={timestampFormat}
        titleText={titleText}
        onClick={onClick}
        isExpanded={isExpanded}
        hasExpandableContent={hasInstructions}
        highlightClasses={highlightClasses}
        highlightStyle={highlightStyle}
        notificationDotColor={notificationDotColor}
      >
        {hasInstructions && (
          <MarkdownViewer
            content={slash.instructions!}
            label="Slash Output"
            maxHeight="max-h-96"
            copyable
          />
        )}
      </BaseItem>
    );
  }
);

SlashItem.displayName = 'SlashItem';
