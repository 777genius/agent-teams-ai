import {
  buildClaudeAttachmentDeliveryParts,
  buildCodexNativeAttachmentDeliveryParts,
} from '@features/agent-attachments/main';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildLeadMessageStdinPayload,
  codexImagePartToContentBlock,
  toLeadAttachmentPayloads,
} from '../TeamProvisioningLeadAttachments';

import type { AttachmentPayload } from '@shared/types';

vi.mock('@features/agent-attachments/main', () => ({
  buildClaudeAttachmentDeliveryParts: vi.fn(
    (input: { text: string; attachments?: AttachmentPayload[] }) => ({
      kind: (input.attachments?.length ?? 0) > 0 ? 'structured_blocks' : 'legacy_text',
      blocks: [{ type: 'text', text: input.text }],
    })
  ),
  buildCodexNativeAttachmentDeliveryParts: vi.fn(
    async (input: { text: string; attachments?: AttachmentPayload[] }) => ({
      kind: (input.attachments?.length ?? 0) > 0 ? 'text_with_images' : 'legacy_text',
      promptText: input.text,
      imageParts: [
        {
          kind: 'codex-image-arg',
          attachmentId: 'lead_att_1',
          filename: 'img.png',
          mimeType: 'image/png',
          path: '/fake/prepared-image.png',
          sizeBytes: 3,
        },
      ],
      diagnostics: [],
    })
  ),
}));

