import {
  buildOpenCodeAttachmentDeliveryParts,
  redactOpenCodeFilePartsForDiagnostics,
} from './opencodeAttachmentAdapter';

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

function attachmentWithBytes(
  size: number,
  overrides: Partial<AttachmentPayload> = {}
): AttachmentPayload {
  return attachment({
    size,
    data: Buffer.alloc(size, 1).toString('base64'),
    ...overrides,
  });
}

describe('OpenCode attachment adapter', () => {
  it('keeps text-only messages on the legacy text path', () => {
    expect(
      buildOpenCodeAttachmentDeliveryParts({
        text: 'hello',
        model: 'openrouter/moonshotai/kimi-k2.6',
      })
    ).toEqual({
      kind: 'legacy_text',
      text: 'hello',
      fileParts: [],
      diagnostics: [],
    });
  });

  it('serializes verified OpenCode vision models as file parts', () => {
    const result = buildOpenCodeAttachmentDeliveryParts({
      text: 'What color?',
      model: 'openrouter/moonshotai/kimi-k2.6',
      attachments: [attachment()],
    });

    expect(result.kind).toBe('text_with_file_parts');
    expect(result.fileParts).toEqual([
      {
        type: 'file',
        mime: 'image/png',
        url: `data:image/png;base64,${attachment().data}`,
        filename: 'red.png',
      },
    ]);
    expect(result.diagnostics.join('\n')).not.toContain(attachment().data);
  });

  it('allows verified GLM 4.5V image delivery', () => {
    expect(() =>
      buildOpenCodeAttachmentDeliveryParts({
        text: 'What color?',
        model: 'openrouter/z-ai/glm-4.5v',
        attachments: [attachment()],
      })
    ).not.toThrow();
  });

  it.each([
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
  ])('allows verified subscription model %s image delivery', (model) => {
    expect(() =>
      buildOpenCodeAttachmentDeliveryParts({
        text: 'What color?',
        model,
        attachments: [attachment()],
      })
    ).not.toThrow();
  });

  it('blocks known non-vision OpenCode models before runtime send', () => {
    expect(() =>
      buildOpenCodeAttachmentDeliveryParts({
        text: 'What color?',
        model: 'openrouter/z-ai/glm-5.1',
        attachments: [attachment()],
      })
    ).toThrow(/not verified for image attachments/);
  });

  it('blocks unknown OpenCode model image delivery by default', () => {
    expect(() =>
      buildOpenCodeAttachmentDeliveryParts({
        text: 'What color?',
        model: 'openrouter/example/new-model',
        attachments: [attachment()],
      })
    ).toThrow(/unknown image support/);
  });

  it('rejects non-image attachments before provider send', () => {
    expect(() =>
      buildOpenCodeAttachmentDeliveryParts({
        text: 'Read PDF',
        model: 'openrouter/moonshotai/kimi-k2.6',
        attachments: [attachment({ filename: 'a.pdf', mimeType: 'application/pdf' })],
      })
    ).toThrow(/OpenCode currently supports image attachments only/);
  });

  it('serializes video attachments as file parts for the verified video model', () => {
    const result = buildOpenCodeAttachmentDeliveryParts({
      text: 'Summarize this clip',
      model: 'minimax-coding-plan/MiniMax-M3',
      attachments: [attachment({ filename: 'clip.mp4', mimeType: 'video/mp4' })],
    });

    expect(result.kind).toBe('text_with_file_parts');
    expect(result.fileParts).toEqual([
      {
        type: 'file',
        mime: 'video/mp4',
        url: `data:video/mp4;base64,${attachment().data}`,
        filename: 'clip.mp4',
      },
    ]);
    expect(result.diagnostics.join('\n')).toContain('video file part');
    expect(result.diagnostics.join('\n')).not.toContain(attachment().data);
  });

  it('delivers both image and video parts for the verified video model', () => {
    const result = buildOpenCodeAttachmentDeliveryParts({
      text: 'What is happening?',
      model: 'minimax-coding-plan/MiniMax-M3',
      attachments: [
        attachment({ filename: 'frame.png', mimeType: 'image/png' }),
        attachment({ filename: 'clip.webm', mimeType: 'video/webm' }),
      ],
    });

    expect(result.fileParts.map((part) => part.mime)).toEqual(['image/png', 'video/webm']);
  });

  it('rejects two videos at the delivery boundary', () => {
    expect(() =>
      buildOpenCodeAttachmentDeliveryParts({
        text: 'Compare these clips',
        model: 'minimax-coding-plan/MiniMax-M3',
        attachments: [
          attachment({ id: 'video_1', filename: 'one.mp4', mimeType: 'video/mp4' }),
          attachment({ id: 'video_2', filename: 'two.webm', mimeType: 'video/webm' }),
        ],
      })
    ).toThrow(/Maximum 1 video attachment/);
  });

  it('rejects mixed image and video data above the 8 MiB total budget', () => {
    expect(() =>
      buildOpenCodeAttachmentDeliveryParts({
        text: 'Inspect these',
        model: 'minimax-coding-plan/MiniMax-M3',
        attachments: [
          attachmentWithBytes(4 * 1024 * 1024, {
            id: 'image_1',
            filename: 'frame.png',
            mimeType: 'image/png',
          }),
          attachmentWithBytes(4 * 1024 * 1024 + 1, {
            id: 'video_1',
            filename: 'clip.mp4',
            mimeType: 'video/mp4',
          }),
        ],
      })
    ).toThrow(/total byte limit/);
  });

  it('rejects video data above the 8 MiB per-file budget', () => {
    expect(() =>
      buildOpenCodeAttachmentDeliveryParts({
        text: 'Inspect this clip',
        model: 'minimax-coding-plan/MiniMax-M3',
        attachments: [
          attachmentWithBytes(8 * 1024 * 1024 + 1, {
            id: 'video_1',
            filename: 'clip.mp4',
            mimeType: 'video/mp4',
          }),
        ],
      })
    ).toThrow(/too large/);
  });

  it('rejects declared attachment size that does not match decoded data', () => {
    expect(() =>
      buildOpenCodeAttachmentDeliveryParts({
        text: 'Inspect this clip',
        model: 'minimax-coding-plan/MiniMax-M3',
        attachments: [
          attachment({
            filename: 'clip.mp4',
            mimeType: 'video/mp4',
            size: 4,
          }),
        ],
      })
    ).toThrow(/declared byte size does not match its data/);
  });

  it('rejects malformed base64 attachment data', () => {
    expect(() =>
      buildOpenCodeAttachmentDeliveryParts({
        text: 'Inspect this clip',
        model: 'minimax-coding-plan/MiniMax-M3',
        attachments: [
          attachment({
            filename: 'clip.mp4',
            mimeType: 'video/mp4',
            size: 3,
            data: 'not-base64',
          }),
        ],
      })
    ).toThrow(/invalid base64 data/);
  });

  it('rejects video attachments for OpenCode models that only support images', () => {
    expect(() =>
      buildOpenCodeAttachmentDeliveryParts({
        text: 'Summarize this clip',
        model: 'openrouter/moonshotai/kimi-k2.6',
        attachments: [attachment({ filename: 'clip.mp4', mimeType: 'video/mp4' })],
      })
    ).toThrow(/does not support video attachments/);
  });

  it('redacts data URLs from diagnostics', () => {
    const redacted = redactOpenCodeFilePartsForDiagnostics([
      {
        type: 'file',
        mime: 'image/png',
        url: `data:image/png;base64,${attachment().data}`,
        filename: 'red.png',
      },
    ]);

    expect(redacted[0].url).toBe('[redacted data URL: image/png]');
  });
});
