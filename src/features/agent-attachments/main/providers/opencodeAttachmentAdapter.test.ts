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
  ])('allows verified Kimi membership model %s image delivery', (model) => {
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
