import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';

import {
  CODE_BG,
  CODE_BORDER,
  COLOR_TEXT_MUTED,
  COLOR_TEXT_SECONDARY,
  TOOL_CALL_TEXT,
} from '@renderer/constants/cssVariables';
import { REHYPE_PLUGINS } from '@renderer/utils/markdownPlugins';
import { formatTokensCompact as formatTokens } from '@shared/utils/tokenFormatting';
import { format } from 'date-fns';
import { ChevronRight, Layers } from 'lucide-react';
import remarkGfm from 'remark-gfm';

import { CopyButton } from '../common/CopyButton';

import { markdownComponents } from './markdownComponents';

import type { CompactGroup } from '@renderer/types/groups';

interface CompactBoundaryProps {
  compactGroup: CompactGroup;
}

/**
 * CompactBoundary displays a horizontal divider indicating where
 * the conversation was compacted. Click to expand the compacted summary.
 */
export const CompactBoundary = ({
  compactGroup,
}: Readonly<CompactBoundaryProps>): React.JSX.Element => {
  const { timestamp, message } = compactGroup;
  const [isExpanded, setIsExpanded] = useState(false);

  // Extract content from message
  const getCompactContent = (): string => {
    if (!message?.content) return '';

    if (typeof message.content === 'string') {
      return message.content;
    }

    // If it's an array of content blocks, extract text
    if (Array.isArray(message.content)) {
      return message.content
        .filter((block: { type: string; text?: string }) => block.type === 'text')
        .map((block: { type: string; text?: string }) => block.text ?? '')
        .join('\n\n');
    }

    return '';
  };

  const compactContent = getCompactContent();

  return (
    <div className="my-4">
      {/* Divider with centered label */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="group flex w-full cursor-pointer items-center transition-opacity hover:opacity-90"
        aria-expanded={isExpanded}
        aria-label="Toggle compacted content"
      >
        {/* Left line */}
        <div className="h-px flex-1" style={{ backgroundColor: TOOL_CALL_TEXT, opacity: 0.3 }} />

        {/* Center content */}
        <div className="flex shrink-0 items-center gap-2 px-3">
          <ChevronRight
            size={12}
            className="transition-transform duration-200"
            style={{
              color: TOOL_CALL_TEXT,
              transform: isExpanded ? 'rotate(90deg)' : undefined,
            }}
          />
          <Layers size={12} style={{ color: TOOL_CALL_TEXT }} />
          <span
            className="whitespace-nowrap text-[11px] font-medium"
            style={{ color: TOOL_CALL_TEXT }}
          >
            Context compacted
          </span>

          {/* Token delta */}
          {compactGroup.tokenDelta && (
            <span
              className="whitespace-nowrap text-[10px] tabular-nums"
              style={{ color: COLOR_TEXT_MUTED }}
            >
              {formatTokens(compactGroup.tokenDelta.preCompactionTokens)} →{' '}
              {formatTokens(compactGroup.tokenDelta.postCompactionTokens)}
              <span style={{ color: 'var(--diff-added-text)' }}>
                {' '}
                ({formatTokens(Math.abs(compactGroup.tokenDelta.delta))} freed)
              </span>
            </span>
          )}

          {/* Phase badge */}
          {compactGroup.startingPhaseNumber && (
            <span
              className="whitespace-nowrap rounded px-1.5 py-0.5 text-[10px]"
              style={{
                backgroundColor: 'var(--compact-phase-bg)',
                color: 'var(--compact-phase-text)',
              }}
            >
              Phase {compactGroup.startingPhaseNumber}
            </span>
          )}

          {/* Timestamp */}
          <span className="whitespace-nowrap text-[10px]" style={{ color: COLOR_TEXT_MUTED }}>
            {format(timestamp, 'h:mm:ss a')}
          </span>
        </div>

        {/* Right line */}
        <div className="h-px flex-1" style={{ backgroundColor: TOOL_CALL_TEXT, opacity: 0.3 }} />
      </button>

      {/* Expanded Content */}
      {isExpanded && (
        <div
          className="group relative mt-2 overflow-hidden rounded-lg"
          style={{
            backgroundColor: CODE_BG,
            border: `1px solid ${CODE_BORDER}`,
          }}
        >
          {compactContent && <CopyButton text={compactContent} />}

          {/* Content - scrollable with left accent bar */}
          <div
            className="max-h-96 overflow-y-auto border-l-2 px-4 py-3"
            style={{ borderColor: TOOL_CALL_TEXT }}
          >
            {compactContent ? (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={REHYPE_PLUGINS}
                components={markdownComponents}
              >
                {compactContent}
              </ReactMarkdown>
            ) : (
              <div className="flex items-start gap-2">
                <Layers size={14} className="mt-0.5 shrink-0" style={{ color: COLOR_TEXT_MUTED }} />
                <div className="text-xs leading-relaxed" style={{ color: COLOR_TEXT_MUTED }}>
                  <p className="mb-1 font-medium" style={{ color: COLOR_TEXT_SECONDARY }}>
                    Conversation Compacted
                  </p>
                  <p>
                    Previous messages were summarized to save context. The full conversation history
                    is preserved in the session file.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
