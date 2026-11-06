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

  it('routes Codex text by explicit native capability while retaining legacy routing', () => {
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
    expect(isReferenceAttachmentForMember(withoutTextCapability, text)).toBe(true);
    expect(
      validateAttachmentPayloadsForMember({ member: withoutTextCapability, attachments: [text] })
    ).toBeNull();
    const legacy = member({ ...ready, nativeInboxTextAttachmentsSupported: undefined });
    expect(isReferenceAttachmentForMember(legacy, text)).toBe(false);
    expect(
      validateAttachmentPayloadsForMember({ member: legacy, attachments: [text] })
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

  it('keeps references usable while native OpenCode media requires scoped declarations', () => {
    const bob = member({ providerId: 'opencode', model: 'novel-source/FutureModel' });
    const binary = payload({ mimeType: 'application/octet-stream' });
    expect(getMemberAttachmentUnavailableReason(bob)).toBeNull();
    expect(validateAttachmentPayloadsForMember({ member: bob, attachments: [binary] })).toBeNull();
    expect(
      validateAttachmentPayloadsForMember({ member: bob, attachments: [payload({})] })
    ).toContain('unknown image input');
    expect(
      validateAttachmentFilesForMember({
        member: bob,
        files: [file('diagram.png', 'image/png')],
        resolveDeclaration: () => ({ declaredInputModalities: ['image'] }),
      })
    ).toBeNull();
    expect(
      validateAttachmentPayloadsForMember({
        member: bob,
        attachments: [payload({})],
        resolveDeclaration: () => ({
          declaredInputModalities: null,
          unavailableReason: 'Catalog expired. Refresh to retry.',
        }),
      })
    ).toBe('Catalog expired. Refresh to retry.');
  });

  it('checks the requested recipient declaration without granting another model media support', () => {
    const supported = member({ providerId: 'opencode', model: 'novel-source/FutureModel' });
    const unsupported = member({ ...supported, name: 'other', model: 'novel-source/OtherModel' });
    const resolveDeclaration = (recipient: ResolvedTeamMember) => ({
      declaredInputModalities: recipient.model === supported.model ? ['image'] : [],
    });
    expect(
      validateAttachmentPayloadsForMember({
        member: supported,
        attachments: [payload({})],
        resolveDeclaration,
      })
    ).toBeNull();
    expect(
      validateAttachmentPayloadsForMember({
        member: unsupported,
        attachments: [payload({})],
        resolveDeclaration,
      })
    ).toContain('does not declare image input');
  });

  it('enforces video-only count and byte limits from declarations', () => {
    const recipient = member({ providerId: 'opencode', model: 'custom-source/NewVideoModel' });
    const resolveDeclaration = () => ({ declaredInputModalities: ['video'] });
    const video = payload({ filename: 'clip.mp4', mimeType: 'video/mp4' });
    expect(
      validateAttachmentFilesForMember({
        member: recipient,
        files: [file('clip.mp4', 'video/mp4')],
        resolveDeclaration,
      })
    ).toBeNull();
    expect(
      validateAttachmentPayloadsForMember({
        member: recipient,
        attachments: [video],
        resolveDeclaration,
      })
    ).toBeNull();
    expect(
      validateAttachmentPayloadsForMember({
        member: recipient,
        attachments: [payload({})],
        resolveDeclaration,
      })
    ).toContain('does not declare image input');
    expect(
      validateAttachmentPayloadsForMember({
        member: recipient,
        attachments: [video, { ...video, id: 'two' }],
        resolveDeclaration,
      })
    ).toBe('Maximum 1 video attachment for this model.');
    expect(
      validateAttachmentPayloadsForMember({
        member: recipient,
        attachments: [{ ...video, size: 8 * 1024 * 1024 + 1 }],
        resolveDeclaration,
      })
    ).toBe('Video is too large for the selected model.');
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
