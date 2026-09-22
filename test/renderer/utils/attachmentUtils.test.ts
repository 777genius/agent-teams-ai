import { describe, expect, it } from 'vitest';

import {
  categorizeFile,
  fileToAgentAttachmentPayload,
  MAX_VIDEO_FILE_SIZE,
  validateAttachment,
  validateOptimizedImageTotal,
} from '../../../src/renderer/utils/attachmentUtils';

import type { AttachmentPayload } from '../../../src/shared/types';

function file(name: string, type: string, bytes = 12): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function payload(overrides: Partial<AttachmentPayload>): AttachmentPayload {
  return {
    id: 'att-1',
    filename: 'clip.mp4',
    mimeType: 'video/mp4',
    size: 12,
    data: 'dmlkZW8=',
    ...overrides,
  };
}

describe('attachmentUtils video wiring', () => {
  it.each([
    ['clip.mp4', 'video/mp4'],
    ['clip.webm', 'video/webm'],
    ['clip.mov', 'video/quicktime'],
  ])('categorizes and serializes %s as a video payload', async (filename, mimeType) => {
    const video = file(filename, mimeType, 4);

    expect(categorizeFile(video)).toBe('video');
    await expect(fileToAgentAttachmentPayload(video)).resolves.toMatchObject({
      filename,
      mimeType,
      size: 4,
      data: 'AAAAAA==',
    });
  });

  it('normalizes video MIME from the extension when the browser leaves it empty', async () => {
    await expect(fileToAgentAttachmentPayload(file('clip.mov', '', 4))).resolves.toMatchObject({
      mimeType: 'video/quicktime',
    });
  });

  it('keeps .ts files reported as video/mp2t categorized and serialized as text', async () => {
    const source = file('worker.ts', 'video/mp2t', 4);

    expect(categorizeFile(source)).toBe('text');
    await expect(fileToAgentAttachmentPayload(source)).resolves.toMatchObject({
      mimeType: 'text/plain',
    });
  });

  it('enforces the 8MiB video input limit', () => {
    expect(validateAttachment(file('clip.mp4', 'video/mp4', MAX_VIDEO_FILE_SIZE))).toEqual({
      valid: true,
    });
    expect(validateAttachment(file('clip.mp4', 'video/mp4', MAX_VIDEO_FILE_SIZE + 1))).toEqual({
      valid: false,
      error: 'File "clip.mp4" exceeds 8MB limit',
    });
  });

  it('enforces one video and an 8MiB mixed payload total', () => {
    expect(
      validateOptimizedImageTotal([
        payload({}),
        payload({ id: 'att-2', filename: 'second.webm', mimeType: 'video/webm' }),
      ])
    ).toEqual({ valid: false, error: 'Maximum 1 video attachment allowed' });

    expect(
      validateOptimizedImageTotal([
        payload({ size: MAX_VIDEO_FILE_SIZE - 4 }),
        payload({
          id: 'att-2',
          filename: 'diagram.png',
          mimeType: 'image/png',
          size: 8,
        }),
      ])
    ).toEqual({
      valid: false,
      error: 'Video and other attachments exceed the 8MB total size limit',
    });
  });
});
