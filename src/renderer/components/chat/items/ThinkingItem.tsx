import React from 'react';

import { Brain } from 'lucide-react';

import { highlightQueryInText } from '../searchHighlightUtils';
import { MarkdownViewer } from '../viewers';

import { BaseItem } from './BaseItem';

import type { SemanticStep } from '@renderer/types/data';
import type { TriggerColor } from '@shared/constants/triggerColors';

interface ThinkingItemProps {
  step: SemanticStep;
  preview: string;
  onClick: () => void;
  isExpanded: boolean;
  /** Timestamp for display */
  timestamp?: Date;
  timestampFormat?: string;
  /** Optional local search query for inline highlighting */
  searchQueryOverride?: string;
  /** Optional stable item id for search highlighting */
  markdownItemId?: string;
  /** Additional classes for highlighting (e.g., error deep linking) */
  highlightClasses?: string;
  /** Inline styles for highlighting (used by custom hex colors) */
  highlightStyle?: React.CSSProperties;
  /** Notification dot color for custom triggers */
  notificationDotColor?: TriggerColor;
  titleText?: string;
}

export const ThinkingItem: React.FC<ThinkingItemProps> = React.memo(
  ({
    step,
    preview,
    onClick,
    isExpanded,
    timestamp,
    timestampFormat,
    searchQueryOverride,
    markdownItemId,
    highlightClasses,
    highlightStyle,
    notificationDotColor,
    titleText,
  }) => {
    const fullContent = step.content.thinkingText ?? preview;
    const summary = searchQueryOverride
      ? highlightQueryInText(preview, searchQueryOverride, `${markdownItemId ?? step.id}:summary`, {
          forceAllActive: true,
        })
      : preview;

    // Get token count from step.tokens.output or step.content.tokenCount
    const tokenCount = step.tokens?.output ?? step.content.tokenCount ?? 0;

    return (
      <BaseItem
        icon={<Brain className="size-4" />}
        label="Thinking"
        summary={summary}
        tokenCount={tokenCount}
        timestamp={timestamp}
        timestampFormat={timestampFormat}
        titleText={titleText}
        onClick={onClick}
        isExpanded={isExpanded}
        highlightClasses={highlightClasses}
        highlightStyle={highlightStyle}
        notificationDotColor={notificationDotColor}
      >
        <MarkdownViewer
          content={fullContent}
          maxHeight="max-h-96"
          copyable
          itemId={markdownItemId}
          searchQueryOverride={searchQueryOverride}
        />
      </BaseItem>
    );
  }
);

ThinkingItem.displayName = 'ThinkingItem';
