/**
 * SkillToolViewer
 *
 * Renders the Skill tool with its instructions in a code block viewer style.
 */

import React, { memo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { CodeBlockViewer } from '@renderer/components/chat/viewers';

import type { LinkedToolItem } from '@renderer/types/groups';

interface SkillToolViewerProps {
  linkedTool: LinkedToolItem;
}

export const SkillToolViewer = memo(function SkillToolViewer({ linkedTool }: SkillToolViewerProps) {
  const { t } = useAppTranslation('common');
  const skillInstructions = linkedTool.skillInstructions;
  const skillName = (linkedTool.input.skill as string) || t('chat.tools.skill.unknown');

  const resultContent = linkedTool.result?.content;
  const resultText =
    typeof resultContent === 'string'
      ? resultContent
      : Array.isArray(resultContent)
        ? resultContent
            .map((item: unknown) => (typeof item === 'string' ? item : JSON.stringify(item)))
            .join('\n')
        : '';

  return (
    <div className="space-y-3">
      {/* Initial result */}
      {resultText && (
        <div>
          <div className="mb-1 text-xs" style={{ color: 'var(--tool-item-muted)' }}>
            {t('chat.tools.result')}
          </div>
          <div
            className="overflow-x-auto rounded p-3 font-mono text-xs"
            style={{
              backgroundColor: 'var(--code-bg)',
              border: '1px solid var(--code-border)',
              color: 'var(--color-text-secondary)',
            }}
          >
            {resultText}
          </div>
        </div>
      )}

      {/* Skill instructions */}
      {skillInstructions && (
        <div>
          <div className="mb-1 text-xs" style={{ color: 'var(--tool-item-muted)' }}>
            {t('chat.tools.skill.instructions')}
          </div>
          <CodeBlockViewer
            fileName={`${skillName} skill`}
            content={skillInstructions}
            startLine={1}
          />
        </div>
      )}
    </div>
  );
});
