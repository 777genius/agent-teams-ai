import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { runComposerSubmission } from '@renderer/components/team/messages/composerSubmission';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useComposerDraft, type UseComposerDraftResult } from './useComposerDraft';

import type {
  ComposerDraftAddress,
  ComposerDraftRepository,
  ComposerDraftRepositoryEvent,
  ComposerWorkingRecord,
  PreparedComposerAttempt,
} from '@renderer/types/composerDraft';

const alice: ComposerDraftAddress = {
  contextId: 'context-a',
  teamName: 'team-a',
  target: { kind: 'direct', participant: 'alice' },
};
const bob: ComposerDraftAddress = {
  ...alice,
  target: { kind: 'direct', participant: 'bob' },
};

function working(
  address: ComposerDraftAddress,
  text: string,
  revision: string
): ComposerWorkingRecord {
  return {
    version: 2,
    address,
    workingRevision: revision,
    content: { text, chips: [], attachments: [], actionMode: 'do' },
    editorContext: { kind: 'plain' },
    updatedAt: 1,
  };
}

function createRepository() {
  const records = new Map<ComposerDraftAddress, ComposerWorkingRecord>([
    [alice, working(alice, 'old text', 'old-revision')],
    [bob, working(bob, 'bob text', 'bob-revision')],
  ]);
  let listener: ((event: ComposerDraftRepositoryEvent) => void) | null = null;
  let eventLoad: Promise<void> | null = null;
  const beginAttempt = vi.fn(
    async (
      _address: ComposerDraftAddress,
      _revision: string,
      _attempt: PreparedComposerAttempt
    ) => ({
      kind: 'prepared' as const,
      workingCleared: true,
      currentWorkingRevision: 'new-revision',
      status: 'durable' as const,
    })
  );
  const repository = {
    async loadWorking(address: ComposerDraftAddress) {
      if (eventLoad && address === alice) await eventLoad;
      return { working: records.get(address)!, status: 'durable' as const };
    },
    beginAttempt,
    subscribe(callback: (event: ComposerDraftRepositoryEvent) => void) {
      listener = callback;
      return () => {
        listener = null;
      };
    },
    isAttemptActive: () => false,
    setAttemptActive: () => undefined,
    settleAttempt: async () => 'durable' as const,
  } as unknown as ComposerDraftRepository;
  return {
    repository,
    beginAttempt,
    setWorkingText(text: string, revision: string) {
      records.set(alice, working(alice, text, revision));
    },
    updateWhileLoadPending(load: Promise<void>) {
      records.set(alice, working(alice, 'synced text', 'new-revision'));
      eventLoad = load;
      listener?.({
        kind: 'working',
        address: alice,
        contextId: alice.contextId,
        teamName: alice.teamName,
      });
    },
  };
}

const Harness = ({
  address,
  repository,
  onValue,
}: {
  address: ComposerDraftAddress;
  repository: ComposerDraftRepository;
  onValue: (value: UseComposerDraftResult) => void;
}): null => {
  onValue(useComposerDraft(address, repository));
  return null;
};

describe('useComposerDraftAttempt working-event sync', () => {
  beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('prepares and transports the same post-sync draft while an event load is pending', async () => {
    const fixture = createRepository();
    const root = createRoot(document.createElement('div'));
    let draft!: UseComposerDraftResult;
    await act(async () =>
      root.render(
        <Harness
          address={alice}
          repository={fixture.repository}
          onValue={(value) => {
            draft = value;
          }}
        />
      )
    );
    let finishLoad!: () => void;
    const load = new Promise<void>((resolve) => {
      finishLoad = resolve;
    });
    act(() => fixture.updateWhileLoadPending(load));
    const transported: string[] = [];
    const submission = runComposerSubmission({
      attemptId: 'pending-sync',
      contextId: alice.contextId,
      repository: fixture.repository,
      isContextCurrent: () => true,
      prepare: () =>
        draft.beginAttempt('pending-sync', (snapshot) => ({
          kind: 'local',
          teamName: alice.teamName,
          request: { member: 'alice', text: snapshot.content.text },
        })),
      transport: async ({ attempt }) => {
        expect(attempt.preparedRequest.kind).toBe('local');
        if (attempt.preparedRequest.kind === 'local')
          transported.push(attempt.preparedRequest.request.text);
        return { deliveredToInbox: true, messageId: 'message-1' };
      },
    });
    expect(fixture.beginAttempt).not.toHaveBeenCalled();
    finishLoad();
    await act(async () => {
      await submission;
    });
    expect(fixture.beginAttempt).toHaveBeenCalledWith(
      alice,
      'new-revision',
      expect.objectContaining({
        snapshot: expect.objectContaining({
          content: expect.objectContaining({ text: 'synced text' }),
        }),
        preparedRequest: expect.objectContaining({
          request: expect.objectContaining({ text: 'synced text' }),
        }),
      })
    );
    expect(transported).toEqual(['synced text']);
    act(() => root.unmount());
  });

  it('does not prepare the old address after navigation during the pending sync', async () => {
    const fixture = createRepository();
    const root = createRoot(document.createElement('div'));
    let draft!: UseComposerDraftResult;
    const render = (address: ComposerDraftAddress) =>
      root.render(
        <Harness
          address={address}
          repository={fixture.repository}
          onValue={(value) => {
            draft = value;
          }}
        />
      );
    await act(async () => render(alice));
    let finishLoad!: () => void;
    const load = new Promise<void>((resolve) => {
      finishLoad = resolve;
    });
    act(() => fixture.updateWhileLoadPending(load));
    const begin = draft.beginAttempt('old-address', {
      kind: 'local',
      teamName: alice.teamName,
      request: { member: 'alice', text: 'old text' },
    });
    await act(async () => render(bob));
    finishLoad();
    await expect(begin).resolves.toBeNull();
    expect(fixture.beginAttempt).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('resynchronizes the newer draft when beginAttempt cannot clear its stale revision', async () => {
    const fixture = createRepository();
    const root = createRoot(document.createElement('div'));
    let draft!: UseComposerDraftResult;
    await act(async () =>
      root.render(
        <Harness
          address={alice}
          repository={fixture.repository}
          onValue={(value) => {
            draft = value;
          }}
        />
      )
    );
    fixture.beginAttempt.mockImplementationOnce(async () => {
      fixture.setWorkingText('newer text', 'newer-revision');
      return {
        kind: 'prepared',
        workingCleared: false,
        currentWorkingRevision: 'newer-revision',
        status: 'durable',
      };
    });
    const transport = vi.fn(async () => ({ deliveredToInbox: true, messageId: 'sent' }));
    const submit = (attemptId: string) =>
      runComposerSubmission({
        attemptId,
        contextId: alice.contextId,
        repository: fixture.repository,
        isContextCurrent: () => true,
        prepare: () =>
          draft.beginAttempt(attemptId, (snapshot) => ({
            kind: 'local',
            teamName: alice.teamName,
            request: { member: 'alice', text: snapshot.content.text },
          })),
        transport,
      });
    let first!: Awaited<ReturnType<typeof submit>>;
    await act(async () => {
      first = await submit('stale-attempt');
    });
    expect(first.kind).toBe('not-sent');
    expect(transport).not.toHaveBeenCalled();
    expect(draft.text).toBe('newer text');
    await act(async () => {
      await submit('fresh-attempt');
    });
    expect(fixture.beginAttempt).toHaveBeenLastCalledWith(
      alice,
      'newer-revision',
      expect.objectContaining({
        snapshot: expect.objectContaining({
          content: expect.objectContaining({ text: 'newer text' }),
        }),
      })
    );
    expect(transport).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });
});
