import { HostedTaskBoardMutationGrantAuthority } from '@main/composition/hosted/hostedTaskBoardMutationGrantAuthority';
import { createQueryContext, parseBootId, parseDeploymentId } from '@shared/contracts/hosted';
import { describe, expect, it } from 'vitest';

import type { HostedTaskMutationCommand } from '@features/team-task-board/main/hosted';

const context = () =>
  createQueryContext({
    actorId: 'actor_task-grant-test',
    sessionId: 'session_task-grant-test',
    deploymentId: parseDeploymentId(`deployment_${'a'.repeat(32)}`),
    bootId: parseBootId(`boot_${'b'.repeat(32)}`),
    requestId: 'request_task-grant-test',
    authorizedScope: 'scope_task-grant-test',
    deadlineAtMs: Date.now() + 60_000,
    signal: new AbortController().signal,
  });

describe('Product task mutation grant', () => {
  it('rejects revocation while the current member authority read is pending', async () => {
    let releaseRead!: () => void;
    let reachedRead!: () => void;
    const waiting = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      reachedRead = resolve;
    });
    let granted = true;
    const authority = new HostedTaskBoardMutationGrantAuthority({
      assertCurrent: async () => {
        reachedRead();
        await waiting;
      },
    });
    const query = context();
    authority.bind(query, {
      ownerEffectFence: { grantRevision: 'c'.repeat(64), identityChecksum: 'd'.repeat(64) },
      revalidate: async () => granted,
    });
    const command = {} as HostedTaskMutationCommand;
    const pending = authority.assertCurrent(command, query);
    await reached;
    granted = false;
    releaseRead();
    await expect(pending).rejects.toThrow('hosted-task-board-grant-stale');
    authority.release(query);
    await expect(authority.assertCurrent(command, query)).rejects.toThrow(
      'hosted-task-board-grant-stale'
    );
  });
});
