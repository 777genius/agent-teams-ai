import { describe, expect, it, vi } from 'vitest';

import {
  asOpenCodeAttachmentPayload,
  type OpenCodeAttachmentPayloadStore,
  resolveOpenCodeInboxAttachmentPayloads,
} from '../TeamProvisioningOpenCodeAttachmentPayloads';

import type { AttachmentMeta, AttachmentPayload, InboxMessage } from '@shared/types';

const ISO = '2026-01-01T00:00:00.000Z';

function meta(overrides: Partial<AttachmentMeta> = {}): AttachmentMeta {
  return {
    id: 'att-1',
    filename: 'image.png',
    mimeType: 'image/png',
    size: 4,
    ...overrides,
  };
}

function message(attachments?: AttachmentMeta[]): InboxMessage & { messageId: string } {
  return {
    from: 'user',
    to: 'alice',
    text: 'see attachment',
    timestamp: ISO,
    read: false,
    messageId: 'msg-1',
    attachments,
  };
}

describe('OpenCode attachment payload helpers', () => {
  it('returns no attachments when the inbox message has no attachment metadata', async () => {
    const store: OpenCodeAttachmentPayloadStore = {
      getAttachments: vi.fn(),
    };

    await expect(
      resolveOpenCodeInboxAttachmentPayloads(
        { teamName: 'team', message: message() },
        { attachmentStore: store }
      )
    ).resolves.toEqual({ ok: true });
    expect(store.getAttachments).not.toHaveBeenCalled();
  });

  it('uses inline attachment payload data without reading the attachment store', async () => {
    const inline = {
      ...meta(),
      data: 'aW1n',
    } satisfies AttachmentPayload;
    const store: OpenCodeAttachmentPayloadStore = {
      getAttachments: vi.fn(),
    };

    expect(asOpenCodeAttachmentPayload(inline)).toEqual(inline);
    await expect(
      resolveOpenCodeInboxAttachmentPayloads(
        { teamName: 'team', message: message([inline]) },
        { attachmentStore: store }
      )
    ).resolves.toEqual({ ok: true, attachments: [inline] });
    expect(store.getAttachments).not.toHaveBeenCalled();
  });

  it('hydrates file-backed attachment payloads from the attachment store', async () => {
    const store: OpenCodeAttachmentPayloadStore = {
      getAttachments: vi.fn(async () => [
        { id: 'att-1', data: 'aW1n', mimeType: 'image/png' },
        { id: 'att-2', data: 'dHh0', mimeType: 'text/plain' },
      ]),
    };

    await expect(
      resolveOpenCodeInboxAttachmentPayloads(
        {
          teamName: 'team',
          message: message([
            meta({ id: 'att-1', mimeType: '' }),
            meta({ id: 'att-2', filename: 'note.txt', mimeType: 'text/plain' }),
          ]),
        },
        { attachmentStore: store }
      )
    ).resolves.toEqual({
      ok: true,
      attachments: [
        { ...meta({ id: 'att-1', mimeType: '' }), mimeType: 'image/png', data: 'aW1n' },
        { ...meta({ id: 'att-2', filename: 'note.txt', mimeType: 'text/plain' }), data: 'dHh0' },
      ],
    });
    expect(store.getAttachments).toHaveBeenCalledTimes(1);
    expect(store.getAttachments).toHaveBeenCalledWith('team', 'msg-1');
  });

  it('reports unavailable attachment ids', async () => {
    const store: OpenCodeAttachmentPayloadStore = {
      getAttachments: vi.fn(async () => [{ id: 'att-1', data: 'aW1n', mimeType: 'image/png' }]),
    };

    await expect(
      resolveOpenCodeInboxAttachmentPayloads(
        {
          teamName: 'team',
          message: message([meta({ id: 'att-1' }), meta({ id: 'missing' })]),
        },
        { attachmentStore: store }
      )
    ).resolves.toEqual({
      ok: false,
      reason: 'opencode_inbox_attachment_payload_unavailable: missing',
      diagnostics: ['opencode_inbox_attachment_payload_unavailable: missing'],
    });
  });

  it('reports attachment store read failures', async () => {
    const store: OpenCodeAttachmentPayloadStore = {
      getAttachments: vi.fn(async () => {
        throw new Error('disk unavailable');
      }),
    };

    await expect(
      resolveOpenCodeInboxAttachmentPayloads(
        { teamName: 'team', message: message([meta()]) },
        { attachmentStore: store }
      )
    ).resolves.toEqual({
      ok: false,
      reason: 'opencode_inbox_attachment_payload_read_failed: disk unavailable',
      diagnostics: ['opencode_inbox_attachment_payload_read_failed: disk unavailable'],
    });
  });
});
