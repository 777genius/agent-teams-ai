import { createTeamMessageAttachmentReadTransport } from '@renderer/composition/team/createTeamMessageAttachmentReadTransport';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  getAttachments: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    teams: apiMocks,
  },
}));

describe('createTeamMessageAttachmentReadTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates the persisted attachment read without changing desktop results', async () => {
    const attachments = [
      {
        id: 'attachment-1',
        data: 'dmVyaWZpY2F0aW9u',
        mimeType: 'text/markdown',
        filePath: '/app/data/attachments/team-a/msg-1/attachment-1--verification.md',
      },
    ];
    apiMocks.getAttachments.mockResolvedValueOnce(attachments);

    const transport = createTeamMessageAttachmentReadTransport();

    await expect(transport.getAttachments('team-a', 'msg-1')).resolves.toBe(attachments);
    expect(apiMocks.getAttachments).toHaveBeenCalledWith('team-a', 'msg-1');
  });

  it('preserves hosted-safe empty results and transport failures for the consumer policy', async () => {
    apiMocks.getAttachments
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('unavailable'));

    const transport = createTeamMessageAttachmentReadTransport();

    await expect(transport.getAttachments('hosted-team', 'msg-2')).resolves.toEqual([]);
    await expect(transport.getAttachments('hosted-team', 'msg-3')).rejects.toThrow('unavailable');
  });
});
