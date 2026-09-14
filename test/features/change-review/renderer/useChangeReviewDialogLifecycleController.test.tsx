import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
  createReviewOperationScopeToken,
  useChangeReviewDialogLifecycleController,
} from '@features/change-review/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ChangeReviewDialogLifecycleCommandPort,
  ChangeReviewDialogLifecycleController,
  ChangeReviewDialogLifecycleDecisionPersistencePort,
  ChangeReviewDialogLifecycleDraftHistoryPort,
  ChangeReviewDialogLifecycleEditorPort,
  ChangeReviewDialogLifecycleSessionPort,
  ChangeReviewDialogLifecycleStatePort,
  ChangeReviewDialogLifecycleStateSnapshot,
  ChangeReviewDialogLifecycleStatusPort,
  ChangeReviewDialogLifecycleWriteEvidencePort,
  RegisterChangeReviewAppCloseParticipant,
  RegisterChangeReviewLifecycleOwner,
} from '@features/change-review/renderer';
import type { ApplyReviewResult, RetryReviewMutationRecoveryResult } from '@shared/types';

type ControllerInput = Parameters<typeof useChangeReviewDialogLifecycleController>[0];
type RegisteredAppCloseParticipant = Parameters<RegisterChangeReviewAppCloseParticipant>[1];

function successfulApply(input: Partial<ApplyReviewResult> = {}): ApplyReviewResult {
  return { applied: 1, skipped: 0, conflicts: 0, errors: [], ...input };
}

function successfulRecovery(): RetryReviewMutationRecoveryResult {
  return {
    decisionRevision: 5,
    recoveredMutation: true,
    recoveredRestoreHistory: false,
    differentMutationPending: false,
    persistedState: null,
    expectedRestoreCompleted: false,
    diskPostimages: [{ filePath: '/repo/a.ts', content: 'after' }],
    retried: true,
  };
}

