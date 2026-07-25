import {
  estimateTaskAttachmentDecodedBytes,
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
});
