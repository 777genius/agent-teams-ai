/**
 * DirectoryTreeNode - Recursive component for rendering directory tree nodes.
 */

import React, { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { CopyablePath } from '@renderer/components/common/CopyablePath';
import { COLOR_TEXT_MUTED, COLOR_TEXT_SECONDARY } from '@renderer/constants/cssVariables';
import { ChevronRight } from 'lucide-react';

import { formatTokens } from '../utils/formatting';
import { formatFirstSeen, parseTurnIndex } from '../utils/pathParsing';

import type { TreeNode } from './types';

interface DirectoryTreeNodeProps {
  node: TreeNode;
  depth?: number;
  onNavigateToTurn?: (turnIndex: number) => void;
}

export const DirectoryTreeNode = ({
  node,
  depth = 0,
  onNavigateToTurn,
}: Readonly<DirectoryTreeNodeProps>): React.ReactElement | null => {
  const { t } = useAppTranslation('common');
  const [expanded, setExpanded] = useState(true);
  const indent = depth * 12;

  const sortedChildren = Array.from(node.children.values()).sort((a, b) => {
    if (a.isFile && !b.isFile) return -1;
    if (!a.isFile && b.isFile) return 1;
    return a.name.localeCompare(b.name);
  });

  if (node.isFile) {
    const turnIndex = node.firstSeenInGroup ? parseTurnIndex(node.firstSeenInGroup) : -1;
    const isClickable = onNavigateToTurn && turnIndex >= 0;

    return (
      <div
        style={{ paddingLeft: `${indent}px` }}
        className="flex items-center gap-1 py-0.5 text-xs"
      >
        <CopyablePath
          displayText={node.name}
          copyText={node.path}
          className="text-xs"
          style={{ color: COLOR_TEXT_SECONDARY }}
        />
        <span style={{ color: COLOR_TEXT_MUTED }}>
          {t('tokens.approxTokensParenthesized', { tokens: formatTokens(node.tokens ?? 0) })}
        </span>
        {node.firstSeenInGroup &&
          (isClickable ? (
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
              @{formatFirstSeen(node.firstSeenInGroup)}
            </button>
          ) : (
            <span
              className="text-xs"
              style={{
                color: COLOR_TEXT_MUTED,
                opacity: 0.7,
              }}
            >
              @{formatFirstSeen(node.firstSeenInGroup)}
            </span>
          ))}
      </div>
    );
  }

  return (
    <div>
      {node.name && (
        <div
          role="button"
          tabIndex={0}
          style={{ paddingLeft: `${indent}px` }}
          className="flex cursor-pointer items-center gap-1 py-0.5 text-xs hover:opacity-80"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(!expanded);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              setExpanded(!expanded);
            }
          }}
        >
          <ChevronRight
            className={`size-3 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
            style={{ color: COLOR_TEXT_MUTED }}
          />
          <span style={{ color: COLOR_TEXT_MUTED }}>{node.name}/</span>
        </div>
      )}
      {expanded &&
        sortedChildren.map((child) => (
          <DirectoryTreeNode
            key={child.name}
            node={child}
            depth={node.name ? depth + 1 : depth}
            onNavigateToTurn={onNavigateToTurn}
          />
        ))}
    </div>
  );
};
