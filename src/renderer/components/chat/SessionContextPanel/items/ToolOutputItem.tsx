/**
 * ToolOutputItem - Single tool output item with expandable breakdown.
 */

import React, { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { COLOR_TEXT_MUTED, COLOR_TEXT_SECONDARY } from '@renderer/constants/cssVariables';
import { ChevronRight, Wrench } from 'lucide-react';

import { formatTokens } from '../utils/formatting';

import { ToolBreakdownItem } from './ToolBreakdownItem';

import type { ToolOutputInjection } from '@renderer/types/contextInjection';

interface ToolOutputItemProps {
  injection: ToolOutputInjection;
  onNavigateToTurn?: (turnIndex: number) => void;
}

export const ToolOutputItem = ({
  injection,
  onNavigateToTurn,
}: Readonly<ToolOutputItemProps>): React.ReactElement => {
  const { t } = useAppTranslation('common');
  const [expanded, setExpanded] = useState(false);
  const turnIndex = injection.turnIndex;
  const isClickable = onNavigateToTurn && turnIndex >= 0;
  const hasBreakdown = injection.toolBreakdown.length > 0;

  const containerContent = (
    <>
      {hasBreakdown && (
        <ChevronRight
          className={`size-3 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          style={{ color: COLOR_TEXT_MUTED }}
        />
      )}
      <Wrench size={12} style={{ color: COLOR_TEXT_MUTED, flexShrink: 0 }} />
      {isClickable ? (
        <span
          role="link"
          tabIndex={0}
          className="cursor-pointer text-xs transition-opacity hover:opacity-80"
          style={{
            color: '#93c5fd',
            textDecoration: 'underline',
            textDecorationStyle: 'dotted' as const,
            textUnderlineOffset: '2px',
          }}
          onClick={(e) => {
            e.stopPropagation();
            onNavigateToTurn(turnIndex);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation();
              onNavigateToTurn(turnIndex);
            }
          }}
        >
          {t('sessionContext.items.turn', { turn: turnIndex + 1 })}
        </span>
      ) : (
        <span className="text-xs" style={{ color: COLOR_TEXT_SECONDARY }}>
          {t('sessionContext.items.turn', { turn: turnIndex + 1 })}
        </span>
      )}
      <span className="text-xs" style={{ color: COLOR_TEXT_MUTED }}>
        {t('sessionContext.items.tokensApprox', {
          tokens: formatTokens(injection.estimatedTokens),
        })}
      </span>
      <span
        className="rounded px-1 py-0.5 text-xs"
        style={{
          backgroundColor: 'var(--color-surface-overlay)',
          color: COLOR_TEXT_MUTED,
        }}
      >
        {t('sessionContext.items.toolsCount', { count: injection.toolCount })}
      </span>
    </>
  );

  return (
    <div className="rounded px-2 py-1.5">
      {hasBreakdown ? (
        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-1.5 hover:opacity-80"
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            font: 'inherit',
            textAlign: 'left',
          }}
          onClick={() => setExpanded(!expanded)}
        >
          {containerContent}
        </button>
      ) : (
        <div className="flex items-center gap-1.5">{containerContent}</div>
      )}

      {expanded && hasBreakdown && (
        <div className="ml-6 mt-1 space-y-0.5">
          {injection.toolBreakdown.map((tool, idx) => (
            <ToolBreakdownItem key={`${tool.toolName}-${idx}`} tool={tool} />
          ))}
        </div>
      )}
    </div>
  );
};
