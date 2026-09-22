/**
 * ToolOutputsSection - Section for displaying tool outputs.
 */

import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';

import { ToolOutputItem } from '../items/ToolOutputItem';

import { CollapsibleSection } from './CollapsibleSection';

import type { ToolOutputInjection } from '@renderer/types/contextInjection';

interface ToolOutputsSectionProps {
  injections: ToolOutputInjection[];
  tokenCount: number;
  isExpanded: boolean;
  onToggle: () => void;
  onNavigateToTurn?: (turnIndex: number) => void;
}

export const ToolOutputsSection = ({
  injections,
  tokenCount,
  isExpanded,
  onToggle,
  onNavigateToTurn,
}: Readonly<ToolOutputsSectionProps>): React.ReactElement | null => {
  const { t } = useAppTranslation('common');

  if (injections.length === 0) return null;

  return (
    <CollapsibleSection
      title={t('tokens.toolOutputs')}
      count={injections.length}
      tokenCount={tokenCount}
      isExpanded={isExpanded}
      onToggle={onToggle}
    >
      {injections.map((injection) => (
        <ToolOutputItem
          key={injection.id}
          injection={injection}
          onNavigateToTurn={onNavigateToTurn}
        />
      ))}
    </CollapsibleSection>
  );
};
