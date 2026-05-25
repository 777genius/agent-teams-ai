import React, { memo, useCallback, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import {
  CODE_BG,
  CODE_BORDER,
  COLOR_TEXT_MUTED,
  TOOL_CALL_BG,
  TOOL_CALL_BORDER,
  TOOL_CALL_TEXT,
} from '@renderer/constants/cssVariables';
import { formatTokensCompact } from '@renderer/utils/formatters';
import { getToolContextTokens } from '@renderer/utils/toolRendering';
import { format } from 'date-fns';
import { ChevronRight, Layers, MailOpen } from 'lucide-react';

import { BaseItem } from './items/BaseItem';
import { LinkedToolItem } from './items/LinkedToolItem';
import { SlashItem } from './items/SlashItem';
import { SubagentItem } from './items/SubagentItem';
import { TeammateMessageItem } from './items/TeammateMessageItem';
import { TextItem } from './items/TextItem';
import { ThinkingItem } from './items/ThinkingItem';
import { MarkdownViewer } from './viewers/MarkdownViewer';

import type { AIGroupDisplayItem } from '@renderer/types/groups';
import type { TriggerColor } from '@shared/constants/triggerColors';

interface DisplayItemListProps {
  items: AIGroupDisplayItem[];
  onItemClick: (itemId: string) => void;
  expandedItemIds: Set<string>;
  aiGroupId: string;
  /** Render order for display items (visual only). */
  order?: 'chronological' | 'newest-first';
  /** Optional local search query override for markdown highlighting */
  searchQueryOverride?: string;
  /** Tool use ID to highlight for error deep linking */
  highlightToolUseId?: string;
  /** Custom highlight color from trigger */
  highlightColor?: TriggerColor;
  /** Map of tool use ID to trigger color for notification dots */
  notificationColorMap?: Map<string, TriggerColor>;
  /** Optional callback to register tool element refs for scroll targeting */
  registerToolRef?: (toolId: string, el: HTMLDivElement | null) => void;
  /** Max characters for preview text in item headers (default: 150 for thinking/output, 80 for input) */
  previewMaxLength?: number;
  /** Optional timestamp format override for all items in this list. */
  timestampFormat?: string;
  /** Whether to include compact item metadata in a hover tooltip. */
  showItemMetaTooltip?: boolean;
}

function buildItemMetaTooltip(
  timestamp: Date | undefined,
  tokenCount: number | undefined,
  tokenLabel = 'tokens'
): string | undefined {
  const parts: string[] = [];
  if (timestamp) {
    parts.push(`Time: ${format(timestamp, 'HH:mm')}`);
  }
  if (tokenCount != null && tokenCount > 0) {
    parts.push(`Tokens: ~${formatTokensCompact(tokenCount)} ${tokenLabel}`);
  }
  return parts.length > 0 ? parts.join(' • ') : undefined;
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength) + '...';
}

function getItemKey(item: AIGroupDisplayItem, index: number): string {
  switch (item.type) {
    case 'thinking':
      return `thinking-${index}`;
    case 'output':
      return `output-${index}`;
    case 'tool':
      return `tool-${item.tool.id}-${index}`;
    case 'subagent':
      return `subagent-${item.subagent.id}-${index}`;
    case 'slash':
      return `slash-${item.slash.name}-${index}`;
    case 'teammate_message':
      return `teammate-${item.teammateMessage.id}-${index}`;
    case 'subagent_input':
      return `input-${index}`;
    case 'compact_boundary':
      return `compact-${index}`;
    default:
      return `unknown-${index}`;
  }
}

// =============================================================================
// Per-item row — memoized to prevent re-renders from parent state changes
// =============================================================================