function createHarness() {
  const events: string[] = [];
  const mutable = {
    current: true,
    pendingApplyCleanupKey: null as string | null,
    expectedHydrationKey: 'hydration-a',
    appCloseParticipant: null as RegisteredAppCloseParticipant | null,
  };
  const operationScope = createReviewOperationScopeToken('hydration-a');
  const snapshot: ChangeReviewDialogLifecycleStateSnapshot = {
    editedContents: {},
    hunkDecisions: {},
    fileDecisions: {},
    reviewActionHistory: [],
    reviewRedoHistory: [],
    fileContents: {},
    fileChunkCounts: {},
    decisionHydrationScopeKey: 'hydration-a',
    decisionHydrationStatus: 'loaded',
    applying: false,
  };
  const statePort: ChangeReviewDialogLifecycleStatePort = {
    getSnapshot: vi.fn<ChangeReviewDialogLifecycleStatePort['getSnapshot']>(() => snapshot),
    reportError: vi.fn<ChangeReviewDialogLifecycleStatePort['reportError']>((message) => {
      events.push(`error:${message}`);
    }),
    completeSavedStateDiscard:
      vi.fn<ChangeReviewDialogLifecycleStatePort['completeSavedStateDiscard']>(),
  };
  const commandPort: ChangeReviewDialogLifecycleCommandPort = {
    resetAllReviewState: vi.fn<ChangeReviewDialogLifecycleCommandPort['resetAllReviewState']>(
      () => {
        events.push('reset');
      }
    ),
    clearChangeReviewCache:
      vi.fn<ChangeReviewDialogLifecycleCommandPort['clearChangeReviewCache']>(),
    fetchAgentChanges: vi.fn<ChangeReviewDialogLifecycleCommandPort['fetchAgentChanges']>(),
    fetchTaskChanges: vi.fn<ChangeReviewDialogLifecycleCommandPort['fetchTaskChanges']>(),
    hydrateDecisions: vi.fn<ChangeReviewDialogLifecycleCommandPort['hydrateDecisions']>(() => {
      events.push('hydrate');
      return Promise.resolve();
    }),
    clearDecisions: vi.fn<ChangeReviewDialogLifecycleCommandPort['clearDecisions']>(() => {
      events.push('clear-decisions');
      return Promise.resolve(true);
    }),
    applyReview: vi.fn<ChangeReviewDialogLifecycleCommandPort['applyReview']>(() => {
      events.push('apply-review');
      return Promise.resolve({
        status: 'applied',
        result: successfulApply({
          diskPostimages: [{ filePath: '/repo/a.ts', content: 'after' }],
        }),
      });
    }),
    retryMutationRecovery: vi.fn<ChangeReviewDialogLifecycleCommandPort['retryMutationRecovery']>(
      () => {
        events.push('retry-recovery');
        return Promise.resolve(successfulRecovery());
      }
    ),
  };
  const editorPort: ChangeReviewDialogLifecycleEditorPort = {
    captureDraftSnapshots: vi.fn<ChangeReviewDialogLifecycleEditorPort['captureDraftSnapshots']>(
      () => {
        events.push('capture-drafts');
      }
    ),
  };
  const statusPort: ChangeReviewDialogLifecycleStatusPort = {
    getActionLockState: vi.fn<ChangeReviewDialogLifecycleStatusPort['getActionLockState']>(
      (applying) => ({
        applying,
        fileApplyCount: 0,
        undoing: false,
        closing: false,
      })
    ),
    beginClosing: vi.fn<ChangeReviewDialogLifecycleStatusPort['beginClosing']>(() => {
      events.push('begin-closing');
    }),
    finishClosing: vi.fn<ChangeReviewDialogLifecycleStatusPort['finishClosing']>(() => {
      events.push('finish-closing');
    }),
    setRecoveryInFlight: vi.fn<ChangeReviewDialogLifecycleStatusPort['setRecoveryInFlight']>(
      (value) => {
        events.push(`recovery:${String(value)}`);
      }
    ),
  };
  const sessionPort: ChangeReviewDialogLifecycleSessionPort = {
    getPendingApplyCleanupKey: vi.fn<
      ChangeReviewDialogLifecycleSessionPort['getPendingApplyCleanupKey']
    >(() => mutable.pendingApplyCleanupKey),
    setPendingApplyCleanupKey: vi.fn<
      ChangeReviewDialogLifecycleSessionPort['setPendingApplyCleanupKey']
    >((key) => {
      mutable.pendingApplyCleanupKey = key;
      events.push(`pending:${key ?? 'null'}`);
    }),
    isExpectedHydrationKey: vi.fn<ChangeReviewDialogLifecycleSessionPort['isExpectedHydrationKey']>(
      (hydrationKey) => hydrationKey === mutable.expectedHydrationKey
    ),
  };
  const writeEvidencePort: ChangeReviewDialogLifecycleWriteEvidencePort = {
    markCommittedPostimages: vi.fn<
      ChangeReviewDialogLifecycleWriteEvidencePort['markCommittedPostimages']
    >(() => {
      events.push('mark-postimages');
    }),
  };
  const decisionPersistence: ChangeReviewDialogLifecycleDecisionPersistencePort = {
    flushForClose: vi.fn<ChangeReviewDialogLifecycleDecisionPersistencePort['flushForClose']>(
      () => {
        events.push('flush-decisions');
        return Promise.resolve(true);
      }
    ),
    getDiagnostics: vi.fn<ChangeReviewDialogLifecycleDecisionPersistencePort['getDiagnostics']>(
      () => ({
        pendingDecisionClear: false,
        persistenceStatus: 'saved',
      })
    ),
    scheduleAutoPersistence:
      vi.fn<ChangeReviewDialogLifecycleDecisionPersistencePort['scheduleAutoPersistence']>(),
    clearAfterDurableStateEmptied: vi.fn<
      ChangeReviewDialogLifecycleDecisionPersistencePort['clearAfterDurableStateEmptied']
    >(() => Promise.resolve('cleared')),
  };
  const draftHistory: ChangeReviewDialogLifecycleDraftHistoryPort = {
    getEntry: vi.fn<ChangeReviewDialogLifecycleDraftHistoryPort['getEntry']>(() => undefined),
    flushWrites: vi.fn<ChangeReviewDialogLifecycleDraftHistoryPort['flushWrites']>(() => {
      events.push('flush-drafts');
      return Promise.resolve(true);
    }),
    retryHydration: vi.fn<ChangeReviewDialogLifecycleDraftHistoryPort['retryHydration']>(() => {
      events.push('retry-drafts');
    }),
    discardUnreadableScope: vi.fn<
      ChangeReviewDialogLifecycleDraftHistoryPort['discardUnreadableScope']
    >(() => Promise.resolve(true)),
    getDiagnostics: vi.fn<ChangeReviewDialogLifecycleDraftHistoryPort['getDiagnostics']>(() => ({
      pendingWriteCount: 0,
      writeChainCount: 0,
      writeErrorCount: 0,
    })),
  };
  const unregisterOwner = vi.fn();
  const unregisterAppCloseParticipant = vi.fn();
  const registerOwner = vi.fn<RegisterChangeReviewLifecycleOwner>(() => ({
    accepted: true,
    unregister: unregisterOwner,
  }));
  const registerAppCloseParticipant = vi.fn<RegisterChangeReviewAppCloseParticipant>(
    (_participantId, participant) => {
      mutable.appCloseParticipant = participant;
      return unregisterAppCloseParticipant;
    }
  );
  const setAuthorized = vi.fn();
  const onOpenChange = vi.fn((open: boolean) => events.push(`open:${String(open)}`));

  return {
    events,
    mutable,
    operationScope,
    snapshot,
    statePort,
    commandPort,
    editorPort,
    statusPort,
    sessionPort,
    writeEvidencePort,
    decisionPersistence,
    draftHistory,
    registerOwner,
    registerAppCloseParticipant,
    unregisterOwner,
    unregisterAppCloseParticipant,
    setAuthorized,
    onOpenChange,
  };
}

