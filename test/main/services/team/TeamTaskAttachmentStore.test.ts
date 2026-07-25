import { describe, expect, it, vi } from 'vitest';

import {
  type TaskAttachmentAtomicWriterPort,
  TeamTaskAttachmentStore,
} from '../../../../src/main/services/team/TeamTaskAttachmentStore';

vi.mock('@main/utils/pathDecoder', () => ({
  getAppDataPath: (): string => '/workspace/app-data',
}));

function createAtomicWriter(): TaskAttachmentAtomicWriterPort {
  return {
    writeFileAtomically: vi.fn(async () => undefined),
  };
}

describe('TeamTaskAttachmentStore', () => {
  it('publishes decoded attachment bytes through the atomic writer port', async () => {
    const atomicWriter = createAtomicWriter();
    const store = new TeamTaskAttachmentStore(atomicWriter);

    const metadata = await store.saveAttachment(
      'my-team',
      'task-1',
      'attachment-1',
      'proof.png',
      'image/png',
      'dGVzdA=='
    );

    expect(atomicWriter.writeFileAtomically).toHaveBeenCalledWith(
      '/workspace/app-data/task-attachments/my-team/task-1/attachment-1--proof.png',
      Buffer.from('test')
    );
    expect(metadata).toEqual(
      expect.objectContaining({
        id: 'attachment-1',
        filename: 'proof.png',
        mimeType: 'image/png',
        size: 4,
        filePath: '/workspace/app-data/task-attachments/my-team/task-1/attachment-1--proof.png',
      })
    );
  });

  it('preserves an atomic publication failure without returning attachment metadata', async () => {
    const failure = new Error('atomic rename failed');
    const atomicWriter = createAtomicWriter();
    vi.mocked(atomicWriter.writeFileAtomically).mockRejectedValueOnce(failure);
    const store = new TeamTaskAttachmentStore(atomicWriter);

    await expect(
      store.saveAttachment(
        'my-team',
        'task-1',
        'attachment-1',
        'proof.png',
        'image/png',
        'dGVzdA=='
      )
    ).rejects.toBe(failure);
  });
});
