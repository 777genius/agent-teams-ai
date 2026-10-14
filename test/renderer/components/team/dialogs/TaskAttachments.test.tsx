import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { TaskAttachments } from '@renderer/components/team/dialogs/TaskAttachments';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@renderer/components/team/attachments/ImageLightbox', () => ({
  ImageLightbox: () => null,
}));

const saveTaskAttachment = vi.fn(async () => undefined);
const deleteTaskAttachment = vi.fn(async () => undefined);
const getTaskAttachmentData = vi.fn(async () => 'preview');

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ saveTaskAttachment, deleteTaskAttachment, getTaskAttachmentData }),
}));

describe('TaskAttachments mutation gate', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('rechecks mutability after the real FileReader continuation', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let mutable = true;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <TaskAttachments teamName="team-b" taskId="1" attachments={[]} canMutate={() => mutable} />
      );
      await Promise.resolve();
    });

    const input = host.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    expect(input?.disabled).toBe(false);
    const transfer = new DataTransfer();
    transfer.items.add(new File(['fresh TEST image'], 'after-race.png', { type: 'image/png' }));
    if (input) input.files = transfer.files;

    await act(async () => {
      input?.dispatchEvent(new Event('change', { bubbles: true }));
      mutable = false;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(saveTaskAttachment).not.toHaveBeenCalled();
    expect(input?.disabled).toBe(true);

    await act(async () => root.unmount());
  });
});
