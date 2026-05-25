/**
 * TaskCoordinationItem - Single task coordination injection with expandable breakdown.
 */

import React, { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { COLOR_TEXT_MUTED, COLOR_TEXT_SECONDARY } from '@renderer/constants/cssVariables';
import { ChevronRight, Users } from 'lucide-react';

import { formatTokens } from '../utils/formatting';

import type { TaskCoordinationInjection } from '@renderer/types/contextInjection';

interface TaskCoordinationItemProps {
  injection: TaskCoordinationInjection;
  onNavigateToTurn?: (turnIndex: number) => void;
}

export const TaskCoordinationItem = ({
  injection,
  onNavigateToTurn,
}: Readonly<TaskCoordinationItemProps>): React.ReactElement => {
  const { t } = useAppTranslation('common');
  const [expanded, setExpanded] = useState(false);
  const turnIndex = injection.turnIndex;
  const isClickable = onNavigateToTurn && turnIndex >= 0;
  const hasBreakdown = injection.breakdown.length > 0;

  const containerContent = (
    <>
      {hasBreakdown && (
        <ChevronRight
          className={`size-3 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          style={{ color: COLOR_TEXT_MUTED }}
        />
      )}
      <Users size={12} style={{ color: COLOR_TEXT_MUTED, flexShrink: 0 }} />
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
        {t('sessionContext.items.itemsCount', { count: injection.breakdown.length })}
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
          {injection.breakdown.map((item, idx) => (
            <div key={`${item.label}-${idx}`} className="flex items-center justify-between text-xs">
              <span style={{ color: COLOR_TEXT_SECONDARY }}>{item.label}</span>
              <span className="tabular-nums" style={{ color: COLOR_TEXT_MUTED }}>
                ~{formatTokens(item.tokenCount)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
