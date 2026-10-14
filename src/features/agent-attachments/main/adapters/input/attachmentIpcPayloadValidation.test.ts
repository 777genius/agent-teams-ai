import { MAX_TEXT_LENGTH } from '@shared/constants/teamLimits';

import { MAX_AGENT_ATTACHMENT_DELIVERY_BYTES_TOTAL } from '../../../core/domain';

import {
  validateAgentAttachmentIpcPayload,
  validateAgentAttachmentSerializedIpcPayload,
} from './attachmentIpcPayloadValidation';

describe('attachment IPC payload validation', () => {
  it('accepts a full-size video with a maximum-length multibyte message', () => {
    const result = validateAgentAttachmentSerializedIpcPayload({
      text: 'é'.repeat(MAX_TEXT_LENGTH),
      nativeVideoDelivery: true,
      attachments: [
        {
          id: 'video_1',
          filename: 'clip.mp4',
          mimeType: 'video/mp4',
          size: MAX_AGENT_ATTACHMENT_DELIVERY_BYTES_TOTAL,
          data: Buffer.alloc(MAX_AGENT_ATTACHMENT_DELIVERY_BYTES_TOTAL).toString('base64'),
        },
      ],
    });

    expect(result).toEqual({ valid: true });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    'rejects an invalid declared attachment size of %s',
    (size) => {
      expect(
        validateAgentAttachmentIpcPayload([
          {
            id: 'video_1',
            filename: 'clip.mp4',
            mimeType: 'video/mp4',
            size,
            data: Buffer.from('test').toString('base64'),
          },
        ])
      ).toEqual({
        valid: false,
        error: 'Attachment must have a positive size',
      });
    }
  );
});

describe('ordinary message byte admission', () => {
  const entry = {
    id: 'file-1',
    filename: 'data.bin',
    mimeType: 'application/octet-stream',
    size: 1,
    data: '/w==',
  };
  it('accepts exact arbitrary bytes and strips caller-owned metadata', () => {
    expect(
      validateAgentAttachmentIpcPayload([
        { ...entry, filePath: '/forged', sha256: 'forged', order: 7 },
      ])
    ).toEqual({ valid: true, value: [entry] });
  });
  it.each([
    [{ ...entry, data: '/x==' }],
    [{ ...entry, size: 2 }],
    [entry, entry],
    [{ ...entry, id: '../escape' }],
    [{ ...entry, mimeType: 'x\nheader' }],
  ])('rejects invalid byte claims or storage metadata', (...attachments) => {
    expect(validateAgentAttachmentIpcPayload(attachments).valid).toBe(false);
  });
});

it('does not grant the native video encoded budget to an ordinary reference', () => {
  expect(
    validateAgentAttachmentSerializedIpcPayload({
      text: 'Read this video file',
      attachments: [
        {
          id: 'video',
          filename: 'clip.mp4',
          mimeType: 'video/mp4',
          size: 8 * 1024 * 1024,
          data: Buffer.alloc(8 * 1024 * 1024).toString('base64'),
        },
      ],
    }).valid
  ).toBe(false);
});
