import { describe, expect, it } from 'vitest';

import {
  getAttachmentInputAcceptForMember,
  getMemberAttachmentUnavailableReason,
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
  it('blocks OpenCode non-vision models before file selection or send', () => {
    const bob = member({
      providerId: 'opencode',
      model: 'openrouter/z-ai/glm-5.1',
    });

    expect(getMemberAttachmentUnavailableReason(bob)).toBe(
      'This OpenCode model is not verified for image attachments. Choose a vision-capable model or remove the image.'
    );
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
  ])('allows image picker input for verified Kimi OpenCode model %s', (model) => {
    const bob = member({
      providerId: 'opencode',
      model,
    });

    expect(getMemberAttachmentUnavailableReason(bob)).toBeNull();
    expect(getAttachmentInputAcceptForMember(bob)).toBe('image/png,image/jpeg,image/webp');
    expect(
      validateAttachmentFilesForMember({ member: bob, files: [file('diagram.png', 'image/png')] })
    ).toBeNull();
    expect(
      validateAttachmentPayloadsForMember({ member: bob, attachments: [payload({})] })
    ).toBeNull();
  });

  it('blocks image MIME types not supported by an otherwise image-capable provider', () => {
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
    ).toBe('This image type is not supported by the selected model.');
    expect(
      validateAttachmentPayloadsForMember({
        member: codexLead,
        attachments: [payload({ filename: 'animation.gif', mimeType: 'image/gif' })],
      })
    ).toBe('This image type is not supported by the selected model.');
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

  it('blocks non-image files for image-only providers', () => {
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
    ).toBe(
      'This provider path currently supports image attachments only. Non-image files are blocked before provider delivery.'
    );
    expect(
      validateAttachmentPayloadsForMember({
        member: codexLead,
        attachments: [payload({ filename: 'notes.md', mimeType: 'text/plain' })],
      })
    ).toBe(
      'This provider path currently supports image attachments only. Non-image files are blocked before provider delivery.'
    );
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
