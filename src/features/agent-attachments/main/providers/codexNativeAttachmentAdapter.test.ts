import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  buildCodexNativeAttachmentDeliveryParts,
  redactCodexNativeAttachmentPartsForDiagnostics,
} from './codexNativeAttachmentAdapter';

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

describe('Codex native attachment adapter', () => {
  it('keeps text-only messages on the legacy text path', async () => {
    await expect(
      buildCodexNativeAttachmentDeliveryParts({
        teamName: 'team_1',
        messageId: 'msg_1',
        text: 'hello',
      })
    ).resolves.toEqual({
      kind: 'legacy_text',
      promptText: 'hello',
      imageParts: [],
      diagnostics: [],
    });
  });

  it('materializes image attachments as managed files for --image args', async () => {
    const appDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-attachments-'));
    const result = await buildCodexNativeAttachmentDeliveryParts({
      appDataPath,
      teamName: 'team_1',
      messageId: 'msg_1',
      text: 'What color?',
      attachments: [attachment()],
    });

    expect(result.kind).toBe('text_with_images');
    expect(result.imageParts).toHaveLength(1);
    expect(result.imageParts[0]).toMatchObject({
      kind: 'codex-image-arg',
      attachmentId: 'att_1',
      filename: 'red.png',
      mimeType: 'image/png',
      sizeBytes: 3,
    });
    await expect(fs.readFile(result.imageParts[0].path)).resolves.toEqual(Buffer.from([1, 2, 3]));
    expect(result.diagnostics.join('\n')).not.toContain(attachment().data);
  });

  it('preserves image order for multiple attachments', async () => {
    const appDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-attachments-'));
    const result = await buildCodexNativeAttachmentDeliveryParts({
      appDataPath,
      teamName: 'team_1',
      messageId: 'msg_1',
      text: 'Compare',
      attachments: [
        attachment({ id: 'att_1', filename: 'a.jpg', mimeType: 'image/jpeg' }),
        attachment({ id: 'att_2', filename: 'b.webp', mimeType: 'image/webp' }),
      ],
    });

    expect(result.imageParts.map((part) => part.filename)).toEqual(['a.jpg', 'b.webp']);
    expect(result.imageParts.map((part) => part.mimeType)).toEqual(['image/jpeg', 'image/webp']);
  });

  it('rejects non-image attachments before provider send', async () => {
    await expect(
      buildCodexNativeAttachmentDeliveryParts({
        teamName: 'team_1',
        messageId: 'msg_1',
        text: 'Read PDF',
        attachments: [attachment({ filename: 'a.pdf', mimeType: 'application/pdf' })],
      })
    ).rejects.toThrow(/Codex native supports image attachments only/);
  });

  it('redacts managed artifact paths from diagnostics', () => {
    const redacted = redactCodexNativeAttachmentPartsForDiagnostics([
      {
        kind: 'codex-image-arg',
        attachmentId: 'att_1',
        filename: 'red.png',
        mimeType: 'image/png',
        path: '/Users/me/.claude/attachments/team/msg/att/optimized.png',
        sizeBytes: 3,
      },
    ]);

    expect(redacted[0].path).toBe('[managed attachment artifact: red.png]');
  });
});
