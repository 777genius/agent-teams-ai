/**
 * ClaudeMdFilesSection - Section for displaying CLAUDE.md files with nested groups.
 */

import React, { useMemo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';

import { CLAUDE_MD_GROUP_CONFIG, CLAUDE_MD_GROUP_ORDER } from '../types';

import { ClaudeMdSubSection } from './ClaudeMdSection';
import { CollapsibleSection } from './CollapsibleSection';

import type { ClaudeMdGroupCategory } from '../types';
import type { ClaudeMdContextInjection } from '@renderer/types/contextInjection';

interface ClaudeMdFilesSectionProps {
  injections: ClaudeMdContextInjection[];
  tokenCount: number;
  isExpanded: boolean;
  onToggle: () => void;
  projectRoot: string;
  onNavigateToTurn?: (turnIndex: number) => void;
}

export const ClaudeMdFilesSection = ({
  injections,
  tokenCount,
  isExpanded,
  onToggle,
  projectRoot,
  onNavigateToTurn,
}: Readonly<ClaudeMdFilesSectionProps>): React.ReactElement | null => {
  const { t } = useAppTranslation('common');

  // Group CLAUDE.md injections by category
  const claudeMdGroups = useMemo(() => {
    const groups = new Map<ClaudeMdGroupCategory, ClaudeMdContextInjection[]>();

    for (const category of CLAUDE_MD_GROUP_ORDER) {
      groups.set(category, []);
    }

    for (const injection of injections) {
      for (const [category, config] of Object.entries(CLAUDE_MD_GROUP_CONFIG)) {
        if (config.sources.includes(injection.source)) {
          const group = groups.get(category as ClaudeMdGroupCategory) ?? [];
          group.push(injection);
          groups.set(category as ClaudeMdGroupCategory, group);
          break;
        }
      }
    }

    return groups;
  }, [injections]);

  // Get non-empty CLAUDE.md groups
  const nonEmptyClaudeMdGroups = useMemo(
    () =>
      CLAUDE_MD_GROUP_ORDER.filter((category) => {
        const group = claudeMdGroups.get(category);
        return group && group.length > 0;
      }),
    [claudeMdGroups]
  );

  if (injections.length === 0) return null;

  return (
    <CollapsibleSection
      title={t('sessionContext.claudeMdFiles')}
      count={injections.length}
      tokenCount={tokenCount}
      isExpanded={isExpanded}
      onToggle={onToggle}
    >
      {nonEmptyClaudeMdGroups.map((category) => {
        const group = claudeMdGroups.get(category) ?? [];
        const config = CLAUDE_MD_GROUP_CONFIG[category];
        return (
          <ClaudeMdSubSection
            key={category}
            label={config.label}
            injections={group}
            isDirectory={category === 'directory'}
            projectRoot={projectRoot}
            onNavigateToTurn={onNavigateToTurn}
          />
        );
      })}
    </CollapsibleSection>
  );
};
