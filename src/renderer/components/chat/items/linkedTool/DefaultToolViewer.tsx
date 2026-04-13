/**
 * DefaultToolViewer
 *
 * Default rendering for tools that don't have specialized viewers.
 */

import React from 'react';

import { type ItemStatus } from '../BaseItem';

import { CollapsibleOutputSection } from './CollapsibleOutputSection';
import { extractOutputText, renderInput, renderOutput } from './renderHelpers';

import type { LinkedToolItem } from '@renderer/types/groups';

interface DefaultToolViewerProps {
  linkedTool: LinkedToolItem;
  status: ItemStatus;
}

export const DefaultToolViewer: React.FC<DefaultToolViewerProps> = ({ linkedTool, status }) => {
  const hasMeaningfulOutput =
    linkedTool.result &&
    (() => {
      const text = extractOutputText(linkedTool.result.content).trim();
      return text.length > 0 && text !== '[]' && text !== '{}';
    })();

  return (
    <>
      {/* Input Section */}
      <div>
        <div className="mb-1 text-xs" style={{ color: 'var(--tool-item-muted)' }}>
          Input
        </div>
        <div
          className="max-h-96 overflow-auto rounded p-3 font-mono text-xs"
          style={{
            backgroundColor: 'var(--code-bg)',
            border: '1px solid var(--code-border)',
            color: 'var(--color-text-secondary)',
          }}
        >
          {renderInput(linkedTool.name, linkedTool.input)}
        </div>
      </div>

      {/* Output Section — Collapsed by default */}
      {!linkedTool.isOrphaned && linkedTool.result && hasMeaningfulOutput && (
        <CollapsibleOutputSection status={status}>
          {renderOutput(linkedTool.result.content)}
        </CollapsibleOutputSection>
      )}
    </>
  );
};
