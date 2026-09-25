import { HostedTaskBoardMutationGrantAuthority } from '@main/composition/hosted/hostedTaskBoardMutationGrantAuthority';
import { ProductTaskWriteCommitAuthority } from '@main/composition/hosted/productTaskWriteCommitAuthority';
import {
  createQueryContext,
  parseBootId,
  parseDeploymentId,
  parseTeamId,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import type { HostedTaskMutationGrantFence } from '@main/composition/hosted/hostedTaskBoardMutationGrantAuthority';
import type { OrchestratorLifecycleOwnerBinding } from '@main/composition/hosted/hostedLifecycleOrchestratorReadiness';
import type {
  HostedTaskAssignmentCurrentPin,
  HostedTaskAssignmentCurrentSelector,
} from '@features/internal-storage/contracts';
import type { HostedTaskMutationCommand } from '@features/team-task-board/main/hosted';

const DEPLOYMENT_ID = parseDeploymentId(`deployment_${'a'.repeat(32)}`);
const BOOT_ID = parseBootId(`boot_${'b'.repeat(32)}`);
const TEAM_ID = parseTeamId(`team_${'c'.repeat(32)}`);
const MEMBER_ID = `member_${'d'.repeat(32)}`;
const PUBLIC_WORKSPACE_ID = `workspace_${'e'.repeat(32)}`;
const ACTOR_ID = `actor_${'f'.repeat(64)}`;
const GRANT = Object.freeze({ grantRevision: '1'.repeat(64), identityChecksum: '2'.repeat(64) });
const OWNER: OrchestratorLifecycleOwnerBinding = Object.freeze({
  ownerAuthority: 'owner-authority_test',
  ownerGeneration: 7,
  ownerSessionId: 'owner-session_test',
  socketIdentity: Object.freeze({ device: '1', inode: '2', uid: 1000, gid: 1000, mode: 0o600 }),
});
const WRITER_EPOCH = Object.freeze({
  deploymentId: DEPLOYMENT_ID,
  bootId: BOOT_ID,
  ownerAuthority: OWNER.ownerAuthority,
  ownerGeneration: OWNER.ownerGeneration,
  ownerSessionId: OWNER.ownerSessionId,
  restoreGeneration: 3,
  mountGeneration: 2,
});

function context() {
  return createQueryContext({
    actorId: ACTOR_ID,
    sessionId: 'session_product-task-write',
    deploymentId: DEPLOYMENT_ID,
    bootId: BOOT_ID,
    requestId: 'request_product-task-write',
    authorizedScope: 'scope_product-task-write',
    deadlineAtMs: Date.now() + 60_000,
    signal: new AbortController().signal,
  });
}

function fence(requester = true): HostedTaskMutationGrantFence {
  return Object.freeze({
    ownerEffectFence: GRANT,
    revalidate: async () => true,
    ...(requester
      ? {
          requester: Object.freeze({
            publicWorkspaceId: PUBLIC_WORKSPACE_ID,
            userId: `usr_${'9'.repeat(32)}`,
            sessionId: `session_${'8'.repeat(32)}`,
          }),
        }
      : {}),
  });
}

function command(kind: HostedTaskMutationCommand['kind'], ownerId?: string | null) {
  return { kind, teamId: TEAM_ID, ...(ownerId === undefined ? {} : { ownerId }) } as never;
}

function pin(runId: string | null = null): HostedTaskAssignmentCurrentPin {
  return Object.freeze({ runId, ...WRITER_EPOCH }) as HostedTaskAssignmentCurrentPin;
}

function harness(
  options: {
    resolve?: (
      selector: HostedTaskAssignmentCurrentSelector
    ) => Promise<HostedTaskAssignmentCurrentPin | null>;
    currentOwner?: () => OrchestratorLifecycleOwnerBinding | null;
  } = {}
) {
  const resolveCurrent = vi.fn(options.resolve ?? (async () => pin()));
  const authority = new ProductTaskWriteCommitAuthority({
    current: () => ({ resolveCurrent }),
    deploymentId: DEPLOYMENT_ID,
    bootId: BOOT_ID,
    expectedOwner: OWNER,
    currentOwner: options.currentOwner ?? (() => OWNER),
    restoreGeneration: WRITER_EPOCH.restoreGeneration,
    mountGeneration: WRITER_EPOCH.mountGeneration,
  });
  return { authority, resolveCurrent };
}

describe('Product task write commit authority', () => {
  it('checks the signed writer epoch with each request own, possibly rotated, session', async () => {
    const { authority, resolveCurrent } = harness();
    const first = context();
    authority.bind(first, fence());
    await expect(
      authority.assertCurrent(command('update_owner', MEMBER_ID), first)
    ).resolves.toEqual(pin());
    expect(resolveCurrent).toHaveBeenLastCalledWith({
      deploymentId: DEPLOYMENT_ID,
      teamId: TEAM_ID,
      writerEpoch: WRITER_EPOCH,
      requester: {
        workspaceId: PUBLIC_WORKSPACE_ID,
        actorId: ACTOR_ID,
        userId: `usr_${'9'.repeat(32)}`,
        sessionId: `session_${'8'.repeat(32)}`,
        grantRevision: GRANT.grantRevision,
        grantGeneration: WRITER_EPOCH.restoreGeneration,
      },
      identityChecksum: GRANT.identityChecksum,
      target: { kind: 'member', memberId: MEMBER_ID },
    });

    const rotated = context();
    authority.bind(rotated, {
      ...fence(),
      requester: { ...fence().requester!, sessionId: `session_${'6'.repeat(32)}` },
    });
    await authority.assertCurrent(command('update_status'), rotated);
    expect(resolveCurrent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        requester: expect.objectContaining({ sessionId: `session_${'6'.repeat(32)}` }),
        target: { kind: 'none' },
      })
    );
  });

  it('refuses update_relationship before any Product decision', async () => {
    const { authority, resolveCurrent } = harness();
    const query = context();
    authority.bind(query, fence());
    await expect(authority.assertCurrent(command('update_relationship'), query)).rejects.toThrow(
      'hosted-task-write-unavailable'
    );
    expect(resolveCurrent).not.toHaveBeenCalled();
  });

  it('fails closed without requester evidence or a current Product decision', async () => {
    expect(() => harness().authority.bind(context(), fence(false))).toThrow(
      'hosted-task-write-grant-invalid'
    );
    const { authority } = harness({ resolve: async () => null });
    const query = context();
    authority.bind(query, fence());
    await expect(authority.assertCurrent(command('update_details'), query)).rejects.toThrow(
      'hosted-task-write-current-authority-stale'
    );
  });

  it('denies a live Owner binding that differs from the signed writer epoch', async () => {
    let live: OrchestratorLifecycleOwnerBinding | null = OWNER;
    const { authority, resolveCurrent } = harness({ currentOwner: () => live });
    const query = context();
    authority.bind(query, fence());
    await expect(authority.assertCurrent(command('update_status'), query)).resolves.toBeTruthy();
    live = { ...OWNER, ownerGeneration: OWNER.ownerGeneration + 1 };
    await expect(authority.assertCurrent(command('update_status'), query)).rejects.toThrow(
      'hosted-task-write-current-authority-stale'
    );
    expect(resolveCurrent).toHaveBeenCalledOnce();
  });

  it('keeps the pin stable within one request and rejects a changed run or epoch', async () => {
    let current = pin(`run_${'3'.repeat(32)}`);
    const { authority } = harness({ resolve: async () => current });
    const grants = new HostedTaskBoardMutationGrantAuthority(authority);
    const query = context();
    const bound = fence();
    authority.bind(query, bound);
    grants.bind(query, bound);
    await grants.assertCurrent(command('update_status'), query);
    await grants.assertCurrent(command('update_status'), query);
    expect(grants.evidenceFor(query)?.runPin).toEqual(current);

    current = pin(null);
    await expect(grants.assertCurrent(command('update_status'), query)).rejects.toThrow(
      'hosted-task-board-run-pin-stale'
    );
    current = Object.freeze({ ...pin(`run_${'3'.repeat(32)}`), ownerGeneration: 8 });
    await expect(grants.assertCurrent(command('update_status'), query)).rejects.toThrow(
      'hosted-task-board-run-pin-stale'
    );
  });
});
