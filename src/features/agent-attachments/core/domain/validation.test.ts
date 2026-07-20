import { resolveAgentAttachmentCapability } from './capabilities';
import { validateAttachmentForCapability, validateImageOptimizationInput } from './validation';

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
  ])('allows verified Kimi OpenCode model %s', (model) => {
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
});
