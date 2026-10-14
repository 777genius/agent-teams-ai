import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { AttachmentDisplay } from '@renderer/components/team/attachments/AttachmentDisplay';
import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { afterEach, describe, expect, it, vi } from 'vitest';

const storeMocks = vi.hoisted(() => ({
  revealFileInEditor: vi.fn(),
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@renderer/components/team/editor/FileIcon', () => ({
  FileIcon: ({ fileName }: { fileName: string }) => React.createElement('span', null, fileName),
}));

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: { revealFileInEditor: (filePath: string) => void }) => unknown) =>
    selector({ revealFileInEditor: storeMocks.revealFileInEditor }),
}));

describe('AttachmentDisplay', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    storeMocks.revealFileInEditor.mockReset();
  });

  it('opens persisted non-image attachments in the built-in editor', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const getAttachments = vi.fn().mockResolvedValue([
      {
        id: 'att-1',
        data: Buffer.from('verification').toString('base64'),
        mimeType: 'text/markdown',
        filePath: '/app/data/attachments/team-a/msg-1/att-1--verification.md',
      },
    ]);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { teams: { getAttachments } },
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <TooltipProvider>
          <AttachmentDisplay
            teamName="team-a"
            messageId="msg-1"
            attachments={[
              {
                id: 'att-1',
                filename: 'verification.md',
                mimeType: 'text/markdown',
                size: 12,
              },
            ]}
          />
        </TooltipProvider>
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const button = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Open verification.md"]'
    );
    expect(button).not.toBeNull();

    await act(async () => {
      button?.click();
    });

    expect(storeMocks.revealFileInEditor).toHaveBeenCalledWith(
      '/app/data/attachments/team-a/msg-1/att-1--verification.md'
    );
  });
});
