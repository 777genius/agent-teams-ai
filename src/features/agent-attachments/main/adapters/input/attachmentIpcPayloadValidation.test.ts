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
