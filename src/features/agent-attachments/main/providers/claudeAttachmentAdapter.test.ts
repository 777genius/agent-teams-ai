import {
  buildClaudeAttachmentDeliveryParts,
  redactClaudeBlocksForDiagnostics,
} from './claudeAttachmentAdapter';

import type { AttachmentPayload } from '@shared/types';

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

describe('Claude attachment adapter', () => {
  it('keeps text-only messages on the legacy text path', () => {
    expect(buildClaudeAttachmentDeliveryParts({ text: 'hello' })).toEqual({
      kind: 'legacy_text',
      blocks: [{ type: 'text', text: 'hello' }],
    });
  });

  it('serializes png images as structured image blocks', () => {
    const result = buildClaudeAttachmentDeliveryParts({
      text: 'What color?',
      attachments: [attachment()],
    });

    expect(result.kind).toBe('structured_blocks');
    expect(result.blocks[0]).toEqual({ type: 'text', text: 'What color?' });
    expect(result.blocks[1]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png' },
    });
  });

  it('serializes UTF-8 text files as text document blocks', () => {
    const result = buildClaudeAttachmentDeliveryParts({
      text: 'Read this',
      attachments: [
        attachment({
          filename: 'note.txt',
          mimeType: 'text/plain',
          data: Buffer.from('hello', 'utf8').toString('base64'),
        }),
      ],
    });

    expect(result.blocks[1]).toEqual({
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: 'hello' },
      title: 'note.txt',
    });
  });

  it('rejects unsupported image mime types before provider send', () => {
    expect(() =>
      buildClaudeAttachmentDeliveryParts({
        text: 'see gif',
        attachments: [attachment({ mimeType: 'image/gif' })],
      })
    ).toThrow(/Claude image MIME unsupported/);
  });

  it('redacts image and document bytes in diagnostics', () => {
    const result = buildClaudeAttachmentDeliveryParts({
      text: 'What color?',
      attachments: [
        attachment(),
        attachment({ id: 'att_2', filename: 'a.pdf', mimeType: 'application/pdf' }),
      ],
    });

    const redacted = redactClaudeBlocksForDiagnostics(result.blocks);
    expect(JSON.stringify(redacted)).not.toContain(attachment().data);
    expect(JSON.stringify(redacted)).toContain('[redacted image bytes: image/png]');
    expect(JSON.stringify(redacted)).toContain('[redacted document bytes: application/pdf]');
  });
});
