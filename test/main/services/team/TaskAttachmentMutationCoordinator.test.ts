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

  it('compensates every active publication after an ordinary uncommitted failure', async () => {
    const operationFailure = new Error('operation failed');
    const compensate = vi.fn(async () => undefined);
    mocks.lock.mockResolvedValue(vi.fn(async () => undefined));
    const coordinator = new NodeTaskAttachmentMutationCoordinator();

    await expect(
      coordinator.run(join(tmpdir(), 'attachment-operation-failure', 'task-1'), async (guard) => {
        guard.registerCompensation(compensate);
        throw operationFailure;
      })
    ).rejects.toBe(operationFailure);
    expect(compensate).toHaveBeenCalledOnce();
  });

  it('does not repeat a compensation explicitly dismissed by a successful rollback', async () => {
    const operationFailure = new Error('operation failed');
    const compensate = vi.fn(async () => undefined);
    mocks.lock.mockResolvedValue(vi.fn(async () => undefined));
    const coordinator = new NodeTaskAttachmentMutationCoordinator();

    await expect(
      coordinator.run(
        join(tmpdir(), 'attachment-dismissed-compensation', 'task-1'),
        async (guard) => {
          const receipt = guard.registerCompensation(compensate);
          await compensate();
          receipt.dismiss();
          throw operationFailure;
        }
      )
    ).rejects.toBe(operationFailure);
    expect(compensate).toHaveBeenCalledOnce();
  });

  it('aggregates the operation error with every failed active compensation', async () => {
    const operationFailure = new Error('operation failed');
    const cleanupFailure = new Error('cleanup failed');
    mocks.lock.mockResolvedValue(vi.fn(async () => undefined));
    const coordinator = new NodeTaskAttachmentMutationCoordinator();

    const failure = await coordinator
      .run(join(tmpdir(), 'attachment-incomplete-compensation', 'task-1'), async (guard) => {
        guard.registerCompensation(async () => {
          throw cleanupFailure;
        });
        throw operationFailure;
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([operationFailure, cleanupFailure]);
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

  it('preserves a committed result when compromise was observed before the commit marker', async () => {
    const compromisedFailure = new Error('lock compromised');
    let compromise!: (error: Error) => void;
    mocks.lock.mockImplementation(async (_filePath, options) => {
      compromise = options.onCompromised;
      return vi.fn(async () => undefined);
    });
    const compensate = vi.fn(async () => undefined);
    const coordinator = new NodeTaskAttachmentMutationCoordinator();

    await expect(
      coordinator.run(
        join(tmpdir(), 'attachment-compromised-after-commit', 'task-1'),
        async (guard) => {
          guard.registerCompensation(compensate);
          compromise(compromisedFailure);
          guard.markCommitted();
          return 'committed';
        }
      )
    ).resolves.toBe('committed');
    expect(compensate).not.toHaveBeenCalled();
  });

  it('runs every pre-commit compensation in reverse order after compromise', async () => {
    const compromisedFailure = new Error('lock compromised');
    let compromise!: (error: Error) => void;
    mocks.lock.mockImplementation(async (_filePath, options) => {
      compromise = options.onCompromised;
      return vi.fn(async () => undefined);
    });
    const order: string[] = [];
    const coordinator = new NodeTaskAttachmentMutationCoordinator();

    await expect(
      coordinator.run(
        join(tmpdir(), 'attachment-compromised-reverse-compensation', 'task-1'),
        async (guard) => {
          guard.registerCompensation(async () => {
            order.push('first');
          });
          guard.registerCompensation(async () => {
            order.push('second');
          });
          compromise(compromisedFailure);
          return 'published';
        }
      )
    ).rejects.toBe(compromisedFailure);
    expect(order).toEqual(['second', 'first']);
  });
});