interface DisplayItemRowProps {
  item: AIGroupDisplayItem;
  index: number;
  itemKey: string;
  isExpanded: boolean;
  isDimmed: boolean;
  hasReplyLink: boolean;
  onItemClick: (key: string) => void;
  onReplyHover: (toolId: string | null) => void;
  aiGroupId: string;
  searchQueryOverride?: string;
  highlightToolUseId?: string;
  highlightColor?: TriggerColor;
  notificationColorMap?: Map<string, TriggerColor>;
  registerToolRef?: (toolId: string, el: HTMLDivElement | null) => void;
  previewMaxLength?: number;
  timestampFormat?: string;
  showItemMetaTooltip?: boolean;
}

const DisplayItemRow = memo(function DisplayItemRow({
  item,
  index: _index,
  itemKey,
  isExpanded,
  isDimmed,
  hasReplyLink,
  onItemClick,
  onReplyHover,
  aiGroupId,
  searchQueryOverride,
  highlightToolUseId,
  highlightColor,
  notificationColorMap,
  registerToolRef,
  previewMaxLength,
  timestampFormat,
  showItemMetaTooltip = false,
}: DisplayItemRowProps): React.JSX.Element | null {
  const { t } = useAppTranslation('common');
  const handleClick = useCallback(() => onItemClick(itemKey), [onItemClick, itemKey]);

  let element: React.ReactNode = null;

  switch (item.type) {
    case 'thinking': {
      const thinkingStep = {
        id: itemKey,
        type: 'thinking' as const,
        startTime: item.timestamp,
        endTime: item.timestamp,
        durationMs: 0,
        content: { thinkingText: item.content, tokenCount: item.tokenCount },
        tokens: { input: 0, output: item.tokenCount ?? 0 },
        context: 'main' as const,
      };
      element = (
        <ThinkingItem
          step={thinkingStep}
          preview={truncateText(item.content, previewMaxLength ?? 150)}
          onClick={handleClick}
          isExpanded={isExpanded}
          timestamp={item.timestamp}
          timestampFormat={timestampFormat}
          titleText={
            showItemMetaTooltip
              ? buildItemMetaTooltip(item.timestamp, item.tokenCount, 'tokens')
              : undefined
          }
          markdownItemId={searchQueryOverride ? `${aiGroupId}:${itemKey}` : undefined}
          searchQueryOverride={searchQueryOverride}
        />
      );
      break;
    }

    case 'output': {
      const textStep = {
        id: itemKey,
        type: 'output' as const,
        startTime: item.timestamp,
        endTime: item.timestamp,
        durationMs: 0,
        content: { outputText: item.content, tokenCount: item.tokenCount },
        tokens: { input: 0, output: item.tokenCount ?? 0 },
        context: 'main' as const,
      };
      element = (
        <TextItem
          step={textStep}
          preview={truncateText(item.content, previewMaxLength ?? 150)}
          onClick={handleClick}
          isExpanded={isExpanded}
          timestamp={item.timestamp}
          timestampFormat={timestampFormat}
          titleText={
            showItemMetaTooltip
              ? buildItemMetaTooltip(item.timestamp, item.tokenCount, 'tokens')
              : undefined
          }
          markdownItemId={searchQueryOverride ? `${aiGroupId}:${itemKey}` : undefined}
          searchQueryOverride={searchQueryOverride}
        />
      );
      break;
    }

    case 'tool': {
      element = (
        <LinkedToolItem
          linkedTool={item.tool}
          onClick={handleClick}
          isExpanded={isExpanded}
          timestamp={item.tool.startTime}
          timestampFormat={timestampFormat}
          titleText={
            showItemMetaTooltip
              ? buildItemMetaTooltip(item.tool.startTime, getToolContextTokens(item.tool), 'tokens')
              : undefined
          }
          searchQueryOverride={searchQueryOverride}
          isHighlighted={highlightToolUseId === item.tool.id}
          highlightColor={highlightColor}
          notificationDotColor={notificationColorMap?.get(item.tool.id)}
          registerRef={registerToolRef ? (el) => registerToolRef(item.tool.id, el) : undefined}
        />
      );
      break;
    }

    case 'subagent': {
      const subagentStep = {
        id: itemKey,
        type: 'subagent' as const,
        startTime: item.subagent.startTime,
        endTime: item.subagent.endTime,
        durationMs: item.subagent.durationMs,
        content: {
          subagentId: item.subagent.id,
          subagentDescription: item.subagent.description,
        },
        isParallel: item.subagent.isParallel,
        context: 'main' as const,
      };
      element = (
        <SubagentItem
          step={subagentStep}
          subagent={item.subagent}
          onClick={handleClick}
          isExpanded={isExpanded}
          aiGroupId={aiGroupId}
          highlightToolUseId={highlightToolUseId}
          highlightColor={highlightColor}
          notificationColorMap={notificationColorMap}
          registerToolRef={registerToolRef}
        />
      );
      break;
    }

    case 'slash': {
      element = (
        <SlashItem
          slash={item.slash}
          onClick={handleClick}
          isExpanded={isExpanded}
          timestamp={item.slash.timestamp}
          timestampFormat={timestampFormat}
          titleText={
            showItemMetaTooltip
              ? buildItemMetaTooltip(
                  item.slash.timestamp,
                  item.slash.instructionsTokenCount,
                  'tokens'
                )
              : undefined
          }
        />
      );
      break;
    }

    case 'teammate_message': {
      element = (
        <TeammateMessageItem
          teammateMessage={item.teammateMessage}
          onClick={handleClick}
          isExpanded={isExpanded}
          onReplyHover={onReplyHover}
        />
      );
      break;
    }

    case 'subagent_input': {
      const inputContent = item.content;
      const inputTokenCount = item.tokenCount;
      element = (
        <BaseItem
          icon={<MailOpen className="size-4" />}
          label="Input"
          summary={truncateText(inputContent, previewMaxLength ?? 80)}
          tokenCount={inputTokenCount}
          timestamp={item.timestamp}
          timestampFormat={timestampFormat}
          titleText={
            showItemMetaTooltip
              ? buildItemMetaTooltip(item.timestamp, inputTokenCount, 'tokens')
              : undefined
          }
          onClick={handleClick}
          isExpanded={isExpanded}
        >
          <MarkdownViewer
            content={inputContent}
            copyable
            itemId={searchQueryOverride ? `${aiGroupId}:${itemKey}` : undefined}
            searchQueryOverride={searchQueryOverride}
          />
        </BaseItem>
      );
      break;
    }

    case 'compact_boundary': {
      const compactContent = item.content;
      element = (
        <div>
          <button
            onClick={handleClick}
            className="group flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 transition-all duration-200"
            style={{
              backgroundColor: TOOL_CALL_BG,
              border: `1px solid ${TOOL_CALL_BORDER}`,
            }}
            aria-expanded={isExpanded}
          >
            <div className="flex shrink-0 items-center gap-1.5" style={{ color: TOOL_CALL_TEXT }}>
              <ChevronRight
                size={14}
                className={`transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
              />
              <Layers size={14} />
            </div>
            <span className="shrink-0 text-xs font-medium" style={{ color: TOOL_CALL_TEXT }}>
              {t('chat.compact.compacted')}
            </span>
            {item.tokenDelta && (
              <span
                className="min-w-0 truncate text-[11px] tabular-nums"
                style={{ color: COLOR_TEXT_MUTED }}
              >
                {formatTokensCompact(item.tokenDelta.preCompactionTokens)} →{' '}
                {formatTokensCompact(item.tokenDelta.postCompactionTokens)}
                <span style={{ color: '#4ade80' }}>
                  {' '}
                  {t('chat.compact.freedTokens', {
                    tokens: formatTokensCompact(Math.abs(item.tokenDelta.delta)),
                  })}
                </span>
              </span>
            )}
            <span
              className="shrink-0 rounded px-1.5 py-0.5 text-[10px]"
              style={{
                backgroundColor: 'rgba(99, 102, 241, 0.15)',
                color: '#818cf8',
              }}
            >
              {t('chat.compact.phase', { phase: item.phaseNumber })}
            </span>
            <span className="ml-auto shrink-0 text-[11px]" style={{ color: COLOR_TEXT_MUTED }}>
              {format(new Date(item.timestamp), 'h:mm:ss a')}
            </span>
          </button>
          {isExpanded && compactContent && (
            <div
              className="mt-1 overflow-hidden rounded-lg"
              style={{
                backgroundColor: CODE_BG,
                border: `1px solid ${CODE_BORDER}`,
              }}
            >
              <div
                className="max-h-64 overflow-y-auto border-l-2 px-3 py-2"
                style={{ borderColor: 'var(--chat-ai-border)' }}
              >
                <MarkdownViewer content={compactContent} copyable />
              </div>
            </div>
          )}
        </div>
      );
      break;
    }

    default:
      return null;
  }

  return (
    <div
      style={
        hasReplyLink ? { opacity: isDimmed ? 0.2 : 1, transition: 'opacity 150ms ease' } : undefined
      }
    >
      {element}
    </div>
  );
});

// =============================================================================
// Main component
// =============================================================================

/**
 * Renders a flat list of AIGroupDisplayItem[] into the appropriate components.
 *
 * This component maps each display item to its corresponding component based on type:
 * - thinking -> ThinkingItem
 * - output -> TextItem
 * - tool -> LinkedToolItem
 * - subagent -> SubagentItem
 * - slash -> SlashItem
 *
 * The list is completely flat with no nested toggles or hierarchies.
 */
export const DisplayItemList = React.memo(function DisplayItemList({
  items,
  onItemClick,
  expandedItemIds,
  aiGroupId,
  order = 'chronological',
  searchQueryOverride,
  highlightToolUseId,
  highlightColor,
  notificationColorMap,
  registerToolRef,
  previewMaxLength,
  timestampFormat,
  showItemMetaTooltip = false,
}: Readonly<DisplayItemListProps>): React.JSX.Element {
  const { t } = useAppTranslation('common');
  const [replyLinkToolId, setReplyLinkToolId] = useState<string | null>(null);

  const handleReplyHover = useCallback((toolId: string | null) => {
    setReplyLinkToolId(toolId);
  }, []);

  if (!items || items.length === 0) {
    return (
      <div className="px-3 py-2 text-sm italic text-claude-dark-text-secondary">
        {t('chat.items.empty')}
      </div>
    );
  }

  return (
    <div
      className={
        order === 'newest-first' ? 'flex min-w-0 flex-col-reverse gap-2' : 'min-w-0 space-y-2'
      }
    >
      {items.map((item, index) => {
        const itemKey = getItemKey(item, index);
        const isExpanded = expandedItemIds.has(itemKey);

        const isInReplyLink =
          replyLinkToolId !== null &&
          ((item.type === 'tool' && item.tool.id === replyLinkToolId) ||
            (item.type === 'teammate_message' &&
              item.teammateMessage.replyToToolId === replyLinkToolId));
        const isDimmed = replyLinkToolId !== null && !isInReplyLink;

        return (
          <DisplayItemRow
            key={itemKey}
            item={item}
            index={index}
            itemKey={itemKey}
            isExpanded={isExpanded}
            isDimmed={isDimmed}
            hasReplyLink={replyLinkToolId !== null}
            onItemClick={onItemClick}
            onReplyHover={handleReplyHover}
            aiGroupId={aiGroupId}
            searchQueryOverride={searchQueryOverride}
            highlightToolUseId={highlightToolUseId}
            highlightColor={highlightColor}
            notificationColorMap={notificationColorMap}
            registerToolRef={registerToolRef}
            previewMaxLength={previewMaxLength}
            timestampFormat={timestampFormat}
            showItemMetaTooltip={showItemMetaTooltip}
          />
        );
      })}
    </div>
  );
});
