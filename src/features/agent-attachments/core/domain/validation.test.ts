import { resolveAgentAttachmentCapability } from './capabilities';
import {
  classifyAttachmentMime,
  validateAttachmentBatchForCapability,
  validateAttachmentForCapability,
  validateImageOptimizationInput,
} from './validation';

import type { AgentAttachmentPayload } from './types';

function fakeImageAttachment(
  overrides: Partial<AgentAttachmentPayload> = {}
): AgentAttachmentPayload {
  return {
    schemaVersion: 1,
    id: 'att_1',
    originalName: 'red-square.png',
    mimeType: 'image/png',
    sizeBytes: 1024,
    kind: 'image',
    source: 'composer',
    order: 1,
    storage: { originalArtifactId: 'art_original_1', optimizedArtifactId: 'art_optimized_1' },
    image: { width: 64, height: 64, optimizedWidth: 64, optimizedHeight: 64, optimization: 'none' },
    warnings: [],
    ...overrides,
  };
}

describe('agent attachment validation', () => {
  it('accepts a small png optimization input', () => {
    expect(
      validateImageOptimizationInput({
        mimeType: 'image/png',
        sizeBytes: 1000,
        width: 64,
        height: 64,
      })
    ).toEqual({ ok: true, warnings: [] });
  });

  it('rejects unsupported image optimization input', () => {
    const result = validateImageOptimizationInput({
      mimeType: 'image/gif',
      sizeBytes: 1000,
      width: 64,
      height: 64,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('attachment_type_unsupported');
  });

  it('allows Claude text file delivery through document blocks', () => {
    const capability = resolveAgentAttachmentCapability({
      providerId: 'anthropic',
      model: 'claude-haiku-4-5',
    });
    const result = validateAttachmentForCapability({
      attachment: fakeImageAttachment({
        id: 'att_text',
        originalName: 'notes.md',
        mimeType: 'text/markdown',
        sizeBytes: 128,
        kind: 'file',
      }),
      capability,
    });

    expect(result).toEqual({ ok: true, warnings: [] });
  });

  it('allows Claude GIF image delivery without requiring optimization support', () => {
    const capability = resolveAgentAttachmentCapability({
      providerId: 'anthropic',
      model: 'claude-haiku-4-5',
    });
    const result = validateAttachmentForCapability({
      attachment: fakeImageAttachment({
        id: 'att_gif',
        originalName: 'clip.gif',
        mimeType: 'image/gif',
      }),
      capability,
    });

    expect(result).toEqual({ ok: true, warnings: [] });
  });

  it('blocks GIF images for Codex native delivery', () => {
    const capability = resolveAgentAttachmentCapability({
      providerId: 'codex',
      model: 'gpt-5.4-mini',
    });
    const result = validateAttachmentForCapability({
      attachment: fakeImageAttachment({
        id: 'att_gif',
        originalName: 'clip.gif',
        mimeType: 'image/gif',
      }),
      capability,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('attachment_type_unsupported');
      expect(result.message).toContain('image type');
    }
  });

  it('blocks non-image files for Codex native delivery', () => {
    const capability = resolveAgentAttachmentCapability({
      providerId: 'codex',
      model: 'gpt-5.4-mini',
    });
    const result = validateAttachmentForCapability({
      attachment: fakeImageAttachment({
        id: 'att_pdf',
        originalName: 'spec.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        kind: 'file',
      }),
      capability,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('attachment_type_unsupported');
      expect(result.message).toContain('image attachments only');
    }
  });

  it('blocks non-image files for OpenCode even when the model supports images', () => {
    const capability = resolveAgentAttachmentCapability({
      providerId: 'opencode',
      declaredInputModalities: ['image'],
    });
    const result = validateAttachmentForCapability({
      attachment: fakeImageAttachment({
        id: 'att_text',
        originalName: 'trace.txt',
        mimeType: 'text/plain',
        sizeBytes: 1024,
        kind: 'file',
      }),
      capability,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('attachment_type_unsupported');
      expect(result.message).toContain('non-image file attachments');
    }
  });

  it('classifies known video MIME types as video and leaves lookalike source files unsupported', () => {
    expect(classifyAttachmentMime('video/mp4')).toBe('video');
    expect(classifyAttachmentMime('video/webm')).toBe('video');
    expect(classifyAttachmentMime('video/quicktime')).toBe('video');
    // Browsers report the `.ts` TypeScript extension as `video/mp2t`; it must
    // stay a non-video attachment so it is not routed as a video part.
    expect(classifyAttachmentMime('video/mp2t')).toBe('unsupported');
  });

  it('allows video delivery for declared OpenCode video input', () => {
    const capability = resolveAgentAttachmentCapability({
      providerId: 'opencode',
      declaredInputModalities: ['image', 'video'],
    });
    expect(capability.supportsVideo).toBe(true);
    const result = validateAttachmentForCapability({
      attachment: fakeImageAttachment({
        id: 'att_video',
        originalName: 'clip.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 2048,
        kind: 'video',
        image: undefined,
      }),
      capability,
    });

    expect(result).toEqual({ ok: true, warnings: [] });
  });

  it('rejects video delivery for OpenCode models that only support images', () => {
    const capability = resolveAgentAttachmentCapability({
      providerId: 'opencode',
      declaredInputModalities: ['image'],
    });
    expect(capability.supportsVideo).toBe(false);
    const result = validateAttachmentForCapability({
      attachment: fakeImageAttachment({
        id: 'att_video',
        originalName: 'clip.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 2048,
        kind: 'video',
        image: undefined,
      }),
      capability,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('attachment_type_unsupported');
    }
  });

  it('rejects videos that exceed the per-video byte budget', () => {
    const capability = resolveAgentAttachmentCapability({
      providerId: 'opencode',
      declaredInputModalities: ['image', 'video'],
    });
    const result = validateAttachmentForCapability({
      attachment: fakeImageAttachment({
        id: 'att_video',
        originalName: 'clip.mp4',
        mimeType: 'video/mp4',
        sizeBytes: capability.maxBytesPerVideo + 1,
        kind: 'video',
        image: undefined,
      }),
      capability,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('attachment_too_large');
    }
  });

  it('uses an 8 MiB per-video and mixed attachment budget', () => {
    const capability = resolveAgentAttachmentCapability({
      providerId: 'opencode',
      declaredInputModalities: ['image', 'video'],
    });

    expect(capability.maxBytesPerVideo).toBe(8 * 1024 * 1024);
    expect(capability.maxBytesTotal).toBe(8 * 1024 * 1024);
  });

  it('rejects more videos than the capability allows', () => {
    const capability = resolveAgentAttachmentCapability({
      providerId: 'opencode',
      declaredInputModalities: ['image', 'video'],
    });
    const result = validateAttachmentBatchForCapability({
      capability,
      attachments: [
        { kind: 'video', mimeType: 'video/mp4', sizeBytes: 1 },
        { kind: 'video', mimeType: 'video/webm', sizeBytes: 1 },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('attachment_type_unsupported');
      expect(result.message).toContain('Maximum 1 video attachment');
    }
  });

  it('preserves batch warnings when a later attachment fails validation', () => {
    const capability = resolveAgentAttachmentCapability({
      providerId: 'opencode',
      declaredInputModalities: ['image', 'video'],
    });
    const warning = {
      code: 'image_was_resized' as const,
      message: 'Image was resized before delivery.',
      attachmentId: 'image_1',
    };
    const result = validateAttachmentBatchForCapability({
      capability,
      attachments: [
        {
          kind: 'image',
          mimeType: 'image/png',
          sizeBytes: 1,
          warnings: [warning],
        },
        {
          kind: 'file',
          mimeType: 'text/plain',
          sizeBytes: 1,
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.warnings).toEqual([warning]);
  });

  it('rejects mixed image and video bytes above the total capability budget', () => {
    const capability = resolveAgentAttachmentCapability({
      providerId: 'opencode',
      declaredInputModalities: ['image', 'video'],
    });
    const result = validateAttachmentBatchForCapability({
      capability,
      attachments: [
        { kind: 'image', mimeType: 'image/png', sizeBytes: 4 * 1024 * 1024 },
        { kind: 'video', mimeType: 'video/mp4', sizeBytes: 4 * 1024 * 1024 + 1 },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('attachment_too_large');
      expect(result.message).toContain('total byte limit');
    }
  });
});