type Harness = ReturnType<typeof createHarness>;

function createInput(harness: Harness, overrides: Partial<ControllerInput> = {}): ControllerInput {
  return {
    open: true,
    authorized: true,
    setAuthorized: harness.setAuthorized,
    hostId: 'host-a',
    sessionId: 'session-a',
    tabId: 'tab-a',
    focus: undefined,
    teamName: 'team',
    mode: 'task',
    memberName: undefined,
    taskId: 'task',
    taskChangeRequestOptions: {},
    scopeKey: 'task:task',
    decisionScopeKey: 'task-task',
    decisionScopeToken: 'token-a',
    decisionHydrationKey: 'hydration-a',
    decisionHydrationReady: true,
    decisionHydrationFailed: false,
    draftHistoryHydration: { key: 'hydration-a', status: 'loaded' },
    draftHistoryHydrationFailed: false,
    reviewScope: { teamName: 'team', taskId: 'task' },
    reviewMutationBusy: false,
    reviewActionsBusy: false,
    onOpenChange: harness.onOpenChange,
    statePort: harness.statePort,
    commandPort: harness.commandPort,
    editorPort: harness.editorPort,
    statusPort: harness.statusPort,
    sessionPort: harness.sessionPort,
    writeEvidencePort: harness.writeEvidencePort,
    decisionPersistence: harness.decisionPersistence,
    draftHistory: harness.draftHistory,
    hasActionInFlight: () => false,
    blockForExternalChange: () => false,
    captureOperationScope: () => harness.operationScope,
    isCurrentOperationScope: (scope) => harness.mutable.current && scope === harness.operationScope,
    registerOwner: harness.registerOwner,
    registerAppCloseParticipant: harness.registerAppCloseParticipant,
    ...overrides,
  };
}

