import { resolveAgentAttachmentCapability } from '../../core/domain/capabilities';

import {
  buildOpenCodeAttachmentDeliveryParts,
  redactOpenCodeFilePartsForDiagnostics,
} from './opencodeAttachmentAdapter';

import type { AttachmentPayload } from '@shared/types';

const imageCapability = resolveAgentAttachmentCapability({
  providerId: 'opencode',
  declaredInputModalities: ['image'],
});
const videoCapability = resolveAgentAttachmentCapability({
  providerId: 'opencode',
  declaredInputModalities: ['image', 'video'],
});

function attachment(overrides: Partial<AttachmentPayload> = {}): AttachmentPayload {
  return {
    id: 'att_1',
    filename: 'red.png',
    mimeType: 'image/png',
    size: 3,
    data: Buffer.from([1, 2, 3]).toString('base64'),
    ...overrides,
  };
}

function attachmentWithBytes(
  size: number,
  overrides: Partial<AttachmentPayload> = {}
): AttachmentPayload {
  return attachment({
    size,
    data: Buffer.alloc(size, 1).toString('base64'),
    ...overrides,
  });
}

describe('OpenCode attachment adapter', () => {
  it('keeps text-only messages on the legacy text path', () => {
    expect(
      buildOpenCodeAttachmentDeliveryParts({
        text: 'hello',
        model: 'custom/new-model',
      })
    ).toEqual({
      kind: 'legacy_text',
      text: 'hello',
      fileParts: [],
      diagnostics: [],
    });
  });

  it('serializes declared image input as file parts', () => {
    const result = buildOpenCodeAttachmentDeliveryParts({
      text: 'What color?',
      model: 'custom/new-model',
      capability: imageCapability,
      attachments: [attachment()],
    });

    expect(result.kind).toBe('text_with_file_parts');
    expect(result.fileParts).toEqual([
      {
        type: 'file',
        mime: 'image/png',
        url: `data:image/png;base64,${attachment().data}`,
        filename: 'red.png',
      },
    ]);
    expect(result.diagnostics.join('\n')).not.toContain(attachment().data);
  });

  it('blocks unknown OpenCode model image delivery by default', () => {
    expect(() =>
      buildOpenCodeAttachmentDeliveryParts({
        text: 'What color?',
        model: 'openrouter/example/new-model',
        attachments: [attachment()],
      })
    ).toThrow(/unknown image input support/);
  });

  it('rejects non-image attachments before provider send', () => {
    expect(() =>
      buildOpenCodeAttachmentDeliveryParts({
        text: 'Read PDF',
        model: 'custom/new-model',
        capability: imageCapability,
        attachments: [attachment({ filename: 'a.pdf', mimeType: 'application/pdf' })],
      })
    ).toThrow(/OpenCode currently supports image attachments only/);
  });

  it('serializes video attachments as file parts with declared video input', () => {
    const result = buildOpenCodeAttachmentDeliveryParts({
      text: 'Summarize this clip',
      model: 'custom/new-model',
      capability: videoCapability,
      attachments: [attachment({ filename: 'clip.mp4', mimeType: 'video/mp4' })],
    });

    expect(result.kind).toBe('text_with_file_parts');
    expect(result.fileParts).toEqual([
      {
        type: 'file',
        mime: 'video/mp4',
        url: `data:video/mp4;base64,${attachment().data}`,
        filename: 'clip.mp4',
      },
    ]);
    expect(result.diagnostics.join('\n')).toContain('video file part');
    expect(result.diagnostics.join('\n')).not.toContain(attachment().data);
  });

  it('delivers both image and video parts with declared video input', () => {
    const result = buildOpenCodeAttachmentDeliveryParts({
      text: 'What is happening?',
      model: 'custom/new-model',
      capability: videoCapability,
      attachments: [
        attachment({ filename: 'frame.png', mimeType: 'image/png' }),
        attachment({ filename: 'clip.webm', mimeType: 'video/webm' }),
      ],
    });

    expect(result.fileParts.map((part) => part.mime)).toEqual(['image/png', 'video/webm']);
  });

  it('rejects two videos at the delivery boundary', () => {
    expect(() =>
      buildOpenCodeAttachmentDeliveryParts({
        text: 'Compare these clips',
        model: 'custom/new-model',
        capability: videoCapability,
        attachments: [
          attachment({ id: 'video_1', filename: 'one.mp4', mimeType: 'video/mp4' }),
          attachment({ id: 'video_2', filename: 'two.webm', mimeType: 'video/webm' }),
        ],
      })
    ).toThrow(/Maximum 1 video attachment/);
  });

  it('rejects mixed image and video data above the 8 MiB total budget', () => {
    expect(() =>
      buildOpenCodeAttachmentDeliveryParts({
        text: 'Inspect these',
        model: 'custom/new-model',
        capability: videoCapability,
        attachments: [
          attachmentWithBytes(4 * 1024 * 1024, {
            id: 'image_1',
            filename: 'frame.png',
            mimeType: 'image/png',
          }),
          attachmentWithBytes(4 * 1024 * 1024 + 1, {
            id: 'video_1',
            filename: 'clip.mp4',
            mimeType: 'video/mp4',
          }),
        ],
      })
    ).toThrow(/total byte limit/);
  });

  it('rejects video data above the 8 MiB per-file budget', () => {
    expect(() =>
      buildOpenCodeAttachmentDeliveryParts({
        text: 'Inspect this clip',
        model: 'custom/new-model',
        capability: videoCapability,
        attachments: [
          attachmentWithBytes(8 * 1024 * 1024 + 1, {
            id: 'video_1',
            filename: 'clip.mp4',
            mimeType: 'video/mp4',
          }),
        ],
      })
    ).toThrow(/too large/);
  });

  it('rejects declared attachment size that does not match decoded data', () => {
    expect(() =>
      buildOpenCodeAttachmentDeliveryParts({
        text: 'Inspect this clip',
        model: 'custom/new-model',
        capability: videoCapability,
        attachments: [
          attachment({
            filename: 'clip.mp4',
            mimeType: 'video/mp4',
            size: 4,
          }),
        ],
      })
    ).toThrow(/declared byte size does not match its data/);
  });

  it('rejects malformed base64 attachment data', () => {
    expect(() =>
      buildOpenCodeAttachmentDeliveryParts({
        text: 'Inspect this clip',
        model: 'custom/new-model',
        capability: videoCapability,
        attachments: [
          attachment({
            filename: 'clip.mp4',
            mimeType: 'video/mp4',
            size: 3,
            data: 'not-base64',
          }),
        ],
      })
    ).toThrow(/invalid base64 data/);
  });

  it('enforces the supplied image-only capability for video attachments', () => {
    expect(() =>
      buildOpenCodeAttachmentDeliveryParts({
        text: 'Summarize this clip',
        model: 'custom/new-model',
        capability: imageCapability,
        attachments: [attachment({ filename: 'clip.mp4', mimeType: 'video/mp4' })],
      })
    ).toThrow(/does not declare video input support/);
  });

  it('redacts data URLs from diagnostics', () => {
    const redacted = redactOpenCodeFilePartsForDiagnostics([
      {
        type: 'file',
        mime: 'image/png',
        url: `data:image/png;base64,${attachment().data}`,
        filename: 'red.png',
      },
    ]);

    expect(redacted[0].url).toBe('[redacted data URL: image/png]');
  });
});
