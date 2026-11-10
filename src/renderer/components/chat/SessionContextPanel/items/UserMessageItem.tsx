/**
 * UserMessageItem - Single user message item showing turn link, tokens, and preview.
 */

import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { COLOR_TEXT_MUTED, COLOR_TEXT_SECONDARY } from '@renderer/constants/cssVariables';
import { MessageSquare } from 'lucide-react';

import { formatTokens } from '../utils/formatting';

import type { UserMessageInjection } from '@renderer/types/contextInjection';

interface UserMessageItemProps {
  injection: UserMessageInjection;
  onNavigateToTurn?: (turnIndex: number) => void;
}

export const UserMessageItem = ({
  injection,
  onNavigateToTurn,
}: Readonly<UserMessageItemProps>): React.ReactElement => {
  const { t } = useAppTranslation('common');
  const turnIndex = injection.turnIndex;
  const isClickable = onNavigateToTurn && turnIndex >= 0;

  return (
    <div className="rounded px-2 py-1.5">
      <div className="flex w-full items-center gap-1.5">
        <MessageSquare size={12} style={{ color: COLOR_TEXT_MUTED, flexShrink: 0 }} />
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
            onClick={() => onNavigateToTurn(turnIndex)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
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
      </div>
      {injection.textPreview && (
        <div
          className="mt-0.5 truncate pl-5 text-xs italic"
          style={{ color: COLOR_TEXT_MUTED, opacity: 0.7 }}
        >
          {injection.textPreview}
        </div>
      )}
    </div>
  );
};
