import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

const { useToolApprovalDiffMock } = vi.hoisted(() => ({
  useToolApprovalDiffMock: vi.fn(() => ({
    hasDiff: false,
    loading: false,
    error: null,
    fileName: '',
    oldString: '',
    newString: '',
    isNewFile: false,
    truncated: false,
    isBinary: false,
  })),
}));

vi.mock('@renderer/hooks/useToolApprovalDiff', () => ({
  useToolApprovalDiff: useToolApprovalDiffMock,
}));

import { ToolApprovalDiffPreview } from './ToolApprovalDiffPreview';

describe('ToolApprovalDiffPreview', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    localStorage.clear();
    useToolApprovalDiffMock.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('refreshes collapsed quick stats when a reused request ID belongs to a new run', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        <ToolApprovalDiffPreview
          toolName="Write"
          toolInput={{ content: 'first\nsecond', file_path: '/workspace/file.txt' }}
          teamName="team-one"
          runId="run-one"
          requestId="request-reused"
        />
      );
    });
    expect(host.textContent).toContain('+2');

    act(() => {
      root.render(
        <ToolApprovalDiffPreview
          toolName="Write"
          toolInput={{
            content: Array.from({ length: 200 }, (_, index) => `line-${index}`).join('\n'),
            file_path: '/workspace/file.txt',
          }}
          teamName="team-one"
          runId="run-two"
          requestId="request-reused"
        />
      );
    });

    const labels = Array.from(host.querySelectorAll('span'), (span) => span.textContent);
    expect(labels).toContain('+200');
    expect(labels).not.toContain('+2');
    expect(useToolApprovalDiffMock).toHaveBeenLastCalledWith(
      'Write',
      expect.objectContaining({
        content: expect.stringContaining('line-199'),
        file_path: '/workspace/file.txt',
      }),
      'team-one',
      'run-two',
      'request-reused',
      false
    );

    act(() => {
      root.unmount();
    });
  });
});
