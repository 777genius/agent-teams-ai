import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useStableActiveMembers } from '@renderer/components/team/useStableActiveMembers';
import { validateAttachmentPayloadsForMember } from '@renderer/utils/attachmentRecipientCapabilities';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AttachmentPayload, ResolvedTeamMember } from '@shared/types';

const member: ResolvedTeamMember = {
  name: 'TEST-recipient',
  providerId: 'opencode',
  model: 'openai/TEST-model',
  runtimeOwner: 'captured-host',
  hostMemberId: 'TEST-member',
  configuredSettingsFingerprint: 'TEST-settings',
  status: 'idle',
  currentTaskId: null,
  taskCount: 0,
  lastActiveAt: null,
  messageCount: 0,
};
const media: NonNullable<ResolvedTeamMember['nativeMediaTransport']> = {
  revision: 'opencode-2.1.4-native-media-v1',
  mimeTypes: ['image/png', 'application/pdf'],
  maxBytes: 100,
  maxCount: 3,
  maxTotalBytes: 200,
  videos: false,
};
const image: AttachmentPayload = {
  id: 'TEST-image',
  filename: 'TEST.png',
  mimeType: 'image/png',
  size: 10,
  data: '',
};
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

describe('stable members refresh existing attachment controls', () => {
  it('propagates arrival, semantic changes and removal while retaining equivalent clones', () => {
    const host = document.createElement('div'),
      root = createRoot(host);
    const observations: ResolvedTeamMember[][] = [];
    function AttachmentControl({
      value,
      attachments,
    }: {
      value: ResolvedTeamMember;
      attachments: AttachmentPayload[];
    }) {
      const members = useStableActiveMembers([value]);
      observations.push(members);
      return (
        <output>
          {validateAttachmentPayloadsForMember({
            member: members[0],
            attachments,
            resolveDeclaration: () => ({ declaredInputModalities: ['image', 'pdf', 'video'] }),
          }) ?? 'allowed'}
        </output>
      );
    }
    const render = (value: ResolvedTeamMember, attachments = [image]) =>
      act(() => root.render(<AttachmentControl value={value} attachments={attachments} />));
    try {
      render(member);
      render({ ...member, nativeMediaTransport: media });
      expect(observations.at(-1)?.[0].nativeMediaTransport).toEqual(media);
      const original = observations.at(-1);
      render({ ...member, nativeMediaTransport: structuredClone(media) });
      expect(observations.at(-1)).toBe(original);
      for (const [change, files, expected] of [
        [{ maxBytes: 5 }, [image], 'Image is too large'],
        [{ maxCount: 1 }, [image, { ...image, id: 'TEST-second' }], 'Maximum 1 image'],
        [{ maxTotalBytes: 5 }, [image], 'Attachments exceed'],
        [{ mimeTypes: ['application/pdf'] }, [image], 'does not declare image'],
      ] as const) {
        render({ ...member, nativeMediaTransport: { ...media, ...change } }, [...files]);
        expect(host.textContent).toContain(expected);
      }
      render({ ...member, nativeMediaTransport: media }, [
        { ...image, mimeType: 'application/pdf' },
      ]);
      expect(host.textContent).toBe('allowed');
      render(member, [{ ...image, mimeType: 'video/mp4' }]);
      expect(observations.at(-1)?.[0].nativeMediaTransport).toBeUndefined();
      expect(host.textContent).toBe('allowed');
    } finally {
      act(() => root.unmount());
    }
  });

  it.each(['hostMemberId', 'configuredSettingsFingerprint'] as const)(
    'refreshes a changed %s used by member controls',
    (field) => {
      const host = document.createElement('div'),
        root = createRoot(host);
      function MemberControl({ value }: { value: ResolvedTeamMember }) {
        return <output>{useStableActiveMembers([value])[0][field]}</output>;
      }
      try {
        act(() => root.render(<MemberControl value={member} />));
        act(() =>
          root.render(<MemberControl value={{ ...member, [field]: 'TEST-replacement' }} />)
        );
        expect(host.textContent).toBe('TEST-replacement');
      } finally {
        act(() => root.unmount());
      }
    }
  );
});
