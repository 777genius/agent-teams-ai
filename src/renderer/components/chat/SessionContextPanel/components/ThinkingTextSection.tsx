/**
 * ThinkingTextSection - Section for displaying thinking text.
 */

import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';

import { ThinkingTextItem } from '../items/ThinkingTextItem';

import { CollapsibleSection } from './CollapsibleSection';

import type { ThinkingTextInjection } from '@renderer/types/contextInjection';

interface ThinkingTextSectionProps {
  injections: ThinkingTextInjection[];
  tokenCount: number;
  isExpanded: boolean;
  onToggle: () => void;
  onNavigateToTurn?: (turnIndex: number) => void;
}

export const ThinkingTextSection = ({
  injections,
  tokenCount,
  isExpanded,
  onToggle,
  onNavigateToTurn,
}: Readonly<ThinkingTextSectionProps>): React.ReactElement | null => {
  const { t } = useAppTranslation('common');

  if (injections.length === 0) return null;

  return (
    <CollapsibleSection
      title={t('tokens.thinkingText')}
      count={injections.length}
      tokenCount={tokenCount}
      isExpanded={isExpanded}
      onToggle={onToggle}
    >
      {injections.map((injection) => (
        <ThinkingTextItem
          key={injection.id}
          injection={injection}
          onNavigateToTurn={onNavigateToTurn}
        />
      ))}
    </CollapsibleSection>
  );
};
