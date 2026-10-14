import { describe, expect, it } from 'vitest';

import {
  canMemberShowAttachmentControl,
  getAttachmentInputAcceptForMember,
  getMemberAttachmentUnavailableReason,
  isReferenceAttachmentForMember,
  validateAttachmentFilesForMember,
  validateAttachmentPayloadsForMember,
} from '../../../src/renderer/utils/attachmentRecipientCapabilities';

import type { AttachmentPayload, ResolvedTeamMember } from '../../../src/shared/types';

function member(overrides: Partial<ResolvedTeamMember>): ResolvedTeamMember {
  return {
    name: 'bob',
    status: 'idle',
    currentTaskId: null,
    taskCount: 0,
    lastActiveAt: null,
    messageCount: 0,
    ...overrides,
  };
}

function file(name: string, type: string, bytes = 12): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function payload(overrides: Partial<AttachmentPayload>): AttachmentPayload {
  return {
    id: 'att-1',
    filename: 'diagram.png',
    mimeType: 'image/png',
    size: 12,
    data: 'aW1n',
    ...overrides,
  };
}

describe('attachmentRecipientCapabilities', () => {
  it('keeps references available while native attachments require current capability', () => {
    const native = member({ providerId: 'codex', model: 'gpt-5.5' });
    const ready = member({
      providerId: 'codex',
      model: 'gpt-5.5',
      nativeInboxAttachmentsSupported: true,
    });

    expect(getMemberAttachmentUnavailableReason(native)).toBeNull();
    expect(canMemberShowAttachmentControl(native)).toBe(true);
    const binary = payload({ mimeType: 'application/octet-stream' });
    expect(isReferenceAttachmentForMember(native, binary)).toBe(true);
    expect(
      validateAttachmentPayloadsForMember({ member: native, attachments: [binary] })
    ).toBeNull();
    expect(
      validateAttachmentFilesForMember({
        member: native,
        files: [file('diagram.png', 'image/png')],
      })
    ).toContain('current attachment-capable runtime');
    expect(getMemberAttachmentUnavailableReason(ready)).toBeNull();
    expect(
      validateAttachmentPayloadsForMember({ member: ready, attachments: [payload({})] })
    ).toBeNull();
  });

  it('keeps Codex text native-only for teammates and references for lead/OpenCode', () => {
    const ready = member({
      providerId: 'codex',
      nativeInboxAttachmentsSupported: true,
      nativeInboxTextAttachmentsSupported: true,
    });
    const text = payload({ filename: 'notes.txt', mimeType: 'text/plain' });
    expect(getAttachmentInputAcceptForMember(ready)).toBe('*/*');
    expect(
      validateAttachmentFilesForMember({
        member: ready,
        files: [
          file('notes.txt', 'text/plain'),
          file('data.json', 'application/json'),
          file('main.ts', 'video/mp2t'),
        ],
      })
    ).toBeNull();
    expect(
      validateAttachmentPayloadsForMember({
        member: ready,
        attachments: [text, payload({ id: 'image' })],
      })
    ).toBeNull();
    for (const filename of ['Dockerfile', 'Makefile', '.env.local']) {
      expect(
        validateAttachmentFilesForMember({ member: ready, files: [file(filename, '')] })
      ).toBeNull();
    }
    const withoutTextCapability = member({ ...ready, nativeInboxTextAttachmentsSupported: false });
    expect(isReferenceAttachmentForMember(withoutTextCapability, text)).toBe(false);
    expect(
      validateAttachmentPayloadsForMember({ member: withoutTextCapability, attachments: [text] })
    ).not.toBeNull();
    for (const referenceRecipient of [
      member({ ...ready, name: 'team-lead' }),
      member({ ...ready, providerId: 'opencode', model: 'gpt-5.4-mini' }),
    ]) {
      expect(isReferenceAttachmentForMember(referenceRecipient, text)).toBe(true);
      expect(
        validateAttachmentPayloadsForMember({ member: referenceRecipient, attachments: [text] })
      ).toBeNull();
    }
    for (const mimeType of ['application/pdf', 'image/gif', 'application/octet-stream']) {
      expect(
        validateAttachmentPayloadsForMember({ member: ready, attachments: [payload({ mimeType })] })
      ).toBeNull();
      expect(isReferenceAttachmentForMember(ready, payload({ mimeType }))).toBe(true);
    }
  });

  it('allows references but blocks native images for OpenCode non-vision models', () => {
    const bob = member({
      providerId: 'opencode',
      model: 'openrouter/z-ai/glm-5.1',
    });

    expect(getMemberAttachmentUnavailableReason(bob)).toBeNull();
    expect(canMemberShowAttachmentControl(bob)).toBe(true);
    expect(getAttachmentInputAcceptForMember(bob)).toBe('*/*');
    expect(isReferenceAttachmentForMember(bob, payload({}))).toBe(false);
    const binary = payload({ mimeType: 'application/octet-stream' });
    expect(isReferenceAttachmentForMember(bob, binary)).toBe(true);
    expect(validateAttachmentPayloadsForMember({ member: bob, attachments: [binary] })).toBeNull();
    expect(
      validateAttachmentFilesForMember({ member: bob, files: [file('diagram.png', 'image/png')] })
    ).toBe(
      'This OpenCode model is not verified for image attachments. Choose a vision-capable model or remove the image.'
    );
    expect(validateAttachmentPayloadsForMember({ member: bob, attachments: [payload({})] })).toBe(
      'This OpenCode model is not verified for image attachments. Choose a vision-capable model or remove the image.'
    );
  });

  it.each([
    'openrouter/moonshotai/kimi-k2.6',
    'kimi-for-coding/kimi-for-coding',
    'kimi-for-coding/kimi-for-coding-highspeed',
    'kimi-for-coding/k3',
    'zai-coding-plan/glm-5v-turbo',
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
  ])('allows image picker input for verified OpenCode subscription model %s', (model) => {
    const bob = member({
      providerId: 'opencode',
      model,
    });

    expect(getMemberAttachmentUnavailableReason(bob)).toBeNull();
    expect(getAttachmentInputAcceptForMember(bob)).toBe('*/*');
    expect(isReferenceAttachmentForMember(bob, payload({}))).toBe(false);
    expect(
      validateAttachmentFilesForMember({ member: bob, files: [file('diagram.png', 'image/png')] })
    ).toBeNull();
    expect(
      validateAttachmentPayloadsForMember({ member: bob, attachments: [payload({})] })
    ).toBeNull();
  });

  it.each([
    ['demo.mp4', 'video/mp4'],
    ['demo.webm', 'video/webm'],
    ['demo.mov', 'video/quicktime'],
  ])('allows %s video input only for the video-capable MiniMax model', (filename, mimeType) => {
    const miniMax = member({
      providerId: 'opencode',
      model: 'minimax-coding-plan/MiniMax-M3',
    });
    const kimi = member({
      providerId: 'opencode',
      model: 'openrouter/moonshotai/kimi-k2.6',
    });
    const videoFile = file(filename, mimeType);
    const videoPayload = payload({ filename, mimeType });

    expect(getAttachmentInputAcceptForMember(miniMax)).toBe('*/*');
    expect(isReferenceAttachmentForMember(miniMax, videoPayload)).toBe(false);
    expect(isReferenceAttachmentForMember(kimi, videoPayload)).toBe(false);
    expect(validateAttachmentFilesForMember({ member: miniMax, files: [videoFile] })).toBeNull();
    expect(
      validateAttachmentPayloadsForMember({ member: miniMax, attachments: [videoPayload] })
    ).toBeNull();
    expect(validateAttachmentFilesForMember({ member: kimi, files: [videoFile] })).toBe(
      'This provider path does not support video attachments through this delivery path.'
    );
    expect(validateAttachmentPayloadsForMember({ member: kimi, attachments: [videoPayload] })).toBe(
      'This provider path does not support video attachments through this delivery path.'
    );
  });

  it('enforces one video and the 8MiB per-video/mixed budget for MiniMax', () => {
    const miniMax = member({
      providerId: 'opencode',
      model: 'minimax-coding-plan/MiniMax-M3',
    });
    const eightMiB = 8 * 1024 * 1024;

    expect(
      validateAttachmentFilesForMember({
        member: miniMax,
        files: [file('one.mp4', 'video/mp4'), file('two.webm', 'video/webm')],
      })
    ).toBe('Maximum 1 video attachment for this model.');
    expect(
      validateAttachmentPayloadsForMember({
        member: miniMax,
        attachments: [
          payload({ filename: 'one.mp4', mimeType: 'video/mp4' }),
          payload({ id: 'att-2', filename: 'two.webm', mimeType: 'video/webm' }),
        ],
      })
    ).toBe('Maximum 1 video attachment for this model.');
    expect(
      validateAttachmentFilesForMember({
        member: miniMax,
        files: [file('too-large.mp4', 'video/mp4', eightMiB + 1)],
      })
    ).toBe('Video is too large for the selected model.');
    expect(
      validateAttachmentPayloadsForMember({
        member: miniMax,
        attachments: [
          payload({
            filename: 'clip.mp4',
            mimeType: 'video/mp4',
            size: eightMiB - 4,
          }),
          payload({ id: 'att-2', size: 8 }),
        ],
      })
    ).toBe('Attachments exceed the selected model size limit.');
  });

  it('keeps browser video/mp2t for TypeScript files on the text-file path', () => {
    const anthropicLead = member({
      name: 'lead',
      agentType: 'team-lead',
      providerId: 'anthropic',
      model: 'claude-opus-4-6',
    });
    const miniMax = member({
      providerId: 'opencode',
      model: 'minimax-coding-plan/MiniMax-M3',
    });
    const typeScriptFile = file('worker.ts', 'video/mp2t');

    expect(
      validateAttachmentFilesForMember({ member: anthropicLead, files: [typeScriptFile] })
    ).toBeNull();
    expect(
      validateAttachmentFilesForMember({ member: miniMax, files: [typeScriptFile] })
    ).toBeNull();
    const textPayload = payload({ filename: 'worker.ts', mimeType: 'text/plain' });
    expect(isReferenceAttachmentForMember(miniMax, textPayload)).toBe(true);
    expect(
      validateAttachmentPayloadsForMember({ member: miniMax, attachments: [textPayload] })
    ).toBeNull();
  });

  it('routes unsupported Codex GIF images as references rather than native images', () => {
    const codexLead = member({
      name: 'lead',
      agentType: 'team-lead',
      providerId: 'codex',
      model: 'gpt-5.5',
    });

    expect(
      validateAttachmentFilesForMember({
        member: codexLead,
        files: [file('animation.gif', 'image/gif')],
      })
    ).toBeNull();
    expect(
      validateAttachmentPayloadsForMember({
        member: codexLead,
        attachments: [payload({ filename: 'animation.gif', mimeType: 'image/gif' })],
      })
    ).toBeNull();
    expect(
      isReferenceAttachmentForMember(
        codexLead,
        payload({ filename: 'animation.gif', mimeType: 'image/gif' })
      )
    ).toBe(true);
  });

  it('allows Claude GIF and WebP image payloads', () => {
    const anthropicLead = member({
      name: 'lead',
      agentType: 'team-lead',
      providerId: 'anthropic',
      model: 'claude-opus-4-6',
    });

    expect(
      validateAttachmentFilesForMember({
        member: anthropicLead,
        files: [file('clip.gif', 'image/gif')],
      })
    ).toBeNull();
    expect(
      validateAttachmentPayloadsForMember({
        member: anthropicLead,
        attachments: [payload({ filename: 'clip.webp', mimeType: 'image/webp' })],
      })
    ).toBeNull();
  });

  it('routes Codex lead text files as references without enabling native text', () => {
    const codexLead = member({
      name: 'lead',
      agentType: 'team-lead',
      providerId: 'codex',
      model: 'gpt-5.5',
    });

    expect(
      validateAttachmentFilesForMember({
        member: codexLead,
        files: [file('notes.md', 'text/markdown')],
      })
    ).toBeNull();
    expect(
      validateAttachmentPayloadsForMember({
        member: codexLead,
        attachments: [payload({ filename: 'notes.md', mimeType: 'text/plain' })],
      })
    ).toBeNull();
    expect(
      isReferenceAttachmentForMember(
        codexLead,
        payload({ filename: 'notes.md', mimeType: 'text/plain' })
      )
    ).toBe(true);
  });

  it('keeps unsupported recipients unavailable for both references and native files', () => {
    const unsupported = member({ model: 'custom' });
    expect(canMemberShowAttachmentControl(unsupported)).toBe(false);
    expect(getMemberAttachmentUnavailableReason(unsupported)).toBe(
      'Attachments require a supported recipient provider.'
    );
    for (const mimeType of ['image/png', 'application/octet-stream']) {
      expect(isReferenceAttachmentForMember(unsupported, payload({ mimeType }))).toBe(false);
      expect(
        validateAttachmentPayloadsForMember({
          member: unsupported,
          attachments: [payload({ mimeType })],
        })
      ).toBe('Attachments require a supported recipient provider.');
    }
  });

  it('allows text/PDF files for Anthropic lead recipients', () => {
    const anthropicLead = member({
      name: 'lead',
      agentType: 'team-lead',
      providerId: 'anthropic',
      model: 'claude-opus-4-6',
    });

    expect(
      validateAttachmentFilesForMember({
        member: anthropicLead,
        files: [file('brief.pdf', 'application/pdf')],
      })
    ).toBeNull();
    expect(
      validateAttachmentPayloadsForMember({
        member: anthropicLead,
        attachments: [payload({ filename: 'brief.pdf', mimeType: 'application/pdf' })],
      })
    ).toBeNull();
  });
});
