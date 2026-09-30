import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useChangeReviewActionAvailability } from '@renderer/components/team/review/useChangeReviewActionAvailability';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FileChangeSummary, FileChangeWithContent } from '@shared/types';

const file: FileChangeSummary = {
  filePath: '/repo/a.ts',
  relativePath: 'a.ts',
  snippets: [
    {
      toolUseId: 'event-1',
      filePath: '/repo/a.ts',
      toolName: 'Write',
      type: 'write-new',
      oldString: '',
      newString: 'agent content',
      replaceAll: false,
      timestamp: '2026-09-29T00:00:00Z',
      isError: false,
      ledger: {
        eventId: 'event-1',
        source: 'ledger-exact',
        confidence: 'exact',
        originalFullContent: '',
        modifiedFullContent: 'agent content',
        beforeHash: null,
        afterHash: null,
      },
    },
  ],
  linesAdded: 1,
  linesRemoved: 0,
  isNewFile: true,
};
const fileContent: FileChangeWithContent = {
  ...file,
  originalFullContent: '',
  modifiedFullContent: 'agent content',
  contentSource: 'ledger-exact',
};

let latest: ReturnType<typeof useChangeReviewActionAvailability> | null = null;

function Probe({
  editedContents,
}: Readonly<{ editedContents: Record<string, string> }>): React.JSX.Element {
  latest = useChangeReviewActionAvailability({
    files: [file],
    fileContents: { [file.filePath]: fileContent },
    editedContents,
    hunkDecisions: {},
    fileDecisions: {},
    fileChunkCounts: {},
  });
  return <div />;
}

describe('useChangeReviewActionAvailability', () => {
  afterEach(() => {
    latest = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('keeps bulk Accept/Reject available only while the file has no manual draft', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const root = createRoot(document.body.appendChild(document.createElement('div')));

    await act(async () => {
      root.render(<Probe editedContents={{}} />);
      await Promise.resolve();
    });
    expect(latest).toEqual({
      rejectableFiles: [file],
      canAcceptAll: true,
      canRejectAll: true,
    });

    await act(async () => {
      root.render(<Probe editedContents={{ [file.filePath]: 'manual draft' }} />);
      await Promise.resolve();
    });
    expect(latest).toEqual({
      rejectableFiles: [],
      canAcceptAll: false,
      canRejectAll: false,
    });

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
