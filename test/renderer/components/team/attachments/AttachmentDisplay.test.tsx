import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { AttachmentDisplay } from '@renderer/components/team/attachments/AttachmentDisplay';
import { afterEach, describe, expect, it, vi } from 'vitest';

const storeMocks = vi.hoisted(() => ({
  revealFileInEditor: vi.fn(),
}));

const attachmentReadTransportMocks = vi.hoisted(() => ({
  getAttachments: vi.fn(),
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@renderer/components/team/editor/FileIcon', () => ({
  FileIcon: ({ fileName }: { fileName: string }) => React.createElement('span', null, fileName),
}));

vi.mock('@renderer/composition/team/createTeamMessageAttachmentReadTransport', () => ({
  createTeamMessageAttachmentReadTransport: () => attachmentReadTransportMocks,
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
    attachmentReadTransportMocks.getAttachments.mockReset();
  });

  it('opens persisted non-image attachments in the built-in editor', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    attachmentReadTransportMocks.getAttachments.mockResolvedValue([
      {
        id: 'att-1',
        data: Buffer.from('verification').toString('base64'),
        mimeType: 'text/markdown',
        filePath: '/app/data/attachments/team-a/msg-1/att-1--verification.md',
      },
    ]);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
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
    expect(attachmentReadTransportMocks.getAttachments).toHaveBeenCalledWith('team-a', 'msg-1');
  });

  it('fails safely when the attachment read transport is unavailable', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    attachmentReadTransportMocks.getAttachments.mockRejectedValue(new Error('hosted unavailable'));

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <AttachmentDisplay
          teamName="hosted-team"
          messageId="msg-2"
          attachments={[
            {
              id: 'att-2',
              filename: 'hosted.md',
              mimeType: 'text/markdown',
              size: 8,
            },
          ]}
        />
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.querySelector('button')).toBeNull();
    expect(host.textContent).not.toContain('taskAttachments.loading');
  });
});
