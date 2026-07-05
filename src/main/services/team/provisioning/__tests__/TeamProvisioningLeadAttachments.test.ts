import { describe, expect, it } from 'vitest';

import {
  codexImagePartToContentBlock,
  toLeadAttachmentPayloads,
} from '../TeamProvisioningLeadAttachments';

describe('lead attachment helpers', () => {
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
});
