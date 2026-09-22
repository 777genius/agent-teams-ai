import { parseTeamIdentityRecord } from '@features/internal-storage/contracts';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import {
  HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
  parseHostedMessageId,
  parseHostedMessageSourceGeneration,
} from '@features/team-message-delivery/contracts/hosted';
import {
  GetHostedMessagePage,
  HOSTED_MESSAGE_PAGE_TIMEOUT_MS,
} from '@features/team-message-delivery/core/application/use-cases/GetHostedMessagePage';
import { WorkspaceMountBinding, WorkspaceRegistration } from '@features/workspace-registry';
import {
  createQueryContext,
  parseBootId,
  parseCursor,
  parseDeploymentId,
  parseRevision,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import { HostedTeamInboxAuthority } from '../../../src/features/team-message-delivery/main/composition/AuthorizedHostedTeamMessageAuthority';

import type {
  HostedMessagePageSourcePort,
  HostedMessagePageSourceResult,
} from '@features/team-message-delivery/core/application/ports/HostedTeamMessagePorts';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const revision = parseRevision('revision_page-1');
const sourceGeneration = parseHostedMessageSourceGeneration('generation_page-1');
const replacementGeneration = parseHostedMessageSourceGeneration('generation_page-replacement');
const workspaceId = parseWorkspaceId(`workspace_${'b'.repeat(32)}`);
const foreignWorkspaceId = parseWorkspaceId(`workspace_${'c'.repeat(32)}`);
const bootId = parseBootId('boot_message-page');
const deploymentId = parseDeploymentId('deployment_message-page');

function message(index: number, text = `Message ${index}`) {
  return Object.freeze({
    teamId,
    messageId: parseHostedMessageId(`message_${index.toString(16).padStart(32, '0')}`),
    direction: index % 2 === 0 ? ('team' as const) : ('operator' as const),
    text,
    createdAtMs: index,
  });
}

function context(signal = new AbortController().signal) {
  return createQueryContext({
    actorId: 'actor_message-page',
    sessionId: 'session_message-page',
    deploymentId: 'deployment_message-page',
    bootId: 'boot_message-page',
    requestId: 'request_message-page',
    authorizedScope: 'scope_message-page',
    deadlineAtMs: 10_000,
    signal,
  });
}

function request(
  limit = 2,
  cursor: ReturnType<typeof parseCursor> | null = null,
  generation: typeof sourceGeneration | null = null
) {
  return {
    schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
    teamId,
    cursor,
    expectedSourceGeneration: generation,
    limit,
  };
}

function found(
  candidates: Extract<HostedMessagePageSourceResult, { kind: 'found' }>['candidates'],
  hasMore = false
): Extract<HostedMessagePageSourceResult, { kind: 'found' }> {
  return { kind: 'found', teamId, sourceGeneration, revision, candidates, hasMore };
}

function messageReadHarness(
  mountGeneration: number,
  overrides: {
    readonly bootId?: typeof bootId;
    readonly deploymentId?: typeof deploymentId;
    readonly workspaceId?: typeof workspaceId;
  } = {}
) {
  const runtimeBootId =
    overrides.bootId ?? parseBootId(`boot_message-page-generation-${mountGeneration}`);
  const runtimeDeploymentId = overrides.deploymentId ?? deploymentId;
  const runtimeWorkspaceId = overrides.workspaceId ?? workspaceId;
  const initialIdentity = parseTeamIdentityRecord({
    teamId,
    state: 'active',
    legacyKey: 'message-page-team',
    directoryFingerprint: '1'.repeat(64),
    workspaceBinding: { workspaceId: runtimeWorkspaceId, generation: 1 },
    adoptionIntentId: `adoption_${'2'.repeat(32)}`,
    identityChecksum: '3'.repeat(64),
    createdAt: '2027-01-01T00:00:00.000Z',
    activatedAt: '2027-01-01T00:00:01.000Z',
    tombstonedAt: null,
  });
  let identity = initialIdentity;
  const registration = new WorkspaceRegistration({
    schemaVersion: 1,
    registrationKey: `registration-message-page-${mountGeneration}`,
    workspaceId: runtimeWorkspaceId,
    displayName: 'Message page stable binding',
    registrationRevision: 1,
    declaredRootHash: '4'.repeat(64),
    enabled: true,
  });
  const authority = new HostedTeamInboxAuthority({
    runtimeInstance: createRuntimeInstanceContext({
      deploymentId: runtimeDeploymentId,
      bootId: runtimeBootId,
      claudeRoot: { kind: 'claude', reference: '/runtime/message-page/claude' },
      appDataRoot: { kind: 'app-data', reference: '/runtime/message-page/app-data' },
      workspaceRoots: [{ kind: 'workspace', reference: '/runtime/message-page/workspace' }],
      tempRoot: { kind: 'temp', reference: '/runtime/message-page/temp' },
      logsRoot: { kind: 'logs', reference: '/runtime/message-page/logs' },
    }),
    mountBinding: new WorkspaceMountBinding({
      registration,
      bootId: runtimeBootId,
      mountGeneration,
      previousMountGeneration: mountGeneration === 1 ? undefined : mountGeneration - 1,
      declaredRootHash: registration.declaredRootHash,
      observedAt: 0,
      health: 'read-only',
      allowedOperations: [],
    }),
    teamIdentities: {
      listTeamIdentities: () => Promise.resolve([identity]),
      getTeamIdentity: () => Promise.resolve(identity),
    },
    nowMs: () => 0,
    inboxReader: {
      getMessagesWindow: () =>
        Promise.resolve({
          messages: [
            {
              from: 'team-lead',
              to: 'user',
              text: 'Stable binding message.',
              timestamp: '2027-01-01T00:00:02.000Z',
              read: true,
              messageId: 'stable-binding-message',
              messageKind: 'default' as const,
            },
          ],
          truncated: false,
          sourceRevision: 'stable-binding-message-source',
          sourceMessageCount: 1,
        }),
    },
  });
  const queryContext = () =>
    createQueryContext({
      actorId: 'actor_message-page',
      sessionId: 'session_message-page',
      deploymentId: runtimeDeploymentId,
      bootId: runtimeBootId,
      requestId: 'request_message-page-stable-binding',
      authorizedScope: 'scope_message-page',
      deadlineAtMs: 10_000,
      signal: new AbortController().signal,
    });
  return Object.freeze({
    read: (
      expectedSourceGeneration: ReturnType<typeof parseHostedMessageSourceGeneration> | null = null
    ) =>
      authority.readWindow(
        {
          teamId,
          afterMessageId: null,
          expectedSourceGeneration,
          itemLimit: 25,
          deadlineAtMs: 5_000,
        },
        queryContext()
      ),
    setWorkspaceBinding: (
      nextWorkspaceId: typeof workspaceId | null,
      generation = 1
    ) => {
      identity = parseTeamIdentityRecord({
        ...identity,
        workspaceBinding:
          nextWorkspaceId === null ? null : { workspaceId: nextWorkspaceId, generation },
      });
    },
  });
}

describe('GetHostedMessagePage', () => {
  it.each([
    ['generation 1 startup', 1],
    ['trusted generation 2 restart', 2],
  ] as const)(
    'reads stable generation-1 messages after %s at mount generation %i',
    async (_phase, mountGeneration) => {
      const harness = messageReadHarness(mountGeneration);
      await expect(harness.read()).resolves.toMatchObject({
        kind: 'found',
        messages: [{ text: 'Stable binding message.' }],
      });
    }
  );

  it('rejects a generation-1 expected source generation after a trusted generation-2 restart', async () => {
    const generation1 = await messageReadHarness(1).read();
    expect(generation1.kind).toBe('found');
    if (generation1.kind !== 'found') return;

    const generation2 = await messageReadHarness(2).read(generation1.sourceGeneration);

    expect(generation2).toMatchObject({ kind: 'stale_generation' });
    if (generation2.kind === 'stale_generation') {
      expect(generation2.currentSourceGeneration).not.toBe(generation1.sourceGeneration);
    }
  });

  it('binds source generation independently to deployment, boot, workspace and mount generation', async () => {
    const generation1BootId = parseBootId('boot_message-page-generation-1');
    const generation1 = await messageReadHarness(1, { bootId: generation1BootId }).read();
    expect(generation1.kind).toBe('found');
    if (generation1.kind !== 'found') return;
    const replacements = [
      messageReadHarness(1, {
        bootId: generation1BootId,
        deploymentId: parseDeploymentId('deployment_message-page-replacement'),
      }),
      messageReadHarness(1, { bootId: parseBootId('boot_message-page-replacement') }),
      messageReadHarness(1, {
        bootId: generation1BootId,
        workspaceId: parseWorkspaceId(`workspace_${'d'.repeat(32)}`),
      }),
      messageReadHarness(2, { bootId: generation1BootId }),
    ];

    for (const replacement of replacements) {
      const result = await replacement.read(generation1.sourceGeneration);
      expect(result.kind).toBe('stale_generation');
      if (result.kind === 'stale_generation') {
        expect(result.currentSourceGeneration).not.toBe(generation1.sourceGeneration);
      }
    }
  });

  it('fails closed for message-read binding rollback, same-generation workspace mismatch, and unbound identity', async () => {
    const harness = messageReadHarness(2);
    harness.setWorkspaceBinding(workspaceId, 2);
    await expect(harness.read()).resolves.toMatchObject({ kind: 'found' });

    harness.setWorkspaceBinding(workspaceId, 1);
    await expect(harness.read()).resolves.toEqual({ kind: 'unavailable' });

    harness.setWorkspaceBinding(foreignWorkspaceId, 2);
    await expect(harness.read()).resolves.toEqual({ kind: 'unavailable' });

    harness.setWorkspaceBinding(null);
    await expect(harness.read()).resolves.toEqual({ kind: 'not_found' });
  });

  it('preserves authority cursor order across pages without sorting opaque message IDs', async () => {
    const cursorC = parseCursor('cursor_page-C');
    const cursorA = parseCursor('cursor_page-A');
    const cursorB = parseCursor('cursor_page-B');
    const source: HostedMessagePageSourcePort = {
      readPage: vi.fn((sourceRequest) =>
        Promise.resolve(
          sourceRequest.cursor === null
            ? found([
                { message: message(3), cursorAfter: cursorC },
                { message: message(1), cursorAfter: cursorA },
                { message: message(2), cursorAfter: cursorB },
              ])
            : found([{ message: message(2), cursorAfter: cursorB }])
        )
      ),
    };
    const useCase = new GetHostedMessagePage(source, { now: () => 0 });

    const first = await useCase.execute(request(), context());
    expect(first.kind).toBe('success');
    if (first.kind !== 'success') return;
    expect(first.page.messages.map((item) => item.messageId)).toEqual([
      message(3).messageId,
      message(1).messageId,
    ]);
    expect(first.page.nextCursor).toBe(cursorA);
    expect(source.readPage).toHaveBeenCalledWith(
      {
        teamId,
        cursor: null,
        expectedSourceGeneration: null,
        itemLimit: 3,
        deadlineAtMs: HOSTED_MESSAGE_PAGE_TIMEOUT_MS,
      },
      expect.any(Object)
    );

    const second = await useCase.execute(
      request(2, first.page.nextCursor, first.page.sourceGeneration),
      context()
    );
    expect(second).toMatchObject({ kind: 'success', page: { nextCursor: null } });
    if (second.kind === 'success') {
      expect(
        [...first.page.messages, ...second.page.messages].map((item) => item.messageId)
      ).toEqual([message(3).messageId, message(1).messageId, message(2).messageId]);
    }
  });

  it('fails closed for an invalid continuation or a replacement generation', async () => {
    const cursor = parseCursor('cursor_page-next');
    const source: HostedMessagePageSourcePort = {
      readPage: vi.fn(() =>
        Promise.resolve({
          kind: 'stale_generation' as const,
          currentSourceGeneration: replacementGeneration,
        })
      ),
    };
    const useCase = new GetHostedMessagePage(source, { now: () => 0 });

    await expect(
      useCase.execute(
        request(2, cursor, 'generation/invalid' as typeof sourceGeneration),
        context()
      )
    ).resolves.toEqual({ kind: 'invalid_request' });
    expect(source.readPage).not.toHaveBeenCalled();

    await expect(useCase.execute(request(2, cursor, sourceGeneration), context())).resolves.toEqual(
      {
        kind: 'stale_generation',
        currentSourceGeneration: replacementGeneration,
      }
    );
  });

  it('rejects duplicate cursors, empty progressing pages, and source exceptions', async () => {
    const duplicate = new GetHostedMessagePage(
      {
        readPage: () =>
          Promise.resolve(
            found([
              { message: message(1), cursorAfter: parseCursor('cursor_duplicate') },
              { message: message(2), cursorAfter: parseCursor('cursor_duplicate') },
            ])
          ),
      },
      { now: () => 0 }
    );
    await expect(duplicate.execute(request(), context())).resolves.toEqual({ kind: 'unavailable' });

    const emptyMore = new GetHostedMessagePage(
      { readPage: () => Promise.resolve(found([], true)) },
      { now: () => 0 }
    );
    await expect(emptyMore.execute(request(), context())).resolves.toEqual({ kind: 'unavailable' });

    const throwing = new GetHostedMessagePage(
      { readPage: () => Promise.reject(new Error('private runtime detail')) },
      { now: () => 0 }
    );
    await expect(throwing.execute(request(), context())).resolves.toEqual({ kind: 'unavailable' });
  });

  it('admits a cold page after 2500ms and fails closed at the 5000ms boundary', async () => {
    let nowMs = 0;
    const source: HostedMessagePageSourcePort = {
      readPage: vi.fn(async () => {
        nowMs = 2_500;
        return found([{ message: message(1), cursorAfter: parseCursor('cursor_cold-page') }]);
      }),
    };
    const useCase = new GetHostedMessagePage(source, { now: () => nowMs });

    await expect(useCase.execute(request(), context())).resolves.toMatchObject({
      kind: 'success',
    });

    source.readPage = vi.fn(async () => {
      nowMs = HOSTED_MESSAGE_PAGE_TIMEOUT_MS;
      return found([{ message: message(1), cursorAfter: parseCursor('cursor_boundary') }]);
    });
    nowMs = 0;
    await expect(useCase.execute(request(), context())).resolves.toEqual({ kind: 'unavailable' });
  });
});
