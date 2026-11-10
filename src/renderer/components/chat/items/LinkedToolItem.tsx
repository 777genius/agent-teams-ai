/**
 * LinkedToolItem
 *
 * Main component for rendering linked tool calls in the chat view.
 * Uses specialized viewers for different tool types and shared utilities
 * for summary generation and token calculation.
 */

import React, { memo, useRef } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { CARD_ICON_MUTED } from '@renderer/constants/cssVariables';
import { getTeamColorSet, getThemedBadge } from '@renderer/constants/teamColors';
import { useTheme } from '@renderer/hooks/useTheme';
import {
  getToolContextTokens,
  getToolStatus,
  getToolSummary,
  hasEditContent,
  hasReadContent,
  hasSkillInstructions,
  hasWriteContent,
} from '@renderer/utils/toolRendering';
import {
  getToolHighlightProps,
  getTriggerColorDef,
  isPresetColorKey,
  TOOL_HIGHLIGHT_CLASSES,
  type TriggerColor,
} from '@shared/constants/triggerColors';
import { Wrench } from 'lucide-react';

import { highlightQueryInText } from '../searchHighlightUtils';

import { BaseItem, StatusDot } from './BaseItem';
import { formatDuration } from './baseItemHelpers';
import {
  DefaultToolViewer,
  EditToolViewer,
  ReadToolViewer,
  SkillToolViewer,
  ToolErrorDisplay,
  WriteToolViewer,
} from './linkedTool';

import type { LinkedToolItem as LinkedToolItemType } from '@renderer/types/groups';

interface LinkedToolItemProps {
  linkedTool: LinkedToolItemType;
  onClick: () => void;
  isExpanded: boolean;
  /** Timestamp for display */
  timestamp?: Date;
  timestampFormat?: string;
  /** Optional local search query override for inline highlighting */
  searchQueryOverride?: string;
  /** Whether this item should be highlighted for error deep linking */
  isHighlighted?: boolean;
  /** Custom highlight color from trigger */
  highlightColor?: TriggerColor;
  /** Notification dot color for this tool item */
  notificationDotColor?: TriggerColor;
  /** Optional ref registration callback for external scroll control */
  registerRef?: (el: HTMLDivElement | null) => void;
  titleText?: string;
}

