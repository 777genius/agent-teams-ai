import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  lock: vi.fn(),
}));

vi.mock('proper-lockfile', () => ({
  lock: mocks.lock,
}));

import { NodeTaskAttachmentMutationCoordinator } from '../../../../src/main/services/team/TaskAttachmentMutationCoordinator';

describe('NodeTaskAttachmentMutationCoordinator', () => {
  beforeEach(() => {
    mocks.lock.mockReset();
  });

  it('preserves a committed result when lock release rejects', async () => {
    const releaseFailure = new Error('release failed');
    mocks.lock.mockResolvedValue(
      vi.fn(async () => {
        throw releaseFailure;
      })
    );
    const coordinator = new NodeTaskAttachmentMutationCoordinator();

    await expect(
      coordinator.run(join(tmpdir(), 'attachment-release-result', 'task-1'), async () => 'saved')
    ).resolves.toBe('saved');
  });

  it('preserves the operation error when lock release also rejects', async () => {
    const operationFailure = new Error('operation failed');
    mocks.lock.mockResolvedValue(
      vi.fn(async () => {
        throw new Error('release failed');
      })
    );
    const coordinator = new NodeTaskAttachmentMutationCoordinator();

    await expect(
      coordinator.run(join(tmpdir(), 'attachment-release-error', 'task-1'), async () => {
        throw operationFailure;
      })
    ).rejects.toBe(operationFailure);
  });

  it('rechecks lock health and compensates a publication before returning', async () => {
    const compromisedFailure = new Error('lock compromised');
    let compromise!: (error: Error) => void;
    mocks.lock.mockImplementation(async (_filePath, options) => {
      compromise = options.onCompromised;
      return vi.fn(async () => undefined);
    });
    const compensate = vi.fn(async () => undefined);
    const coordinator = new NodeTaskAttachmentMutationCoordinator();

    await expect(
      coordinator.run(join(tmpdir(), 'attachment-compromised', 'task-1'), async (guard) => {
        guard.registerCompensation(compensate);
        compromise(compromisedFailure);
        return 'published';
      })
    ).rejects.toBe(compromisedFailure);
    expect(compensate).toHaveBeenCalledOnce();
  });
});
