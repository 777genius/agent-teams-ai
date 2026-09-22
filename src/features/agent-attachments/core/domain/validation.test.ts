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

  it('blocks known non-vision OpenCode models', () => {
    const capability = resolveAgentAttachmentCapability({
      providerId: 'opencode',
      model: 'openrouter/z-ai/glm-5.1',
    });
    const result = validateAttachmentForCapability({
      attachment: fakeImageAttachment(),
      capability,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('attachment_model_unsupported');
  });

  it.each([
    'openrouter/moonshotai/kimi-k2.6',
    'kimi-for-coding/kimi-for-coding',
    'kimi-for-coding/kimi-for-coding-highspeed',
    'kimi-for-coding/k3',
    'zai-coding-plan/glm-5v-turbo',
    'minimax-coding-plan/MiniMax-M3',
    'xai/grok-4.5',
    'xai/grok-4.3',
    'xai/grok-4.20-0309-reasoning',
    'xai/grok-4.20-0309-non-reasoning',
    'xai/grok-build-0.1',
    'github-copilot/gpt-5-mini',
    'github-copilot/gpt-5.3-codex',
    'github-copilot/gpt-5.4',
    'github-copilot/gpt-5.4-mini',
    'github-copilot/gpt-5.5',
    'github-copilot/gpt-5.6-luna',
    'github-copilot/gpt-5.6-sol',
    'github-copilot/gpt-5.6-terra',
    'github-copilot/claude-fable-5',
    'github-copilot/claude-haiku-4.5',
    'github-copilot/claude-opus-4.5',
    'github-copilot/claude-opus-4.6',
    'github-copilot/claude-opus-4.7',
    'github-copilot/claude-opus-4.8',
    'github-copilot/claude-sonnet-4.5',
    'github-copilot/claude-sonnet-4.6',
    'github-copilot/claude-sonnet-5',
    'github-copilot/gemini-2.5-pro',
    'github-copilot/gemini-3-flash-preview',
    'github-copilot/gemini-3.1-pro-preview',
    'github-copilot/gemini-3.5-flash',
    'github-copilot/kimi-k2.7-code',
    'xiaomi-token-plan-ams/mimo-v2.5',
    'xiaomi-token-plan-sgp/mimo-v2.5',
    'xiaomi-token-plan-cn/mimo-v2.5',
  ])('allows verified OpenCode subscription model %s', (model) => {
    const capability = resolveAgentAttachmentCapability({
      providerId: 'opencode',
      model,
    });
    expect(
      validateAttachmentForCapability({ attachment: fakeImageAttachment(), capability })
    ).toEqual({
      ok: true,
      warnings: [],
    });
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
      model: 'openrouter/moonshotai/kimi-k2.6',
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
      expect(result.message).toContain('image attachments only');
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

  it('allows video delivery for the OpenCode model verified for video attachments', () => {
    const capability = resolveAgentAttachmentCapability({
      providerId: 'opencode',
      model: 'minimax-coding-plan/MiniMax-M3',
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
      model: 'openrouter/moonshotai/kimi-k2.6',
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

  it('rejects videos that exceed the verified per-video byte budget', () => {
    const capability = resolveAgentAttachmentCapability({
      providerId: 'opencode',
      model: 'minimax-coding-plan/MiniMax-M3',
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
      model: 'minimax-coding-plan/MiniMax-M3',
    });

    expect(capability.maxBytesPerVideo).toBe(8 * 1024 * 1024);
    expect(capability.maxBytesTotal).toBe(8 * 1024 * 1024);
  });

  it('rejects more videos than the capability allows', () => {
    const capability = resolveAgentAttachmentCapability({
      providerId: 'opencode',
      model: 'minimax-coding-plan/MiniMax-M3',
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
      model: 'minimax-coding-plan/MiniMax-M3',
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
      model: 'minimax-coding-plan/MiniMax-M3',
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
