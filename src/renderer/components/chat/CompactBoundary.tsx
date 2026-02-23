import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';

import {
  CODE_BG,
  CODE_BORDER,
  COLOR_TEXT_MUTED,
  COLOR_TEXT_SECONDARY,
  TOOL_CALL_BG,
  TOOL_CALL_BORDER,
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
 * CompactBoundary displays an interactive, collapsible marker indicating where
 * the conversation was compacted.
 *
 * Features:
 * - Minimalist design with subtle border and hover states
 * - Click to expand/collapse compacted content
 * - Scrollable content area with enforced max-height
 * - Linear/Notion-inspired aesthetics
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
    <div className="my-6">
      {/* Collapsible Header - Amber/orange accent for distinction */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="group flex w-full cursor-pointer items-center gap-3 overflow-hidden rounded-lg px-4 py-2.5 transition-all duration-200"
        style={{
          backgroundColor: TOOL_CALL_BG,
          border: `1px solid ${TOOL_CALL_BORDER}`,
        }}
        aria-expanded={isExpanded}
        aria-label="Toggle compacted content"
      >
        {/* Icon Stack */}
        <div
          className="flex shrink-0 items-center gap-2 transition-colors"
          style={{ color: TOOL_CALL_TEXT }}
        >
          <ChevronRight
            size={16}
            className={`transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
          />
          <Layers size={16} />
        </div>

        {/* Label */}
        <span
          className="shrink-0 whitespace-nowrap text-sm font-medium transition-colors"
          style={{ color: TOOL_CALL_TEXT }}
        >
          Compacted
        </span>

        {/* Token delta info */}
        {compactGroup.tokenDelta && (
          <span
            className="ml-2 min-w-0 truncate text-xs tabular-nums"
            style={{ color: COLOR_TEXT_MUTED }}
          >
            {formatTokens(compactGroup.tokenDelta.preCompactionTokens)} →{' '}
            {formatTokens(compactGroup.tokenDelta.postCompactionTokens)}
            <span style={{ color: '#4ade80' }}>
              {' '}
              ({formatTokens(Math.abs(compactGroup.tokenDelta.delta))} freed)
            </span>
          </span>
        )}

        {/* Phase badge */}
        {compactGroup.startingPhaseNumber && (
          <span
            className="shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px]"
            style={{ backgroundColor: 'rgba(99, 102, 241, 0.15)', color: '#818cf8' }}
          >
            Phase {compactGroup.startingPhaseNumber}
          </span>
        )}

        {/* Timestamp */}
        <span
          className="ml-auto shrink-0 whitespace-nowrap text-xs transition-colors"
          style={{ color: COLOR_TEXT_MUTED }}
        >
          {format(timestamp, 'h:mm:ss a')}
        </span>
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
            style={{ borderColor: 'var(--chat-ai-border)' }}
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
