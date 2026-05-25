/**
 * ClaudeMdSection - CLAUDE.md files section with nested Global/Project/Directory groups.
 */

import React, { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { ChevronRight } from 'lucide-react';

import { buildDirectoryTree } from '../DirectoryTree/buildDirectoryTree';
import { DirectoryTreeNode } from '../DirectoryTree/DirectoryTreeNode';
import { ClaudeMdItem } from '../items/ClaudeMdItem';
import { formatTokens } from '../utils/formatting';

import type { ClaudeMdContextInjection } from '@renderer/types/contextInjection';

interface ClaudeMdSubSectionProps {
  label: string;
  injections: ClaudeMdContextInjection[];
  isDirectory: boolean;
  projectRoot: string;
  onNavigateToTurn?: (turnIndex: number) => void;
}

export const ClaudeMdSubSection = ({
  label,
  injections,
  isDirectory,
  projectRoot,
  onNavigateToTurn,
}: Readonly<ClaudeMdSubSectionProps>): React.ReactElement => {
  const { t } = useAppTranslation('common');
  const [expanded, setExpanded] = useState(true);
  const sectionTokens = injections.reduce((sum, inj) => sum + inj.estimatedTokens, 0);

  return (
    <div className="mb-2 last:mb-0">
      <div
        role="button"
        tabIndex={0}
        className="flex cursor-pointer items-center gap-1 py-1 text-xs hover:opacity-80"
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded(!expanded);
          }
        }}
      >
        <ChevronRight
          className={`size-3 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          style={{ color: 'var(--color-text-muted)' }}
        />
        <span style={{ color: 'var(--color-text-secondary)' }}>{label}</span>
        <span
          className="rounded px-1 py-0.5 text-xs"
          style={{
            backgroundColor: 'var(--color-surface-overlay)',
            color: 'var(--color-text-muted)',
          }}
        >
          {injections.length}
        </span>
        <span style={{ color: 'var(--color-text-muted)' }}>
          {t('tokens.approxTokensParenthesized', { tokens: formatTokens(sectionTokens) })}
        </span>
      </div>

      {expanded && (
        <div className="ml-4">
          {isDirectory ? (
            <DirectoryTreeNode
              node={buildDirectoryTree(injections, projectRoot)}
              onNavigateToTurn={onNavigateToTurn}
            />
          ) : (
            injections.map((injection) => (
              <ClaudeMdItem
                key={injection.id}
                injection={injection}
                projectRoot={projectRoot}
                onNavigateToTurn={onNavigateToTurn}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
};