let latest: ChangeReviewDialogLifecycleController | null = null;

function Probe({ input }: Readonly<{ input: ControllerInput }>): React.JSX.Element {
  latest = useChangeReviewDialogLifecycleController(input);
  return <div />;
}

async function renderHarness(
  harness: Harness,
  overrides: Partial<ControllerInput> = {}
): Promise<ReturnType<typeof createRoot>> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.body.appendChild(document.createElement('div')));
  const input = createInput(harness, overrides);
  await act(async () => {
    root.render(<Probe input={input} />);
    await Promise.resolve();
  });
  harness.events.length = 0;
  return root;
}

describe('useChangeReviewDialogLifecycleController', () => {
  afterEach(() => {
    latest = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('captures editor drafts and flushes draft history before decision history and close', async () => {
    const harness = createHarness();
    const root = await renderHarness(harness);

    await act(async () => latest!.requestClose());

    expect(harness.events).toEqual([
      'begin-closing',
      'capture-drafts',
      'flush-drafts',
      'flush-decisions',
      'finish-closing',
      'open:false',
    ]);
    act(() => root.unmount());
  });

  it('loads, cleans up, and loads again across close and reopen', async () => {
    const harness = createHarness();
    const root = await renderHarness(harness);

    expect(harness.commandPort.resetAllReviewState).toHaveBeenCalledOnce();
    expect(harness.commandPort.fetchTaskChanges).toHaveBeenCalledOnce();
    expect(harness.commandPort.hydrateDecisions).toHaveBeenCalledOnce();

    await act(async () => {
      root.render(<Probe input={createInput(harness, { open: false, authorized: false })} />);
      await Promise.resolve();
    });
    expect(harness.commandPort.clearChangeReviewCache).toHaveBeenCalledOnce();
    expect(harness.unregisterOwner).toHaveBeenCalledOnce();
    expect(harness.unregisterAppCloseParticipant).toHaveBeenCalledOnce();

    await act(async () => {
      root.render(<Probe input={createInput(harness)} />);
      await Promise.resolve();
    });
    expect(harness.commandPort.resetAllReviewState).toHaveBeenCalledTimes(2);
    expect(harness.commandPort.fetchTaskChanges).toHaveBeenCalledTimes(2);
    expect(harness.commandPort.hydrateDecisions).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
  });

  it('blocks close when a captured manual draft is not durable', async () => {
    const harness = createHarness();
    harness.snapshot.editedContents['/repo/a.ts'] = 'manual';
    const root = await renderHarness(harness);

    await act(async () => latest!.requestClose());

    expect(harness.draftHistory.flushWrites).not.toHaveBeenCalled();
    expect(harness.decisionPersistence.flushForClose).not.toHaveBeenCalled();
    expect(harness.onOpenChange).not.toHaveBeenCalled();
    expect(harness.events).toEqual([
      'begin-closing',
      'capture-drafts',
      'error:Manual edits for /repo/a.ts are not durable yet. Keep Changes open and retry.',
      'finish-closing',
    ]);
    act(() => root.unmount());
  });

  it('keeps Changes open when draft-history flush fails', async () => {
    const harness = createHarness();
    harness.snapshot.hunkDecisions['/repo/a.ts:0'] = 'accepted';
    vi.mocked(harness.draftHistory.flushWrites).mockImplementation(() => {
      harness.events.push('flush-drafts');
      return Promise.resolve(false);
    });
    const root = await renderHarness(harness);

    await act(async () => latest!.requestClose());

    expect(harness.decisionPersistence.flushForClose).not.toHaveBeenCalled();
    expect(harness.onOpenChange).not.toHaveBeenCalled();
    expect(harness.events).toEqual([
      'begin-closing',
      'capture-drafts',
      'flush-drafts',
      'error:Unable to save manual edit history. Changes remains open.',
      'finish-closing',
    ]);
    act(() => root.unmount());
  });

  it('keeps Changes open when decision-history flush fails', async () => {
    const harness = createHarness();
    harness.snapshot.hunkDecisions['/repo/a.ts:0'] = 'accepted';
    vi.mocked(harness.decisionPersistence.flushForClose).mockImplementation(() => {
      harness.events.push('flush-decisions');
      return Promise.resolve(false);
    });
    const root = await renderHarness(harness);

    await act(async () => latest!.requestClose());

    expect(harness.onOpenChange).not.toHaveBeenCalled();
    expect(harness.events).toEqual([
      'begin-closing',
      'capture-drafts',
      'flush-drafts',
      'flush-decisions',
      'error:Unable to save review decisions. Changes remains open.',
      'finish-closing',
    ]);
    act(() => root.unmount());
  });

  it('uses the same ordered fail-closed flush for app close without closing the dialog itself', async () => {
    const harness = createHarness();
    harness.snapshot.hunkDecisions['/repo/a.ts:0'] = 'accepted';
    const root = await renderHarness(harness);
    const participant = harness.mutable.appCloseParticipant;
    expect(participant).not.toBeNull();

    let result: Awaited<ReturnType<RegisteredAppCloseParticipant>> | undefined;
    await act(async () => {
      result = await participant!({
        requestId: 'close-a',
        reason: 'window-close',
        deadlineAt: Date.now() + 1_000,
      });
    });

    expect(result).toEqual({ ok: true });
    expect(harness.events).toEqual([
      'begin-closing',
      'capture-drafts',
      'flush-drafts',
      'flush-decisions',
      'finish-closing',
    ]);
    expect(harness.onOpenChange).not.toHaveBeenCalled();
    act(() => root.unmount());
    expect(harness.unregisterOwner).toHaveBeenCalledOnce();
    expect(harness.unregisterAppCloseParticipant).toHaveBeenCalledOnce();
  });

  it('finishes pending Apply cleanup without rewriting decision history', async () => {
    const harness = createHarness();
    harness.mutable.pendingApplyCleanupKey = 'hydration-a';
    const root = await renderHarness(harness);

    await act(async () => latest!.requestClose());

    expect(harness.events).toEqual([
      'begin-closing',
      'capture-drafts',
      'flush-drafts',
      'clear-decisions',
      'pending:null',
      'finish-closing',
      'open:false',
    ]);
    expect(harness.decisionPersistence.flushForClose).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('fences close completion when the operation scope changes after draft flush', async () => {
    const harness = createHarness();
    vi.mocked(harness.draftHistory.flushWrites).mockImplementation(() => {
      harness.events.push('flush-drafts');
      harness.mutable.current = false;
      return Promise.resolve(true);
    });
    const root = await renderHarness(harness);

    await act(async () => latest!.requestClose());

    expect(harness.events).toEqual(['begin-closing', 'capture-drafts', 'flush-drafts']);
    expect(harness.decisionPersistence.flushForClose).not.toHaveBeenCalled();
    expect(harness.statusPort.finishClosing).not.toHaveBeenCalled();
    expect(harness.onOpenChange).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('orders Apply, WAL postimage evidence, durable cleanup, and local reset', async () => {
    const harness = createHarness();
    const root = await renderHarness(harness);

    await act(async () => latest!.apply());

    expect(harness.events).toEqual([
      'apply-review',
      'mark-postimages',
      'pending:hydration-a',
      'begin-closing',
      'clear-decisions',
      'pending:null',
      'reset',
      'finish-closing',
    ]);
    act(() => root.unmount());
  });

  it('does not clear durable decisions after an operation-owned failed Apply result', async () => {
    const harness = createHarness();
    vi.mocked(harness.commandPort.applyReview).mockImplementation(() => {
      harness.events.push('apply-review');
      return Promise.resolve({
        status: 'failed',
        result: successfulApply({
          applied: 0,
          conflicts: 1,
          errors: [{ filePath: '/repo/a.ts', error: 'changed' }],
          diskPostimages: [{ filePath: '/repo/a.ts', content: 'partial' }],
        }),
        errorMessage: 'changed',
      });
    });
    const root = await renderHarness(harness);

    await act(async () => latest!.apply());

    expect(harness.events).toEqual(['apply-review', 'mark-postimages', 'error:changed']);
    expect(harness.sessionPort.setPendingApplyCleanupKey).not.toHaveBeenCalled();
    expect(harness.commandPort.clearDecisions).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('reports the operation-owned error when Apply fails without a result', async () => {
    const harness = createHarness();
    vi.mocked(harness.commandPort.applyReview).mockImplementation(() => {
      harness.events.push('apply-review');
      return Promise.resolve({
        status: 'failed',
        result: null,
        errorMessage: 'Review scope changed. Reload Changes before applying.',
      });
    });
    const root = await renderHarness(harness);

    await act(async () => latest!.apply());

    expect(harness.events).toEqual([
      'apply-review',
      'mark-postimages',
      'error:Review scope changed. Reload Changes before applying.',
    ]);
    expect(harness.sessionPort.setPendingApplyCleanupKey).not.toHaveBeenCalled();
    expect(harness.commandPort.clearDecisions).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('discards unreadable decision and draft state only after both durable clears succeed', async () => {
    const harness = createHarness();
    const root = await renderHarness(harness, {
      decisionHydrationFailed: true,
      draftHistoryHydrationFailed: true,
    });

    await act(async () => latest!.discardSavedDecisionState());

    expect(harness.commandPort.clearDecisions).toHaveBeenCalledWith(
      {
        teamName: 'team',
        scopeKey: 'task-task',
        scopeToken: 'token-a',
      },
      true
    );
    expect(harness.draftHistory.discardUnreadableScope).toHaveBeenCalledWith(
      harness.operationScope
    );
    expect(harness.statePort.completeSavedStateDiscard).toHaveBeenCalledWith(true);
    expect(harness.events).toEqual(['begin-closing', 'clear-decisions', 'finish-closing']);
    act(() => root.unmount());
  });

  it('fails closed when unreadable decision state cannot be discarded', async () => {
    const harness = createHarness();
    vi.mocked(harness.commandPort.clearDecisions).mockImplementation(() => {
      harness.events.push('clear-decisions');
      return Promise.resolve(false);
    });
    const root = await renderHarness(harness, {
      decisionHydrationFailed: true,
      draftHistoryHydrationFailed: true,
    });
    let failure: unknown;

    await act(async () => {
      try {
        await latest!.discardSavedDecisionState();
      } catch (error) {
        failure = error;
      }
    });

    expect(failure).toEqual(new Error('Unable to discard the unreadable saved review decisions.'));
    expect(harness.draftHistory.discardUnreadableScope).not.toHaveBeenCalled();
    expect(harness.statePort.completeSavedStateDiscard).not.toHaveBeenCalled();
    expect(harness.events).toEqual([
      'begin-closing',
      'clear-decisions',
      'error:Unable to discard the unreadable saved review decisions.',
      'finish-closing',
    ]);
    act(() => root.unmount());
  });

  it('retries WAL recovery before decision hydration and draft-history retry', async () => {
    const harness = createHarness();
    const root = await renderHarness(harness, {
      decisionHydrationFailed: true,
      draftHistoryHydrationFailed: true,
    });

    await act(async () => latest!.retrySavedReviewState());

    expect(harness.events).toEqual([
      'recovery:true',
      'retry-recovery',
      'mark-postimages',
      'hydrate',
      'retry-drafts',
      'recovery:false',
    ]);
    act(() => root.unmount());
  });
});
