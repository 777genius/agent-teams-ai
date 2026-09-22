import { describe, expect, it, vi } from 'vitest';

import { createTeamProvisioningOpenCodeInboxAttachmentPayloadBoundary } from '../TeamProvisioningOpenCodeInboxAttachmentPayloadBoundaryFactory';

import type { OpenCodeAttachmentPayloadStore } from '../TeamProvisioningOpenCodeAttachmentPayloads';
import type { AttachmentMeta, InboxMessage } from '@shared/types';

const ISO = '2026-01-01T00:00:00.000Z';

function attachmentMeta(overrides: Partial<AttachmentMeta> = {}): AttachmentMeta {
  return {
    id: 'att-1',
    filename: 'image.png',
    mimeType: 'image/png',
    size: 4,
    ...overrides,
  };
}

function message(attachments: AttachmentMeta[]): InboxMessage & { messageId: string } {
  return {
    from: 'user',
    to: 'worker',
    text: 'see attachment',
    timestamp: ISO,
    read: false,
    messageId: 'msg-1',
    attachments,
  };
}

describe('TeamProvisioningOpenCodeInboxAttachmentPayloadBoundaryFactory', () => {
  it('binds attachment payload resolution to the current attachment store', async () => {
    let store: OpenCodeAttachmentPayloadStore = {
      getAttachments: vi.fn(async () => [{ id: 'att-1', data: 'aW1n', mimeType: 'image/png' }]),
    };
    const boundary = createTeamProvisioningOpenCodeInboxAttachmentPayloadBoundary({
      getAttachmentStore: () => store,
    });

    await expect(
      boundary.resolveOpenCodeInboxAttachmentPayloads({
        teamName: 'alpha',
        message: message([attachmentMeta({ mimeType: '' })]),
      })
    ).resolves.toEqual({
      ok: true,
      attachments: [{ ...attachmentMeta({ mimeType: '' }), mimeType: 'image/png', data: 'aW1n' }],
    });

    const nextStore: OpenCodeAttachmentPayloadStore = {
      getAttachments: vi.fn(async () => [{ id: 'att-1', data: 'bmV3', mimeType: 'text/plain' }]),
    };
    store = nextStore;

    await expect(
      boundary.resolveOpenCodeInboxAttachmentPayloads({
        teamName: 'alpha',
        message: message([attachmentMeta({ mimeType: '' })]),
      })
    ).resolves.toEqual({
      ok: true,
      attachments: [{ ...attachmentMeta({ mimeType: '' }), mimeType: 'text/plain', data: 'bmV3' }],
    });
    expect(nextStore.getAttachments).toHaveBeenCalledWith('alpha', 'msg-1');
  });
});
