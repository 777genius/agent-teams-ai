import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SkillReviewDialog } from '@renderer/components/extensions/skills/SkillReviewDialog';

import type { SkillReviewAction, SkillReviewPreview } from '@shared/types/extensions';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@renderer/components/chat/viewers/DiffViewer', () => ({
  DiffViewer: ({ oldString, newString }: { oldString: string; newString: string }) => (
    <pre data-testid="review-diff">{`${oldString} → ${newString}`}</pre>
  ),
}));

describe('SkillReviewDialog file actions', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function renderChange(action: SkillReviewAction, isBinary: boolean) {
    const preview: SkillReviewPreview = {
      planId: 'review-a',
      targetSkillDir: '/fixture/skills/example',
      changes: [
        {
          relativePath: isBinary ? 'assets/sample.bin' : 'references/README.md',
          absolutePath: '/fixture/skills/example/file',
          action,
          isBinary,
          oldContent: isBinary ? null : 'Existing text',
          newContent: null,
        },
      ],
      warnings: [],
      summary: {
        created: Number(action === 'create'),
        updated: Number(action === 'update'),
        deleted: Number(action === 'delete'),
        binary: Number(isBinary),
      },
    };
    await act(async () =>
      root.render(
        <SkillReviewDialog
          open
          preview={preview}
          onClose={() => {}}
          onConfirm={() => {}}
          confirmLabel="Apply"
          reviewLabel="file changes"
        />
      )
    );
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    return dialog!;
  }

  it('labels a binary deletion without promising to copy the deleted file', async () => {
    const dialog = await renderChange('delete', true);
    expect(dialog.textContent).toContain('assets/sample.bin');
    expect(dialog.textContent).toContain('delete');
    expect(dialog.textContent).toContain('skillReview.binaryBadge');
    expect(dialog.textContent).not.toContain('skillReview.binaryPreviewHidden');
    expect(dialog.querySelector('[data-testid="review-diff"]')).toBeNull();
  });

  it.each(['create', 'update'] as const)('keeps the copy notice for binary %s', async (action) => {
    const dialog = await renderChange(action, true);
    expect(dialog.textContent).toContain('skillReview.binaryPreviewHidden');
    expect(dialog.querySelector('[data-testid="review-diff"]')).toBeNull();
  });

  it('keeps the text diff for a supported text deletion', async () => {
    const dialog = await renderChange('delete', false);
    expect(dialog.querySelector('[data-testid="review-diff"]')?.textContent).toBe(
      'Existing text → '
    );
    expect(dialog.textContent).not.toContain('skillReview.binaryPreviewHidden');
  });
});
