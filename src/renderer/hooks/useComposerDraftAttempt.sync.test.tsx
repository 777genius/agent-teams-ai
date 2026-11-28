import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { buildPreparedSendRequest } from '@renderer/components/team/messages/composerSendUtils';
import {
  acquireComposerSubmission,
  isComposerSubmissionActive,
  releaseComposerSubmission,
  runComposerSubmission,
} from '@renderer/components/team/messages/composerSubmission';
import { useComposerSubmissionFeedback } from '@renderer/components/team/messages/useComposerSubmissionFeedback';
import {
  buildRestoredWorking,
  isComposerRecoveryRecord,
} from '@renderer/services/composerDraftRecovery';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ComposerBeginAttemptResult,
  useComposerDraft,
  type UseComposerDraftResult,
} from './useComposerDraft';

import type { ComposerSubmissionResult } from '@renderer/components/team/messages/composerSubmission';
import type {
  ComposerDraftAddress,
  ComposerDraftContent,
  ComposerDraftRepository,
  ComposerDraftRepositoryEvent,
  ComposerPreparedRequest,
  ComposerRecoveryRecord,
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

function createRepository(initial = working(alice, 'old text', 'old-revision')) {
  const watched = initial.address;
  const records = new Map<ComposerDraftAddress, ComposerWorkingRecord>([
    [watched, initial],
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
  const saveWorking = vi.fn(
    async (
      address: ComposerDraftAddress,
      expectedRevision: string,
      nextRevision: string,
      content: ComposerWorkingRecord['content']
    ) => {
      const current = records.get(address)!;
      if (expectedRevision !== current.workingRevision)
        return {
          kind: 'conflict' as const,
          currentWorkingRevision: current.workingRevision,
          status: 'durable' as const,
        };
      records.set(address, working(address, content?.text ?? '', nextRevision));
      return { kind: 'saved' as const, workingRevision: nextRevision, status: 'durable' as const };
    }
  );
  const displaced: ComposerWorkingRecord[] = [];
  const stashWorking = vi.fn(async (address: ComposerDraftAddress, expectedRevision: string) => {
    const current = records.get(address)!;
    if (current.workingRevision !== expectedRevision)
      return { kind: 'conflict' as const, status: 'durable' as const };
    displaced.push(current);
    const cleared = { ...working(address, '', 'stashed-revision'), content: null };
    records.set(address, cleared);
    listener?.({
      kind: 'working',
      address,
      contextId: address.contextId,
      teamName: address.teamName,
    });
    return { kind: 'restored' as const, working: cleared, status: 'durable' as const };
  });
  const activeAttempts = new Set<string>();
  const setAttemptActive = vi.fn((id: string, active: boolean) => {
    if (active) activeAttempts.add(id);
    else activeAttempts.delete(id);
  });
  const settleAttempt = vi.fn(() => Promise.resolve('durable' as const));
  const repository = {
    async loadWorking(address: ComposerDraftAddress) {
      if (eventLoad && address === watched) await eventLoad;
      return { working: records.get(address)!, status: 'durable' as const };
    },
    beginAttempt,
    saveWorking,
    stashWorking,
    subscribe(callback: (event: ComposerDraftRepositoryEvent) => void) {
      listener = callback;
      return () => {
        listener = null;
      };
    },
    isAttemptActive: (id: string) => activeAttempts.has(id),
    setAttemptActive,
    settleAttempt,
  } as unknown as ComposerDraftRepository;
  return {
    repository,
    beginAttempt,
    setAttemptActive,
    settleAttempt,
    saveWorking,
    stashWorking,
    displaced,
    setWorkingText(text: string, revision: string) {
      records.set(watched, working(watched, text, revision));
    },
    pauseLoads(load: Promise<void>) {
      eventLoad = load;
    },
    updateWhileLoadPending(
      load: Promise<void>,
      next = working(watched, 'synced text', 'new-revision')
    ) {
      records.set(watched, next);
      eventLoad = load;
      listener?.({
        kind: 'working',
        address: watched,
        contextId: watched.contextId,
        teamName: watched.teamName,
      });
    },
  };
}

const Harness = ({
  address,
  repository,
  onValue,
  onFeedback,
}: {
  address: ComposerDraftAddress;
  repository: ComposerDraftRepository;
  onValue: (value: UseComposerDraftResult) => void;
  onFeedback?: (value: ReturnType<typeof useComposerSubmissionFeedback>) => void;
}): null => {
  const draft = useComposerDraft(address, repository);
  const feedback = useComposerSubmissionFeedback(
    JSON.stringify(address),
    undefined,
    undefined,
    undefined
  );
  onValue(draft);
  onFeedback?.(feedback);
  return null;
};

describe('useComposerDraftAttempt working-event sync', () => {
  beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it.each([false, true])(
    'settles a restored Goal after pending sync without replacing its original: changed=%s',
    async (changed) => {
      const address: ComposerDraftAddress = {
        ...alice,
        teamName: 'host-team:TEST-goal',
        target: { kind: 'direct', participant: 'lead' },
      };
      const originalMessageId = 'TEST-original-goal';
      const original: Extract<ComposerPreparedRequest, { kind: 'local' }> = {
        kind: 'local',
        teamName: address.teamName,
        request: {
          member: 'lead',
          text: 'TEST original objective',
          summary: 'TEST original summary',
          actionMode: 'do',
          messageId: originalMessageId,
          autonomousGoal: { durationHours: 12, maxAttempts: 100 },
          taskRefs: [{ taskId: 'TEST-original-task', displayId: '7', teamName: address.teamName }],
        },
      };
      const content: ComposerDraftContent = {
        text: original.request.text,
        chips: [],
        attachments: [],
        actionMode: 'do',
        autonomousGoal: original.request.autonomousGoal,
        restoredOrigin: {
          kind: 'unconfirmed-send',
          attemptId: 'TEST-original-attempt',
          messageId: original.request.messageId,
          autonomousGoalRequest: original,
        },
      };
      const initial = { ...working(address, content.text, 'goal-original'), content };
      const fixture = createRepository(initial);
      const root = createRoot(document.createElement('div'));
      let draft!: UseComposerDraftResult;
      let feedback!: ReturnType<typeof useComposerSubmissionFeedback>;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await act(async () =>
          root.render(
            <Harness
              address={address}
              repository={fixture.repository}
              onValue={(value) => {
                draft = value;
              }}
              onFeedback={(value) => {
                feedback = value;
              }}
            />
          )
        );
        const next: ComposerWorkingRecord = {
          ...initial,
          workingRevision: 'goal-synced',
          content: { ...content, text: changed ? 'TEST changed objective' : content.text },
        };
        act(() => fixture.updateWhileLoadPending(gate, next));
        expect(draft.canSubmit).toBe(true);
        const attemptId = 'TEST-restored-ui-' + changed;
        const current = vi.fn(() => true);
        const transport = vi.fn((_prepared: ComposerBeginAttemptResult) =>
          Promise.resolve({ deliveredToInbox: true, messageId: originalMessageId })
        );
        const submission = runComposerSubmission({
          attemptId,
          contextId: address.contextId,
          repository: fixture.repository,
          isContextCurrent: current,
          prepare: () =>
            draft.beginAttempt(attemptId, ({ content: snapshot }) =>
              buildPreparedSendRequest({
                attemptId,
                originalGoalRequest: snapshot.restoredOrigin?.autonomousGoalRequest,
                teamName: address.teamName,
                selectedTeam: null,
                lockedRecipient: 'lead',
                crossTeamRecipient: null,
                localRecipient: 'lead',
                text: snapshot.text,
                summary: 'TEST current summary',
                attachments: snapshot.attachments,
                actionMode: snapshot.actionMode,
                autonomousGoal: snapshot.autonomousGoal,
                taskRefs: [],
              })
            ),
          transport,
        });
        expect(fixture.beginAttempt).not.toHaveBeenCalled();
        expect(fixture.settleAttempt).not.toHaveBeenCalled();
        expect(current).not.toHaveBeenCalled();
        expect(transport).not.toHaveBeenCalled();
        expect(fixture.repository.isAttemptActive(attemptId)).toBe(true);
        expect(isComposerSubmissionActive(attemptId)).toBe(true);
        let result!: ComposerSubmissionResult;
        await act(async () => {
          release();
          result = await submission;
          feedback.record(JSON.stringify(address), result);
        });
        if (changed) {
          const detail = 'Restore the unchanged original request to check its delivery.';
          expect(result).toEqual({ kind: 'not-sent', attemptId, detail });
          expect(feedback.submissionError).toBe(detail);
          expect(fixture.beginAttempt).not.toHaveBeenCalled();
          expect(fixture.settleAttempt).not.toHaveBeenCalled();
          expect(current).not.toHaveBeenCalled();
          expect(transport).not.toHaveBeenCalled();
          expect((await fixture.repository.loadWorking(address)).working).toEqual(next);
          expect(draft.snapshot().restoredOrigin?.autonomousGoalRequest).toEqual(original);
        } else {
          expect(result).toEqual({
            kind: 'accepted',
            attemptId,
            messageId: original.request.messageId,
          });
          expect(feedback.submissionError).toBeNull();
          expect(fixture.beginAttempt).toHaveBeenCalledTimes(1);
          expect(transport).toHaveBeenCalledTimes(1);
          const call = transport.mock.calls[0];
          if (!call) throw new Error('TEST missing captured transport');
          const prepared = call[0].attempt.preparedRequest;
          expect(prepared).toEqual(original);
          expect(prepared).not.toBe(original);
          expect(fixture.settleAttempt).toHaveBeenCalledWith(address, attemptId, {
            kind: 'accepted',
            messageId: original.request.messageId,
          });
        }
        expect(fixture.repository.isAttemptActive(attemptId)).toBe(false);
        expect(isComposerSubmissionActive(attemptId)).toBe(false);
        expect(fixture.setAttemptActive).toHaveBeenLastCalledWith(
          attemptId,
          false,
          changed ? undefined : address
        );
        const nextAttempt = attemptId + '-next';
        expect(acquireComposerSubmission(address.contextId, nextAttempt)).toBe(true);
        releaseComposerSubmission(address.contextId, nextAttempt);
      } finally {
        release();
        act(() => root.unmount());
      }
    }
  );

  it.each([false, true])(
    'keeps ordinary cross-Team identity and refuses a displaced Goal arriving during sync: goal=%s',
    async (withGoal) => {
      const source: ComposerDraftAddress = {
        ...alice,
        teamName: 'host-team:TEST-source',
        target: { kind: 'direct', participant: 'lead' },
      };
      const target = 'host-team:TEST-target';
      const address: ComposerDraftAddress = {
        ...source,
        target: { kind: 'cross-team', toTeam: target, toMember: null },
      };
      const displaced: ComposerRecoveryRecord = {
        version: 2,
        id: 'TEST-displaced-draft',
        address: source,
        snapshot: {
          content: {
            text: 'TEST cross-Team message',
            chips: [],
            attachments: [],
            actionMode: 'do',
            ...(withGoal ? { autonomousGoal: { durationHours: 12, maxAttempts: 100 } } : {}),
          },
          editorContext: { kind: 'plain' },
        },
        preparedRequest: {
          kind: 'local',
          teamName: source.teamName,
          request: { member: '', text: '' },
        },
        reason: 'displaced-draft',
        createdAt: 1,
        updatedAt: 1,
      };
      expect(isComposerRecoveryRecord(displaced)).toBe(true);
      const restored = buildRestoredWorking(displaced, address, 'cross-synced', true);
      expect(restored.kind).toBe('working');
      if (restored.kind !== 'working') throw new Error('TEST expected restored working draft');
      expect(restored.working.content?.restoredOrigin).toBeUndefined();
      const fixture = createRepository(working(address, 'TEST before sync', 'cross-original'));
      const root = createRoot(document.createElement('div'));
      let draft!: UseComposerDraftResult;
      let feedback!: ReturnType<typeof useComposerSubmissionFeedback>;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await act(async () =>
          root.render(
            <Harness
              address={address}
              repository={fixture.repository}
              onValue={(value) => {
                draft = value;
              }}
              onFeedback={(value) => {
                feedback = value;
              }}
            />
          )
        );
        act(() => fixture.updateWhileLoadPending(gate, restored.working));
        expect(draft.canSubmit).toBe(true);
        const attemptId = 'TEST-cross-ui-' + withGoal;
        const current = vi.fn(() => true);
        const transport = vi.fn((_prepared: ComposerBeginAttemptResult) =>
          Promise.resolve({ deliveredToInbox: true, messageId: attemptId })
        );
        const submission = runComposerSubmission({
          attemptId,
          contextId: address.contextId,
          repository: fixture.repository,
          isContextCurrent: current,
          prepare: () =>
            draft.beginAttempt(attemptId, ({ content }) =>
              buildPreparedSendRequest({
                attemptId,
                teamName: address.teamName,
                selectedTeam: target,
                crossTeamRecipient: null,
                localRecipient: 'lead',
                text: content.text,
                summary: content.text,
                attachments: content.attachments,
                actionMode: content.actionMode,
                autonomousGoal: content.autonomousGoal,
                taskRefs: [],
              })
            ),
          transport,
        });
        expect(fixture.beginAttempt).not.toHaveBeenCalled();
        expect(fixture.settleAttempt).not.toHaveBeenCalled();
        expect(current).not.toHaveBeenCalled();
        expect(transport).not.toHaveBeenCalled();
        expect(fixture.repository.isAttemptActive(attemptId)).toBe(true);
        expect(isComposerSubmissionActive(attemptId)).toBe(true);
        let result!: ComposerSubmissionResult;
        await act(async () => {
          release();
          result = await submission;
          feedback.record(JSON.stringify(address), result);
        });
        if (withGoal) {
          const detail = 'Goal requires a direct lead message';
          expect(result).toEqual({ kind: 'not-sent', attemptId, detail });
          expect(feedback.submissionError).toBe(detail);
          expect(fixture.beginAttempt).not.toHaveBeenCalled();
          expect(fixture.settleAttempt).not.toHaveBeenCalled();
          expect(current).not.toHaveBeenCalled();
          expect(transport).not.toHaveBeenCalled();
          expect((await fixture.repository.loadWorking(address)).working).toEqual(restored.working);
        } else {
          expect(result).toEqual({ kind: 'accepted', attemptId, messageId: attemptId });
          expect(feedback.submissionError).toBeNull();
          expect(fixture.beginAttempt).toHaveBeenCalledTimes(1);
          expect(transport).toHaveBeenCalledTimes(1);
          const call = transport.mock.calls[0];
          if (!call) throw new Error('TEST missing captured transport');
          expect(call[0].attempt.preparedRequest).toEqual({
            kind: 'cross-team',
            request: {
              fromTeam: address.teamName,
              fromMember: 'user',
              toTeam: target,
              text: 'TEST cross-Team message',
              summary: 'TEST cross-Team message',
              actionMode: 'do',
              taskRefs: [],
              messageId: attemptId,
            },
          });
          expect(fixture.settleAttempt).toHaveBeenCalledWith(address, attemptId, {
            kind: 'accepted',
            messageId: attemptId,
          });
        }
        expect(fixture.repository.isAttemptActive(attemptId)).toBe(false);
        expect(isComposerSubmissionActive(attemptId)).toBe(false);
        expect(fixture.setAttemptActive).toHaveBeenLastCalledWith(
          attemptId,
          false,
          withGoal ? undefined : address
        );
        const nextAttempt = attemptId + '-next';
        expect(acquireComposerSubmission(address.contextId, nextAttempt)).toBe(true);
        releaseComposerSubmission(address.contextId, nextAttempt);
      } finally {
        release();
        act(() => root.unmount());
      }
    }
  );

  it('preserves an unrelated preparation error even when its message matches a policy refusal', async () => {
    const fixture = createRepository();
    const attemptId = 'TEST-unexpected-prepare';
    const error = new Error('Restore the unchanged original request to check its delivery.');
    const current = vi.fn(() => true);
    const transport = vi.fn(() => Promise.resolve(null));
    await expect(
      runComposerSubmission({
        attemptId,
        contextId: alice.contextId,
        repository: fixture.repository,
        prepare: () => Promise.reject(error),
        isContextCurrent: current,
        transport,
      })
    ).rejects.toBe(error);
    expect(fixture.beginAttempt).not.toHaveBeenCalled();
    expect(fixture.settleAttempt).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(fixture.repository.isAttemptActive(attemptId)).toBe(false);
    expect(isComposerSubmissionActive(attemptId)).toBe(false);
    expect(fixture.setAttemptActive).toHaveBeenCalledWith(attemptId, true);
    expect(fixture.setAttemptActive).toHaveBeenLastCalledWith(attemptId, false, undefined);
    const nextAttempt = attemptId + '-next';
    expect(acquireComposerSubmission(alice.contextId, nextAttempt)).toBe(true);
    releaseComposerSubmission(alice.contextId, nextAttempt);
  });

  it('captures goal limits once and clears the opt-in for the next message', async () => {
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
    try {
      act(() => draft.setAutonomousGoal({ durationHours: 12, maxAttempts: 100 }));
      await act(async () => {
        await draft.beginAttempt('TEST-goal-intake', (snapshot) => ({
          kind: 'local',
          teamName: alice.teamName,
          request: {
            member: 'alice',
            text: snapshot.content.text,
            autonomousGoal: snapshot.content.autonomousGoal,
            messageId: 'TEST-goal-intake',
          },
        }));
      });
      expect(fixture.beginAttempt).toHaveBeenCalledWith(
        alice,
        'old-revision',
        expect.objectContaining({
          snapshot: expect.objectContaining({
            content: expect.objectContaining({
              autonomousGoal: { durationHours: 12, maxAttempts: 100 },
            }),
          }),
          preparedRequest: expect.objectContaining({
            request: expect.objectContaining({
              autonomousGoal: { durationHours: 12, maxAttempts: 100 },
              messageId: 'TEST-goal-intake',
            }),
          }),
        })
      );
      expect(draft.autonomousGoal).toBeUndefined();
      expect(draft.text).toBe('');
      expect(draft.snapshot()).not.toHaveProperty('autonomousGoal');
    } finally {
      act(() => root.unmount());
    }
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

  it('saves a local edit against the peer revision while stale attempt resync is pending', async () => {
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
    fixture.pauseLoads(
      new Promise<void>((resolve) => {
        finishLoad = resolve;
      })
    );
    fixture.beginAttempt.mockImplementationOnce(async () => {
      fixture.setWorkingText('peer text', 'peer-revision');
      return {
        kind: 'prepared',
        workingCleared: false,
        currentWorkingRevision: 'peer-revision',
        status: 'durable',
      };
    });
    const transport = vi.fn();
    const submission = runComposerSubmission({
      attemptId: 'stale-attempt-local-edit',
      contextId: alice.contextId,
      repository: fixture.repository,
      isContextCurrent: () => true,
      prepare: () =>
        draft.beginAttempt('stale-attempt-local-edit', (snapshot) => ({
          kind: 'local',
          teamName: alice.teamName,
          request: { member: 'alice', text: snapshot.content.text },
        })),
      transport,
    });
    await act(async () => {
      await vi.waitFor(() => expect(fixture.beginAttempt).toHaveBeenCalledTimes(1));
    });
    act(() => draft.setText('my local edit'));
    finishLoad();
    await act(async () => {
      await submission;
      await draft.flush();
    });
    expect(transport).not.toHaveBeenCalled();
    expect(draft.text).toBe('my local edit');
    expect(fixture.saveWorking).toHaveBeenCalledWith(
      alice,
      'stashed-revision',
      expect.any(String),
      expect.objectContaining({ text: 'my local edit' }),
      expect.anything()
    );
    await expect(fixture.saveWorking.mock.results.at(-1)?.value).resolves.toMatchObject({
      kind: 'saved',
    });
    expect(fixture.stashWorking).toHaveBeenCalledWith(
      alice,
      'peer-revision',
      expect.stringMatching(/^displaced-/)
    );
    expect(fixture.displaced).toEqual([
      expect.objectContaining({ content: expect.objectContaining({ text: 'peer text' }) }),
    ]);
    act(() => root.unmount());
  });
});
