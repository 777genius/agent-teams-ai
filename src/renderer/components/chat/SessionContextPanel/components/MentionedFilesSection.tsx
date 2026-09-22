/**
 * MentionedFilesSection - Section for displaying mentioned files.
 */

import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';

import { MentionedFileItem } from '../items/MentionedFileItem';

import { CollapsibleSection } from './CollapsibleSection';

import type { MentionedFileInjection } from '@renderer/types/contextInjection';

interface MentionedFilesSectionProps {
  injections: MentionedFileInjection[];
  tokenCount: number;
  isExpanded: boolean;
  onToggle: () => void;
  projectRoot?: string;
  onNavigateToTurn?: (turnIndex: number) => void;
}

export const MentionedFilesSection = ({
  injections,
  tokenCount,
  isExpanded,
  onToggle,
  projectRoot,
  onNavigateToTurn,
}: Readonly<MentionedFilesSectionProps>): React.ReactElement | null => {
  const { t } = useAppTranslation('common');

  if (injections.length === 0) return null;

  return (
    <CollapsibleSection
      title={t('sessionContext.mentionedFiles')}
      count={injections.length}
      tokenCount={tokenCount}
      isExpanded={isExpanded}
      onToggle={onToggle}
    >
      {injections.map((injection) => (
        <MentionedFileItem
          key={injection.id}
          injection={injection}
          projectRoot={projectRoot}
          onNavigateToTurn={onNavigateToTurn}
        />
      ))}
    </CollapsibleSection>
  );
};
