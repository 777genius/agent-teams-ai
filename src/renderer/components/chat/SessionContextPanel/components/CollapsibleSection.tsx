/**
 * CollapsibleSection - Generic collapsible wrapper for content sections.
 */

import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { formatTokens } from '../utils/formatting';

interface CollapsibleSectionProps {
  title: string;
  count: number;
  tokenCount: number;
  isExpanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

export const CollapsibleSection = ({
  title,
  count,
  tokenCount,
  isExpanded,
  onToggle,
  children,
}: Readonly<CollapsibleSectionProps>): React.ReactElement => {
  const { t } = useAppTranslation('common');

  return (
    <div
      className="overflow-hidden rounded-lg"
      style={{
        backgroundColor: 'var(--color-surface-raised)',
        border: '1px solid var(--color-border-subtle)',
      }}
    >
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between px-3 py-2 transition-colors"
        style={{
          backgroundColor: isExpanded ? 'var(--color-surface-overlay)' : 'transparent',
        }}
      >
        <div className="flex items-center gap-2">
          {isExpanded ? (
            <ChevronDown size={14} style={{ color: 'var(--color-text-secondary)' }} />
          ) : (
            <ChevronRight size={14} style={{ color: 'var(--color-text-secondary)' }} />
          )}
          <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
            {title}
          </span>
          <span
            className="rounded px-1.5 py-0.5 text-xs"
            style={{
              backgroundColor: 'var(--color-surface-overlay)',
              color: 'var(--color-text-secondary)',
            }}
          >
            {count}
          </span>
        </div>
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {t('tokens.approxTokens', { tokens: formatTokens(tokenCount) })}
        </span>
      </button>

      {isExpanded && (
        <div
          className="space-y-2 px-3 py-2"
          style={{ borderTop: '1px solid var(--color-border-subtle)' }}
        >
          {children}
        </div>
      )}
    </div>
  );
};
