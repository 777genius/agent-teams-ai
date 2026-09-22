import { chipToken } from '@renderer/types/inlineChip';
import { describe, expect, it } from 'vitest';

import {
  composerWorkingSummary,
  hasVisibleDraftContent,
  readComposerWorkingIndex,
} from './composerDraftWorkingSummary';

import type {
  ComposerDraftAddress,
  ComposerDraftContent,
  ComposerWorkingRecord,
} from '@renderer/types/composerDraft';
import type { InlineChip } from '@renderer/types/inlineChip';

const address: ComposerDraftAddress = {
  contextId: 'context-a',
  teamName: 'team-a',
  target: { kind: 'direct', participant: 'alice' },
};
const chip: InlineChip = {
  id: 'chip-1',
  filePath: '/Users/private/secret.ts',
  fileName: 'secret.ts',
  fromLine: 1,
  toLine: 2,
  codeText: 'private code',
  language: 'typescript',
};

function record(
  content: ComposerDraftContent | null,
  editorContext: ComposerWorkingRecord['editorContext'] = { kind: 'plain' }
): ComposerWorkingRecord {
  return {
    version: 2,
    address,
    workingRevision: 'revision-1',
    content,
    editorContext,
    updatedAt: 42,
  };
}

function content(overrides: Partial<ComposerDraftContent> = {}): ComposerDraftContent {
  return { text: '', chips: [], attachments: [], actionMode: 'do', ...overrides };
}

describe('composerDraftWorkingSummary', () => {
  it('normalizes markdown and multiline text into a compact preview', () => {
    const summary = composerWorkingSummary(record(content({ text: '  **Hello**\n\nworld  ' })));
    expect(summary).toEqual(
      expect.objectContaining({
        preview: '**Hello** world',
        workingRevision: 'revision-1',
        updatedAt: 42,
        editorKind: 'plain',
      })
    );
  });

  it('does not create a summary for whitespace or action-mode-only changes', () => {
    expect(hasVisibleDraftContent(content({ text: ' \n ', actionMode: 'ask' }))).toBe(false);
    expect(composerWorkingSummary(record(content({ text: '\t', actionMode: 'ask' })))).toBeNull();
  });

  it('keeps structured counts without leaking attachment or chip paths', () => {
    const summary = composerWorkingSummary(
      record(
        content({
          text: chipToken(chip),
          chips: [chip],
          attachments: [
            {
              id: 'attachment-1',
              filename: 'secret.png',
              mimeType: 'image/png',
              size: 3,
              data: 'abc',
              filePath: '/Users/private/secret.png',
            },
          ],
        })
      )
    );
    expect(summary).toEqual(
      expect.objectContaining({ preview: '', chipCount: 1, attachmentCount: 1 })
    );
    expect(JSON.stringify(summary)).not.toContain('/Users/private');
  });

  it('truncates long Unicode text without splitting a surrogate pair', () => {
    const summary = composerWorkingSummary(record(content({ text: `${'a'.repeat(88)}😀tail` })));
    expect(summary?.preview).toBe(`${'a'.repeat(87)}…`);
    expect(summary?.preview).not.toContain('\ud83d');
  });

  it('preserves revision kind without exposing the original message id', () => {
    const summary = composerWorkingSummary(
      record(content({ text: 'revision text' }), {
        kind: 'revision',
        originalMessageId: 'private-original-id',
        recipient: 'alice',
        requestId: 'request-1',
      })
    );
    expect(summary?.editorKind).toBe('revision');
    expect(JSON.stringify(summary)).not.toContain('private-original-id');
  });

  it('rejects unknown index versions without modifying their payload', () => {
    const future = { version: 9, summaries: [{ opaque: true }] };
    expect(readComposerWorkingIndex(future)).toEqual({ summaries: [], unsupported: true });
    expect(future).toEqual({ version: 9, summaries: [{ opaque: true }] });
  });
});
