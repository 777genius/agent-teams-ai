import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { AttachmentDisplay } from '@renderer/components/team/attachments/AttachmentDisplay';
import { SourceMessageAttachments } from '@renderer/components/team/attachments/SourceMessageAttachments';
import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SourceMessageSnapshot } from '@shared/types';

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

  it('keeps a task source reference GIF generic beside a native PNG and preserves legacy thumbnails', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const pngData =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPfoAAAAASUVORK5CYII=';
    const gifData = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const getAttachments = vi.fn().mockResolvedValue([
      { id: 'png', mimeType: 'image/png', data: pngData, filePath: '/saved/native.png' },
      { id: 'gif', mimeType: 'image/gif', data: gifData, filePath: '/saved/reference.gif' },
    ]);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { teams: { getAttachments } },
    });
    const sourceMessage: SourceMessageSnapshot = {
      text: 'Read both images',
      from: 'user',
      timestamp: '2026-10-13T12:00:00Z',
      attachments: [
        {
          id: 'png',
          filename: 'native.png',
          mimeType: 'image/png',
          size: Buffer.from(pngData, 'base64').length,
        },
        {
          id: 'gif',
          filename: 'reference.gif',
          mimeType: 'image/gif',
          size: Buffer.from(gifData, 'base64').length,
        },
      ],
      fileReferenceIds: ['gif'],
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const renderSource = async (snapshot: SourceMessageSnapshot) => {
      await act(async () => {
        root.render(
          <TooltipProvider>
            <SourceMessageAttachments
              teamName="team-a"
              sourceMessageId="msg-1"
              sourceMessage={snapshot}
            />
          </TooltipProvider>
        );
      });
      await act(async () => {
        await Promise.resolve();
      });
    };
    try {
      await renderSource(sourceMessage);
      expect(getAttachments).toHaveBeenCalledWith('team-a', 'msg-1');
      expect(host.querySelector('img[alt="native.png"]')).not.toBeNull();
      expect(host.querySelector('img[alt="reference.gif"]')).toBeNull();
      const card = host.querySelector<HTMLButtonElement>('button[aria-label="Open reference.gif"]');
      expect(card).not.toBeNull();
      expect(card?.textContent).toContain('reference.gif');
      await act(async () => {
        card?.click();
      });
      expect(storeMocks.revealFileInEditor).toHaveBeenCalledWith('/saved/reference.gif');

      const legacy = { ...sourceMessage };
      delete legacy.fileReferenceIds;
      await renderSource(legacy);
      expect(host.querySelector('img[alt="native.png"]')).not.toBeNull();
      expect(host.querySelector('img[alt="reference.gif"]')).not.toBeNull();
      expect(host.querySelector('button[aria-label="Open reference.gif"]')).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
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
