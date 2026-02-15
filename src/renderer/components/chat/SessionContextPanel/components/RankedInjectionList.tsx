/**
 * RankedInjectionList - Flat list of all context injections sorted by token size descending.
 * Provides a unified view across all categories, ranked by largest token consumers.
 */

import React, { useMemo } from 'react';

import { COLOR_TEXT_MUTED, COLOR_TEXT_SECONDARY } from '@renderer/constants/cssVariables';

import { formatTokens } from '../utils/formatting';
import { parseTurnIndex } from '../utils/pathParsing';

import type { ContextInjection } from '@renderer/types/contextInjection';

// =============================================================================
// Constants
// =============================================================================

const CATEGORY_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  'claude-md': { bg: 'rgba(99, 102, 241, 0.15)', text: '#818cf8', label: 'CLAUDE.md' },
  'mentioned-file': { bg: 'rgba(52, 211, 153, 0.15)', text: '#34d399', label: 'File' },
  'tool-output': { bg: 'rgba(251, 191, 36, 0.15)', text: '#fbbf24', label: 'Tool' },
  'thinking-text': { bg: 'rgba(167, 139, 250, 0.15)', text: '#a78bfa', label: 'Thinking' },
  'task-coordination': { bg: 'rgba(251, 146, 60, 0.15)', text: '#fb923c', label: 'Team' },
  'user-message': { bg: 'rgba(96, 165, 250, 0.15)', text: '#60a5fa', label: 'User' },
};

// =============================================================================
// Props
// =============================================================================

interface RankedInjectionListProps {
  injections: ContextInjection[];
  onNavigateToTurn?: (turnIndex: number) => void;
}

// =============================================================================
// Helpers
// =============================================================================

function getInjectionDescription(injection: ContextInjection): string {
  switch (injection.category) {
    case 'claude-md':
      return injection.displayName || injection.path;
    case 'mentioned-file':
      return injection.displayName;
    case 'tool-output':
      return `${injection.toolCount} tool${injection.toolCount !== 1 ? 's' : ''} in Turn ${injection.turnIndex + 1}`;
    case 'thinking-text':
      return `Turn ${injection.turnIndex + 1} thinking/text`;
    case 'task-coordination':
      return `Turn ${injection.turnIndex + 1} coordination`;
    case 'user-message':
      return injection.textPreview;
  }
}

function getInjectionTurnIndex(injection: ContextInjection): number {
  switch (injection.category) {
    case 'claude-md':
      return parseTurnIndex(injection.firstSeenInGroup);
    case 'mentioned-file':
      return injection.firstSeenTurnIndex;
    case 'tool-output':
    case 'thinking-text':
    case 'task-coordination':
    case 'user-message':
      return injection.turnIndex;
  }
}

// =============================================================================
// Component
// =============================================================================

export const RankedInjectionList = ({
  injections,
  onNavigateToTurn,
}: Readonly<RankedInjectionListProps>): React.ReactElement => {
  const sortedInjections = useMemo(
    () => [...injections].sort((a, b) => b.estimatedTokens - a.estimatedTokens),
    [injections]
  );

  const handleNavigate = (injection: ContextInjection): void => {
    if (!onNavigateToTurn) return;
    const turnIndex = getInjectionTurnIndex(injection);
    if (turnIndex >= 0) {
      onNavigateToTurn(turnIndex);
    }
  };

  return (
    <div className="space-y-1">
      {sortedInjections.map((inj) => {
        const categoryInfo = CATEGORY_COLORS[inj.category] ?? {
          bg: 'rgba(161, 161, 170, 0.15)',
          text: '#a1a1aa',
          label: inj.category,
        };
        const description = getInjectionDescription(inj);

        return (
          <button
            key={inj.id}
            onClick={() => handleNavigate(inj)}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-white/5"
          >
            {/* Category pill */}
            <span
              className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium"
              style={{
                backgroundColor: categoryInfo.bg,
                color: categoryInfo.text,
              }}
            >
              {categoryInfo.label}
            </span>
            {/* Description */}
            <span
              className="min-w-0 flex-1 truncate text-xs"
              style={{ color: COLOR_TEXT_SECONDARY }}
            >
              {description}
            </span>
            {/* Token count */}
            <span
              className="shrink-0 text-xs font-medium tabular-nums"
              style={{ color: COLOR_TEXT_MUTED }}
            >
              {formatTokens(inj.estimatedTokens)}
            </span>
          </button>
        );
      })}
    </div>
  );
};
