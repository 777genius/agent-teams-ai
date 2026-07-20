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
});
