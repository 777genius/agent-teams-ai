/**
 * DefaultToolViewer
 *
 * Default rendering for tools that don't have specialized viewers.
 */

import React, { memo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';

import { type ItemStatus } from '../BaseItem';

import { CollapsibleOutputSection } from './CollapsibleOutputSection';
import {
  extractOutputText,
  formatToolOutputForDisplay,
  renderInput,
  renderOutput,
} from './renderHelpers';

import type { LinkedToolItem } from '@renderer/types/groups';

interface DefaultToolViewerProps {
  linkedTool: LinkedToolItem;
  status: ItemStatus;
}

export const DefaultToolViewer = memo(function DefaultToolViewer({
  linkedTool,
  status,
}: DefaultToolViewerProps) {
  const { t } = useAppTranslation('common');
  const displayOutputContent = linkedTool.result
    ? formatToolOutputForDisplay(linkedTool.name, linkedTool.result.content)
    : null;
  const hasMeaningfulOutput =
    displayOutputContent !== null &&
    (() => {
      const text = extractOutputText(displayOutputContent).trim();
      return text.length > 0 && text !== '[]' && text !== '{}';
    })();

  return (
    <>
      {/* Input Section */}
      <div>
        <div className="mb-1 text-xs" style={{ color: 'var(--tool-item-muted)' }}>
          {t('toolViewer.input')}
        </div>
        <div
          className="max-h-96 overflow-auto rounded p-3 font-mono text-xs"
          style={{
            backgroundColor: 'var(--code-bg)',
            border: '1px solid var(--code-border)',
            color: 'var(--color-text-secondary)',
          }}
        >
          {renderInput(linkedTool.name, linkedTool.input, {
            replaceAll: t('toolViewer.replaceAll'),
            agentAction: t('toolViewer.agent.action'),
            agentTeammate: t('toolViewer.agent.teammate'),
            agentTeam: t('toolViewer.agent.team'),
            agentRuntime: t('toolViewer.agent.runtime'),
            agentType: t('toolViewer.agent.type'),
            startupInstructionsHidden: t('toolViewer.agent.startupInstructionsHidden'),
            noInputRecorded: t('toolViewer.noInputRecorded'),
          })}
        </div>
      </div>

      {/* Output Section — Collapsed by default */}
      {!linkedTool.isOrphaned &&
        linkedTool.result &&
        hasMeaningfulOutput &&
        displayOutputContent && (
          <CollapsibleOutputSection status={status}>
            {renderOutput(displayOutputContent)}
          </CollapsibleOutputSection>
        )}
    </>
  );
});
