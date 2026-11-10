/**
 * ClaudeMdItem - Single CLAUDE.md file item display.
 */

import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { CopyablePath } from '@renderer/components/common/CopyablePath';
import { resolveAbsolutePath, shortenDisplayPath } from '@renderer/utils/pathDisplay';

import { formatTokens } from '../utils/formatting';
import { formatFirstSeen, parseTurnIndex } from '../utils/pathParsing';

import type { ClaudeMdContextInjection } from '@renderer/types/contextInjection';

interface ClaudeMdItemProps {
  injection: ClaudeMdContextInjection;
  projectRoot?: string;
  onNavigateToTurn?: (turnIndex: number) => void;
}

export const ClaudeMdItem = ({
  injection,
  projectRoot,
  onNavigateToTurn,
}: Readonly<ClaudeMdItemProps>): React.ReactElement => {
  const { t } = useAppTranslation('common');
  const turnIndex = parseTurnIndex(injection.firstSeenInGroup);
  const isClickable = onNavigateToTurn && turnIndex >= 0;
  const displayPath = shortenDisplayPath(injection.path, projectRoot);
  const absolutePath = resolveAbsolutePath(injection.path, projectRoot);

  return (
    <div className="rounded px-2 py-1">
      <CopyablePath
        displayText={displayPath}
        copyText={absolutePath}
        className="text-xs"
        style={{ color: 'var(--color-text-secondary)' }}
      />
      <div className="mt-0.5 flex items-center gap-2">
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {t('tokens.approxTokens', { tokens: formatTokens(injection.estimatedTokens) })}
        </span>
        {isClickable ? (
          <button
            type="button"
            className="cursor-pointer text-xs transition-opacity hover:opacity-80"
            style={{
              color: '#93c5fd',
              textDecoration: 'underline',
              textDecorationStyle: 'dotted' as const,
              textUnderlineOffset: '2px',
              background: 'none',
              border: 'none',
              padding: 0,
              font: 'inherit',
              fontSize: '12px',
            }}
            onClick={() => onNavigateToTurn(turnIndex)}
          >
            @{formatFirstSeen(injection.firstSeenInGroup)}
          </button>
        ) : (
          <span
            className="text-xs"
            style={{
              color: 'var(--color-text-muted)',
              opacity: 0.7,
            }}
          >
            @{formatFirstSeen(injection.firstSeenInGroup)}
          </span>
        )}
      </div>
    </div>
  );
};