export const LinkedToolItem = memo(
  ({
    linkedTool,
    onClick,
    isExpanded,
    timestamp,
    timestampFormat,
    searchQueryOverride,
    isHighlighted,
    highlightColor,
    notificationDotColor,
    registerRef,
    titleText,
  }: LinkedToolItemProps): React.JSX.Element => {
    const { t } = useAppTranslation('common');
    const status = getToolStatus(linkedTool);
    const { isLight } = useTheme();
    const summary = getToolSummary(linkedTool.name, linkedTool.input);
    const normalizedToolName = linkedTool.name.toLowerCase();
    const summaryNode =
      searchQueryOverride && searchQueryOverride.trim().length > 0
        ? highlightQueryInText(
            summary,
            searchQueryOverride,
            `${linkedTool.id ?? linkedTool.name}:summary`,
            {
              forceAllActive: true,
            }
          )
        : summary;
    const elementRef = useRef<HTMLDivElement>(null);

    // Combined ref callback - handles both internal ref and external registration
    const handleRef = (el: HTMLDivElement | null): void => {
      // Update internal ref
      (elementRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
      // Call external registration if provided
      registerRef?.(el);
    };

    // Render teammate_spawned results as a minimal inline row
    const isTeammateSpawned = linkedTool.result?.toolUseResult?.status === 'teammate_spawned';
    if (isTeammateSpawned) {
      const teamResult = linkedTool.result!.toolUseResult!;
      const name = (teamResult.name as string) || t('members.teammateFallback');
      const color = (teamResult.color as string) || '';
      const colors = getTeamColorSet(color);
      return (
        <div ref={handleRef} className="flex items-center gap-2 px-3 py-1.5">
          <span className="size-2.5 rounded-full" style={{ backgroundColor: colors.border }} />
          <span
            className="rounded px-1.5 py-0.5 text-[10px] font-medium"
            style={{ backgroundColor: getThemedBadge(colors, isLight), color: colors.text }}
          >
            {name}
          </span>
          <span className="text-xs" style={{ color: CARD_ICON_MUTED }}>
            {t('chat.tools.teammateSpawned')}
          </span>
        </div>
      );
    }

    // Render SendMessage shutdown_request as a minimal inline row
    const isShutdownRequest =
      linkedTool.name === 'SendMessage' && linkedTool.input?.type === 'shutdown_request';
    if (isShutdownRequest) {
      const target = (linkedTool.input?.recipient as string) || t('members.teammateFallback');
      return (
        <div ref={handleRef} className="flex items-center gap-2 px-3 py-1.5">
          <span className="size-2 rounded-full bg-zinc-500" />
          <span className="text-xs" style={{ color: CARD_ICON_MUTED }}>
            {t('chat.tools.shutdownRequested')}{' '}
            <span className="font-medium text-text-secondary">{target}</span>
          </span>
        </div>
      );
    }

    // Note: We no longer scroll locally - the navigation coordinator handles this
    // via the registered ref. This prevents double-scroll issues.

    // Highlight animation for error deep linking (supports custom hex)
    const effectiveColor = highlightColor ?? 'red';
    let highlightClasses = '';
    let highlightStyle: React.CSSProperties | undefined;
    if (isHighlighted) {
      if (isPresetColorKey(effectiveColor)) {
        highlightClasses = TOOL_HIGHLIGHT_CLASSES[effectiveColor];
      } else {
        const hp = getToolHighlightProps(effectiveColor);
        highlightClasses = hp.className;
        highlightStyle = hp.style;
      }
    }

    // Determine which specialized viewer to use
    const useReadViewer =
      normalizedToolName === 'read' && hasReadContent(linkedTool) && !linkedTool.result?.isError;
    const useEditViewer = normalizedToolName === 'edit' && hasEditContent(linkedTool);
    const useWriteViewer =
      normalizedToolName === 'write' && hasWriteContent(linkedTool) && !linkedTool.result?.isError;
    const useSkillViewer = linkedTool.name === 'Skill' && hasSkillInstructions(linkedTool);
    const useDefaultViewer = !useReadViewer && !useEditViewer && !useWriteViewer && !useSkillViewer;

    // Check if we should show error display for Read/Write tools
    const showReadError = normalizedToolName === 'read' && linkedTool.result?.isError;
    const showWriteError = normalizedToolName === 'write' && linkedTool.result?.isError;

    return (
      <div ref={handleRef}>
        <BaseItem
          icon={
            <Wrench
              className="size-4"
              style={{ color: isHighlighted ? getTriggerColorDef(highlightColor).hex : undefined }}
            />
          }
          label={linkedTool.name}
          summary={summaryNode}
          tokenCount={getToolContextTokens(linkedTool)}
          status={status}
          durationMs={linkedTool.durationMs}
          timestamp={timestamp}
          timestampFormat={timestampFormat}
          titleText={titleText}
          onClick={onClick}
          isExpanded={isExpanded}
          highlightClasses={highlightClasses}
          highlightStyle={highlightStyle}
          notificationDotColor={notificationDotColor}
        >
          {/* Read tool with CodeBlockViewer */}
          {useReadViewer && <ReadToolViewer linkedTool={linkedTool} />}

          {/* Edit tool with DiffViewer */}
          {useEditViewer && <EditToolViewer linkedTool={linkedTool} status={status} />}

          {/* Write tool */}
          {useWriteViewer && <WriteToolViewer linkedTool={linkedTool} />}

          {/* Skill tool with instructions */}
          {useSkillViewer && <SkillToolViewer linkedTool={linkedTool} />}

          {/* Default rendering for other tools */}
          {useDefaultViewer && <DefaultToolViewer linkedTool={linkedTool} status={status} />}

          {/* Error output for Read tool */}
          {showReadError && <ToolErrorDisplay linkedTool={linkedTool} />}

          {/* Error output for Write tool */}
          {showWriteError && <ToolErrorDisplay linkedTool={linkedTool} />}

          {/* Orphaned indicator */}
          {linkedTool.isOrphaned && (
            <div
              className="flex items-center gap-2 text-xs italic"
              style={{ color: 'var(--tool-item-muted)' }}
            >
              <StatusDot status="orphaned" />
              {t('chat.tools.noResultReceived')}
            </div>
          )}

          {/* Timing */}
          <div className="text-xs" style={{ color: 'var(--tool-item-muted)' }}>
            {t('chat.tools.duration', { duration: formatDuration(linkedTool.durationMs) })}
          </div>
        </BaseItem>
      </div>
    );
  }
);

LinkedToolItem.displayName = 'LinkedToolItem';
