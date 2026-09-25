import { HostedTaskBoardMutationGrantAuthority } from '@main/composition/hosted/hostedTaskBoardMutationGrantAuthority';
import {
  ProductTaskWriteCommitAuthority,
  productTaskWriteTarget,
} from '@main/composition/hosted/productTaskWriteCommitAuthority';
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

function context(signal = new AbortController().signal) {
  return createQueryContext({
    actorId: ACTOR_ID,
    sessionId: 'session_product-task-write',
    deploymentId: DEPLOYMENT_ID,
    bootId: BOOT_ID,
    requestId: 'request_product-task-write',
    authorizedScope: 'scope_product-task-write',
    deadlineAtMs: Date.now() + 60_000,
    signal,
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
    gateway?: boolean;
  } = {}
) {
  const resolveCurrent = vi.fn(options.resolve ?? (async () => pin()));
  const authority = new ProductTaskWriteCommitAuthority({
    current: () => (options.gateway === false ? null : { resolveCurrent }),
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
  it.each([
    ['create_task', null, { kind: 'none' }],
    ['create_task', MEMBER_ID, { kind: 'member', memberId: MEMBER_ID }],
    ['update_details', undefined, { kind: 'none' }],
    ['update_owner', null, { kind: 'none' }],
    ['update_owner', MEMBER_ID, { kind: 'member', memberId: MEMBER_ID }],
    ['update_status', undefined, { kind: 'none' }],
    ['move_task', undefined, { kind: 'none' }],
    ['reorder_column', undefined, { kind: 'none' }],
    ['update_relationship', undefined, null],
  ] as const)('maps %s (owner %s) to its Product currency target', (kind, ownerId, target) => {
    expect(productTaskWriteTarget(command(kind, ownerId))).toEqual(target);
  });

  it('builds one selector from the launcher-signed writer epoch and the live requester', async () => {
    const { authority, resolveCurrent } = harness();
    const query = context();
    authority.bind(query, fence());
    await expect(
      authority.assertCurrent(command('update_owner', MEMBER_ID), query)
    ).resolves.toEqual(pin());
    expect(resolveCurrent).toHaveBeenCalledWith({
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

  it('is unavailable without a bound fence, requester evidence, gateway, or live signal', async () => {
    const unbound = harness();
    await expect(
      unbound.authority.assertCurrent(command('update_status'), context())
    ).rejects.toThrow('hosted-task-write-unavailable');

    expect(() => harness().authority.bind(context(), fence(false))).toThrow(
      'hosted-task-write-grant-invalid'
    );
    expect(() =>
      harness().authority.bind(context(), {
        ...fence(),
        ownerEffectFence: { ...GRANT, runPin: pin() } as never,
      })
    ).toThrow('hosted-task-write-grant-invalid');

    const noGateway = harness({ gateway: false });
    const query = context();
    noGateway.authority.bind(query, fence());
    await expect(noGateway.authority.assertCurrent(command('move_task'), query)).rejects.toThrow(
      'hosted-task-write-unavailable'
    );

    const controller = new AbortController();
    const aborted = harness();
    const abortedQuery = context(controller.signal);
    aborted.authority.bind(abortedQuery, fence());
    controller.abort();
    await expect(
      aborted.authority.assertCurrent(command('update_status'), abortedQuery)
    ).rejects.toThrow('hosted-task-write-unavailable');
    expect(aborted.resolveCurrent).not.toHaveBeenCalled();
  });

  it('treats an abort during the Product decision as stale', async () => {
    const controller = new AbortController();
    const { authority } = harness({
      resolve: async () => {
        controller.abort();
        return pin();
      },
    });
    const query = context(controller.signal);
    authority.bind(query, fence());
    await expect(authority.assertCurrent(command('update_status'), query)).rejects.toThrow(
      'hosted-task-write-current-authority-stale'
    );
  });

  it('denies a live Owner binding that differs from the signed writer epoch', async () => {
    let live: OrchestratorLifecycleOwnerBinding | null = OWNER;
    const { authority, resolveCurrent } = harness({ currentOwner: () => live });
    const query = context();
    authority.bind(query, fence());
    await expect(authority.assertCurrent(command('update_status'), query)).resolves.toBeTruthy();
    live = null;
    await expect(authority.assertCurrent(command('update_status'), query)).resolves.toBeTruthy();
    live = { ...OWNER, ownerGeneration: OWNER.ownerGeneration + 1 };
    await expect(authority.assertCurrent(command('update_status'), query)).rejects.toThrow(
      'hosted-task-write-current-authority-stale'
    );
    expect(resolveCurrent).toHaveBeenCalledTimes(2);
  });

  it('denies a null Product decision', async () => {
    const { authority } = harness({ resolve: async () => null });
    const query = context();
    authority.bind(query, fence());
    await expect(authority.assertCurrent(command('update_details'), query)).rejects.toThrow(
      'hosted-task-write-current-authority-stale'
    );
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
