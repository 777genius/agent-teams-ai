import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { AttachmentDisplay } from '@renderer/components/team/attachments/AttachmentDisplay';
import { afterEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({ getAttachments: vi.fn() }));
vi.mock('@renderer/api', () => ({ api: { teams: apiMock } }));

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
    apiMock.getAttachments.mockResolvedValue([
      {
        id: 'att-1',
        data: Buffer.from('verification').toString('base64'),
        mimeType: 'text/markdown',
        filePath: '/app/data/attachments/team-a/msg-1/att-1--verification.md',
      },
    ]);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        teams: {
          getAttachments: () => {
            throw new Error('Ambient legacy IPC bypass');
          },
        },
      },
    });

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
  });
});

it('downloads an owner-read source file from verified bytes without a private path or legacy IPC', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  apiMock.getAttachments.mockResolvedValue([
    { id: 'TEST-file', data: btoa('TEST retained bytes'), mimeType: 'text/plain' },
  ]);
  const createURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:TEST-download');
  const revokeURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const clicks: { href: string; download: string }[] = [];
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    clicks.push({ href: this.href, download: this.download });
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <AttachmentDisplay
        teamName="host-team:TEST"
        messageId={`im1:TEST-task:${'a'.repeat(64)}`}
        attachments={[
          { id: 'TEST-file', filename: 'retained.txt', mimeType: 'text/plain', size: 19 },
        ]}
      />
    );
  });
  const button = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Download retained.txt"]'
  );
  expect(button).not.toBeNull();
  await act(async () => {
    button!.click();
  });
  expect(clicks).toEqual([{ href: 'blob:TEST-download', download: 'retained.txt' }]);
  expect(await (createURL.mock.calls[0]![0] as Blob).text()).toBe('TEST retained bytes');
  expect(revokeURL).toHaveBeenCalledWith('blob:TEST-download');
  expect(storeMocks.revealFileInEditor).not.toHaveBeenCalled();
  await act(async () => root.unmount());
  createURL.mockRestore();
  revokeURL.mockRestore();
  click.mockRestore();
});
