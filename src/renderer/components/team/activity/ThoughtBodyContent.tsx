import { type JSX, memo, useCallback, useMemo } from 'react';

import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { CopyButton } from '@renderer/components/common/CopyButton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { CARD_ICON_MUTED, CARD_TEXT_LIGHT } from '@renderer/constants/cssVariables';
import { linkifyAllMentionsInMarkdown } from '@renderer/utils/mentionLinkify';
import {
  areStringArraysEqual,
  areStringMapsEqual,
  areThoughtMessagesEquivalentForRender,
} from '@renderer/utils/messageRenderEquality';
import { linkifyTaskIdsInMarkdown, parseTaskLinkHref } from '@renderer/utils/taskReferenceUtils';
import { isApiErrorMessage } from '@shared/utils/apiErrorDetector';
import { stripTeammateMessageBlocks } from '@shared/utils/inboxNoise';
import { Reply } from 'lucide-react';

import { formatTimeWithSec, ToolSummaryTooltipContent } from './LeadThoughtsGroup';

import type { InboxMessage } from '@shared/types';

interface ThoughtBodyContentProps {
  thought: InboxMessage;
  showDivider?: boolean;
  onTaskIdClick?: (taskId: string) => void;
  onReply?: (message: InboxMessage) => void;
  memberColorMap?: ReadonlyMap<string, string>;
  teamNames?: string[];
  teamColorByName?: ReadonlyMap<string, string>;
  onTeamClick?: (teamName: string) => void;
}

export const ThoughtBodyContent = memo(
  function ThoughtBodyContent({
    thought,
    showDivider,
    onTaskIdClick,
    onReply,
    memberColorMap,
    teamNames = [],
    teamColorByName,
    onTeamClick,
  }: ThoughtBodyContentProps): JSX.Element {
    const displayContent = useMemo(() => {
      // Strip leaked protocol XML (<teammate-message> blocks) before rendering
      let text = stripTeammateMessageBlocks(thought.text).replace(/\n/g, '  \n');
      text = linkifyTaskIdsInMarkdown(text, thought.taskRefs);
      if ((memberColorMap && memberColorMap.size > 0) || teamNames.length > 0) {
        text = linkifyAllMentionsInMarkdown(
          text,
          (memberColorMap ?? new Map()) as Map<string, string>,
          teamNames
        );
      }
      return text;
    }, [thought.text, thought.taskRefs, memberColorMap, teamNames]);

    const handleTaskLinkClick = useCallback(
      (e: React.MouseEvent) => {
        if (!onTaskIdClick) return;
        const link = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="task://"]');
        if (!link) return;
        e.preventDefault();
        e.stopPropagation();
        const href = link.getAttribute('href');
        const parsed = href ? parseTaskLinkHref(href) : null;
        if (parsed?.taskId) onTaskIdClick(parsed.taskId);
      },
      [onTaskIdClick]
    );

    const handleReply = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        onReply?.(thought);
      },
      [onReply, thought]
    );

    const isApiError = useMemo(() => isApiErrorMessage(thought.text), [thought.text]);

    return (
      <>
        {showDivider && (
          <div className="py-px text-center">
            <span className="font-mono text-[9px]" style={{ color: CARD_ICON_MUTED }}>
              {formatTimeWithSec(thought.timestamp)}
            </span>
          </div>
        )}
        <div className="group/thought relative flex text-[11px]">
          <div
            className={`min-w-0 flex-1 [&>span>div>div>div]:py-2${isApiError ? '[&_code]:!text-red-400 [&_p]:!text-red-400' : ''}`}
            style={{ color: isApiError ? '#f87171' : CARD_TEXT_LIGHT }}
          >
            <span onClickCapture={onTaskIdClick ? handleTaskLinkClick : undefined}>
              <MarkdownViewer
                content={displayContent}
                maxHeight="max-h-none"
                bare
                teamColorByName={teamColorByName}
                onTeamClick={onTeamClick}
              />
            </span>
          </div>
          <div className="absolute right-1 top-0.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/thought:opacity-100">
            {onReply ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="rounded p-0.5 text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]"
                    onClick={handleReply}
                  >
                    <Reply size={13} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">Reply</TooltipContent>
              </Tooltip>
            ) : null}
            <CopyButton text={thought.text} inline />
          </div>
        </div>
        {thought.toolSummary && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className="mb-[7px] cursor-default pb-0.5 pl-3 pr-1 font-mono text-[9px]"
                style={{ color: CARD_ICON_MUTED }}
              >
                🔧 {thought.toolSummary}
              </div>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              align="start"
              className="max-w-[420px] font-mono text-[11px]"
            >
              <ToolSummaryTooltipContent
                toolCalls={thought.toolCalls}
                toolSummary={thought.toolSummary}
              />
            </TooltipContent>
          </Tooltip>
        )}
      </>
    );
  },
  (prev, next) =>
    prev.showDivider === next.showDivider &&
    prev.onTaskIdClick === next.onTaskIdClick &&
    prev.onReply === next.onReply &&
    prev.memberColorMap === next.memberColorMap &&
    areStringArraysEqual(prev.teamNames, next.teamNames) &&
    areStringMapsEqual(prev.teamColorByName, next.teamColorByName) &&
    prev.onTeamClick === next.onTeamClick &&
    areThoughtMessagesEquivalentForRender(prev.thought, next.thought)
);
