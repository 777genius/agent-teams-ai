/**
 * ThinkingTextItem - Single thinking text item with expandable breakdown.
 */

import React, { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { COLOR_TEXT_MUTED, COLOR_TEXT_SECONDARY } from '@renderer/constants/cssVariables';
import { Brain, ChevronRight } from 'lucide-react';

import { formatTokens } from '../utils/formatting';

import type { ThinkingTextInjection } from '@renderer/types/contextInjection';

interface ThinkingTextItemProps {
  injection: ThinkingTextInjection;
  onNavigateToTurn?: (turnIndex: number) => void;
}

export const ThinkingTextItem = ({
  injection,
  onNavigateToTurn,
}: Readonly<ThinkingTextItemProps>): React.ReactElement => {
  const { t } = useAppTranslation('common');
  const [expanded, setExpanded] = useState(false);
  const turnIndex = injection.turnIndex;
  const isClickable = onNavigateToTurn && turnIndex >= 0;

  return (
    <div className="rounded px-2 py-1.5">
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
        <ChevronRight
          className={`size-3 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          style={{ color: COLOR_TEXT_MUTED }}
        />
        <Brain size={12} style={{ color: COLOR_TEXT_MUTED, flexShrink: 0 }} />
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
      </button>

      {expanded && injection.breakdown.length > 0 && (
        <div className="ml-6 mt-1 space-y-0.5">
          {injection.breakdown.map((item, idx) => (
            <div key={`${item.type}-${idx}`} className="flex items-center gap-2 py-0.5 text-xs">
              <span style={{ color: COLOR_TEXT_MUTED }}>
                {item.type === 'thinking'
                  ? t('sessionContext.items.thinking')
                  : t('sessionContext.items.text')}
              </span>
              <span style={{ color: COLOR_TEXT_MUTED, opacity: 0.7 }}>
                ~{formatTokens(item.tokenCount)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