describe('lead attachment helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('converts lead attachment inputs into payloads with stable ids and byte sizes', () => {
    expect(
      toLeadAttachmentPayloads([
        {
          data: Buffer.from('img').toString('base64'),
          mimeType: 'image/png',
          filename: ' img.png ',
        },
        { data: Buffer.from('text').toString('base64'), mimeType: 'text/plain' },
      ])
    ).toEqual([
      {
        id: 'lead_att_1',
        filename: 'img.png',
        mimeType: 'image/png',
        size: 3,
        data: 'aW1n',
      },
      {
        id: 'lead_att_2',
        filename: 'attachment-2',
        mimeType: 'text/plain',
        size: 4,
        data: 'dGV4dA==',
      },
    ]);
  });

  it('maps Codex native image parts into content blocks', () => {
    expect(
      codexImagePartToContentBlock({
        path: '/fake/image.png',
        mimeType: 'image/png',
      })
    ).toEqual({
      type: 'image',
      source: {
        type: 'file',
        path: '/fake/image.png',
        media_type: 'image/png',
      },
    });
  });

  it('builds the legacy stream-json user payload through the Claude-compatible path', async () => {
    await expect(
      buildLeadMessageStdinPayload({
        teamName: 'Team',
        runId: 'run-1',
        providerId: 'codex',
        text: 'hello',
        attachments: [],
      })
    ).resolves.toBe(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
        },
      })
    );

    expect(buildClaudeAttachmentDeliveryParts).toHaveBeenCalledWith({
      text: 'hello',
      attachments: [],
    });
    expect(buildCodexNativeAttachmentDeliveryParts).not.toHaveBeenCalled();
  });

  it('uses the Claude attachment block fallback for non-Codex providers with attachments', async () => {
    const attachments = toLeadAttachmentPayloads([
      { data: Buffer.from('img').toString('base64'), mimeType: 'image/png', filename: 'img.png' },
    ]);

    await buildLeadMessageStdinPayload({
      teamName: 'Team',
      runId: 'run-1',
      providerId: 'anthropic',
      text: 'hello',
      attachments,
    });

    expect(buildClaudeAttachmentDeliveryParts).toHaveBeenCalledWith({
      text: 'hello',
      attachments,
    });
    expect(buildCodexNativeAttachmentDeliveryParts).not.toHaveBeenCalled();
  });

  it('uses Codex native image blocks only for Codex providers with attachments', async () => {
    const attachments = toLeadAttachmentPayloads([
      { data: Buffer.from('img').toString('base64'), mimeType: 'image/png', filename: 'img.png' },
    ]);

    await expect(
      buildLeadMessageStdinPayload({
        teamName: 'Team',
        runId: 'run-1',
        providerId: 'codex',
        text: 'hello',
        attachments,
      })
    ).resolves.toBe(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            {
              type: 'image',
              source: {
                type: 'file',
                path: '/fake/prepared-image.png',
                media_type: 'image/png',
              },
            },
          ],
        },
      })
    );

    expect(buildCodexNativeAttachmentDeliveryParts).toHaveBeenCalledWith({
      teamName: 'Team',
      messageId: expect.stringMatching(/^lead_run-1_[0-9a-f]{64}$/),
      text: 'hello',
      attachments,
    });
    expect(buildClaudeAttachmentDeliveryParts).not.toHaveBeenCalled();
  });

  it('reuses the Codex artifact identity for a persisted retry but separates compose identities', async () => {
    const attachments = toLeadAttachmentPayloads([
      { data: Buffer.from('img').toString('base64'), mimeType: 'image/png', filename: 'img.png' },
    ]);
    const codexMock = vi.mocked(buildCodexNativeAttachmentDeliveryParts);

    await buildLeadMessageStdinPayload({
      teamName: 'Team',
      runId: 'run-1',
      providerId: 'codex',
      text: 'hello',
      attachments,
    });
    const firstId = codexMock.mock.calls[0]?.[0]?.messageId;

    // A runtime retry re-delivers the SAME persisted attachments (stable ids).
    codexMock.mockClear();
    await buildLeadMessageStdinPayload({
      teamName: 'Team',
      runId: 'run-1',
      providerId: 'codex',
      text: 'hello',
      attachments,
    });
    const retryId = codexMock.mock.calls[0]?.[0]?.messageId;

    expect(firstId).toMatch(/^lead_run-1_[0-9a-f]{64}$/);
    expect(retryId).toBe(firstId);

    // A different compose (distinct attachment ids) resolves to a different dir.
    codexMock.mockClear();
    const otherAttachments: AttachmentPayload[] = [
      {
        id: 'different-uuid',
        filename: 'img.png',
        mimeType: 'image/png',
        size: 3,
        data: Buffer.from('img').toString('base64'),
      },
    ];
    await buildLeadMessageStdinPayload({
      teamName: 'Team',
      runId: 'run-1',
      providerId: 'codex',
      text: 'hello',
      attachments: otherAttachments,
    });
    expect(codexMock.mock.calls[0]?.[0]?.messageId).not.toBe(firstId);
  });

  it('derives different Codex artifact identities for different ordered payloads', async () => {
    const codexMock = vi.mocked(buildCodexNativeAttachmentDeliveryParts);
    const firstInputs = [
      { data: Buffer.from('first').toString('base64'), mimeType: 'image/png', filename: 'img.png' },
      {
        data: Buffer.from('second').toString('base64'),
        mimeType: 'text/plain',
        filename: 'note.txt',
      },
    ];
    const secondInputs = [...firstInputs].reverse();

    await buildLeadMessageStdinPayload({
      teamName: 'Team',
      runId: 'run-1',
      providerId: 'codex',
      text: 'hello',
      attachments: toLeadAttachmentPayloads(firstInputs),
    });
    const firstId = codexMock.mock.calls[0]?.[0]?.messageId;

    codexMock.mockClear();
    await buildLeadMessageStdinPayload({
      teamName: 'Team',
      runId: 'run-1',
      providerId: 'codex',
      text: 'hello',
      attachments: toLeadAttachmentPayloads(secondInputs),
    });
    const secondId = codexMock.mock.calls[0]?.[0]?.messageId;

    expect(firstId).toMatch(/^lead_run-1_[0-9a-f]{64}$/);
    expect(secondId).toMatch(/^lead_run-1_[0-9a-f]{64}$/);
    expect(secondId).not.toBe(firstId);
  });
});
