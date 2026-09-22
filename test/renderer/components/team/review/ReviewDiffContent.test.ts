import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReviewDiffContent } from '@renderer/components/team/review/ReviewDiffContent';

import type { FileChangeSummary } from '@shared/types';

describe('ReviewDiffContent', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  async function renderFile(
    file: FileChangeSummary
  ): Promise<{ host: HTMLDivElement; cleanup: () => Promise<void> }> {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ReviewDiffContent, { file }));
      await Promise.resolve();
    });

    return {
      host,
      cleanup: async () => {
        await act(async () => {
          root.unmount();
          await Promise.resolve();
        });
      },
    };
  }

  it('shows a ledger metadata-only message instead of an empty generic state', async () => {
    const file: FileChangeSummary = {
      filePath: '/repo/fixtures/blob.bin',
      relativePath: 'fixtures/blob.bin',
      snippets: [],
      linesAdded: 0,
      linesRemoved: 0,
      isNewFile: false,
      ledgerSummary: {
        latestOperation: 'modify',
        contentAvailability: 'metadata-only',
        reviewability: 'metadata-only',
      },
    };

    const { host, cleanup } = await renderFile(file);

    expect(host.textContent).toContain(
      'Ledger metadata is available, but no text diff can be rendered for this file.'
    );
    expect(host.textContent).not.toContain('No changes to display');

    await cleanup();
  });

  it('uses a text-specific empty state when no ledger metadata-only signal exists', async () => {
    const file: FileChangeSummary = {
      filePath: '/repo/src/noop.ts',
      relativePath: 'src/noop.ts',
      snippets: [],
      linesAdded: 0,
      linesRemoved: 0,
      isNewFile: false,
    };

    const { host, cleanup } = await renderFile(file);

    expect(host.textContent).toContain('No text changes to display');

    await cleanup();
  });
});
