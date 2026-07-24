import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
  useChangeReviewMutationGuards,
  useChangeReviewOperationState,
} from '@features/change-review/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ChangeReviewMutationGuards,
  ChangeReviewOperationState,
  ChangeReviewOperationStatePort,
} from '@features/change-review/renderer';

interface ProbeProps {
  decisionScopeToken: string | null;
  conflictCandidateCount: number;
  port: ChangeReviewOperationStatePort;
}

let latestGuards: ChangeReviewMutationGuards | null = null;
let latestOperation: ChangeReviewOperationState | null = null;

function Probe({
  decisionScopeToken,
  conflictCandidateCount,
  port,
}: Readonly<ProbeProps>): React.JSX.Element {
  latestOperation = useChangeReviewOperationState({
    active: true,
    decisionHydrationKey: 'scope-a',
    fallbackScopeKey: 'unscoped:team-a:task:task-a',
    changeSetEpoch: 1,
    resetKey: 'scope-a:1',
    port,
  });
  latestGuards = useChangeReviewMutationGuards({
    applying: false,
    operation: latestOperation,
    decisionScopeToken,
    decisionHydrationKey: 'scope-a',
    decisionHydrationReady: true,
    draftHistoryHydration: { key: 'scope-a', status: 'loaded' },
    draftHistoryHydrationReady: true,
    conflict: {
      refreshPending: false,
      loadError: null,
      candidateCount: conflictCandidateCount,
      resolvingCandidateId: null,
    },
    persistenceStatus: 'saved',
    getPersistenceStatus: () => 'saved',
    port,
  });
  return <div />;
}

async function flushReact(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

describe('useChangeReviewMutationGuards', () => {
  afterEach(() => {
    latestGuards = null;
    latestOperation = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('separates action locks from close locks and rejects an unsafe durable mutation', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const reportError = vi.fn();
    const snapshot = {
      applying: false,
      decisionHydrationScopeKey: 'scope-a',
      decisionHydrationStatus: 'loaded' as const,
    };
    const port: ChangeReviewOperationStatePort = {
      getSnapshot: () => snapshot,
      reportError,
    };
    const root = createRoot(document.body.appendChild(document.createElement('div')));

    await flushReact(() =>
      root.render(<Probe decisionScopeToken={null} conflictCandidateCount={1} port={port} />)
    );

    expect(latestGuards!.reviewActionsBusy).toBe(true);
    expect(latestGuards!.reviewCloseBusy).toBe(false);
    expect(latestGuards!.ensureDurableReviewScope()).toBe(false);
    expect(reportError).toHaveBeenCalledWith(
      'Durable review scope is unavailable; refusing an unsafe disk mutation.'
    );

    latestOperation!.viewPortBindings.fileApplyInFlightRef.current.add('/repo/a.ts');
    expect(latestGuards!.hasReviewActionInFlight()).toBe(true);

    await flushReact(() => root.unmount());
  });

  it('reads live hydration state before allowing close-time work to finish', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const snapshot = {
      applying: false,
      decisionHydrationScopeKey: 'scope-a',
      decisionHydrationStatus: 'loaded' as const,
    };
    const port: ChangeReviewOperationStatePort = {
      getSnapshot: () => snapshot,
      reportError: vi.fn(),
    };
    const root = createRoot(document.body.appendChild(document.createElement('div')));

    await flushReact(() =>
      root.render(
        <Probe decisionScopeToken="durable-scope" conflictCandidateCount={0} port={port} />
      )
    );
    expect(latestGuards!.hasReviewActionInFlight()).toBe(false);
    expect(latestGuards!.ensureDurableReviewScope()).toBe(true);

    snapshot.decisionHydrationScopeKey = 'scope-b';
    expect(latestGuards!.hasReviewActionInFlight()).toBe(true);

    await flushReact(() => root.unmount());
  });
});
