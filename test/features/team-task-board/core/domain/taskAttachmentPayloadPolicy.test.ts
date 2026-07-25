import {
  estimateTaskAttachmentDecodedBytes,
  isCanonicalTaskAttachmentBase64,
  isCanonicalTaskAttachmentId,
  TEAM_TASK_ATTACHMENT_MAX_BASE64_LENGTH,
  TEAM_TASK_ATTACHMENT_MAX_DECODED_BYTES,
} from '@features/team-task-board';
import { describe, expect, it } from 'vitest';

describe('task attachment payload policy', () => {
  it('derives the encoded boundary from the canonical decoded byte limit', () => {
    expect(TEAM_TASK_ATTACHMENT_MAX_DECODED_BYTES).toBe(20 * 1024 * 1024);
    expect(TEAM_TASK_ATTACHMENT_MAX_BASE64_LENGTH).toBe(
      Math.ceil(TEAM_TASK_ATTACHMENT_MAX_DECODED_BYTES / 3) * 4
    );
  });

  it.each([
    ['YQ==', 1],
    ['YWI=', 2],
    ['YWJj', 3],
    ['  YWJj  ', 3],
  ])('estimates decoded bytes for %s', (base64Data, expectedBytes) => {
    expect(estimateTaskAttachmentDecodedBytes(base64Data)).toBe(expectedBytes);
  });

  it.each(['11111111-1111-4111-8111-111111111111', '018f47a2-7b3c-7123-8abc-1234567890ab'])(
    'accepts canonical attachment UUID %s',
    (attachmentId) => {
      expect(isCanonicalTaskAttachmentId(attachmentId)).toBe(true);
    }
  );

  it.each([
    'attachment-1',
    '11111111-1111-4111-8111-11111111111',
    '11111111-1111-4111-c111-111111111111',
    '11111111-1111-4111-8111-11111111111Z',
    '11111111-1111-4111-8111-111111111111 ',
  ])('rejects non-canonical attachment UUID %s', (attachmentId) => {
    expect(isCanonicalTaskAttachmentId(attachmentId)).toBe(false);
  });

  it.each(['YQ==', 'YWI=', 'YWJj', '////', 'AAAA'])('accepts canonical base64 %s', (base64Data) => {
    expect(isCanonicalTaskAttachmentBase64(base64Data)).toBe(true);
  });

  it.each(['', '!!!!', 'A', 'YQ', 'YQ==junk', 'AA=A', 'YR==', 'YWJ=', ' YQ==', 'YQ== '])(
    'rejects non-canonical base64 %s',
    (base64Data) => {
      expect(isCanonicalTaskAttachmentBase64(base64Data)).toBe(false);
    }
  );

  it('keeps the exact decoded boundary and rejects the next byte', () => {
    const exactBoundary = Buffer.alloc(TEAM_TASK_ATTACHMENT_MAX_DECODED_BYTES).toString('base64');
    const oneByteOver = Buffer.alloc(TEAM_TASK_ATTACHMENT_MAX_DECODED_BYTES + 1).toString('base64');

    expect(exactBoundary).toHaveLength(TEAM_TASK_ATTACHMENT_MAX_BASE64_LENGTH);
    expect(isCanonicalTaskAttachmentBase64(exactBoundary)).toBe(true);
    expect(estimateTaskAttachmentDecodedBytes(exactBoundary)).toBe(
      TEAM_TASK_ATTACHMENT_MAX_DECODED_BYTES
    );
    expect(isCanonicalTaskAttachmentBase64(oneByteOver)).toBe(true);
    expect(estimateTaskAttachmentDecodedBytes(oneByteOver)).toBe(
      TEAM_TASK_ATTACHMENT_MAX_DECODED_BYTES + 1
    );
  });
});
