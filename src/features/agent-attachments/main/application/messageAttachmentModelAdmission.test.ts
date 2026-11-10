import { describe, expect, it, vi } from 'vitest';

import { getNativeAttachmentRecipientRestriction } from './messageAttachmentModelAdmission';

import type { TeamViewSnapshot } from '@shared/types';

const image = { id: 'image', filename: 'frame.png', size: 3, mimeType: 'image/png', data: 'AQID' };
const snapshot = {
  teamName: 'TEST-catalog-admission',
  config: { projectPath: '/TEST/primary', members: [{ name: 'worker', model: 'stale/Image' }] },
  members: [
    {
      name: 'worker',
      providerId: 'opencode',
      model: 'novel/VideoOnly',
      cwd: '/TEST/worktree',
      laneKind: 'secondary',
      laneOwnerProviderId: 'opencode',
    },
  ],
} as unknown as TeamViewSnapshot;

describe('native attachment pre-inbox catalog admission', () => {
  it('checks actual live member/model and secondary cwd instead of stale config', async () => {
    const resolver = vi.fn(async () => ['video']);
    const reason = await getNativeAttachmentRecipientRestriction({
      teamName: 'TEST-catalog-admission',
      memberName: 'worker',
      providerId: 'opencode',
      attachments: [image],
      readTeamData: async () => snapshot,
      resolveOpenCodeInputDeclaration: resolver,
    });
    expect(resolver).toHaveBeenCalledWith({
      projectPath: '/TEST/worktree',
      model: 'novel/VideoOnly',
    });
    expect(reason).toMatch(/does not declare image/);
    expect(image.data).toBe('AQID');
  });
  it('rejects unknown declarations before storage/native dispatch, keeping payload intact', async () => {
    const reason = await getNativeAttachmentRecipientRestriction({
      teamName: 'TEST-catalog-admission',
      memberName: 'worker',
      providerId: 'opencode',
      attachments: [image],
      readTeamData: async () => snapshot,
      resolveOpenCodeInputDeclaration: async () => {
        throw new Error('catalog unavailable');
      },
    });
    expect(reason).toMatch(/unknown image input support/);
    expect(image).toEqual({
      id: 'image',
      filename: 'frame.png',
      size: 3,
      mimeType: 'image/png',
      data: 'AQID',
    });
  });
});
