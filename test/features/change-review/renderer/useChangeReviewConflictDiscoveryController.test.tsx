import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useChangeReviewConflictDiscoveryController } from '@features/change-review/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ChangeReviewConflictDiscoveryController,
  ChangeReviewConflictQueryPort,
  ChangeReviewConflictScope,
} from '@features/change-review/renderer';
import type { ReviewDecisionConflictCandidateSummary } from '@shared/types';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function decision(id: string): ReviewDecisionConflictCandidateSummary {
  return {
    id,
    capturedAt: '2026-07-23T12:00:00.000Z',
    origin: 'current-snapshot',
    recoverability: 'recoverable',
    expectedRevision: 1,
    observedCurrentRevision: 2,
    hunkDecisionCount: 0,
    fileDecisionCount: 0,
    undoDepth: 0,
    redoDepth: 0,
  };
}

interface ProbeProps {
  active: boolean;
  hydrationKey: string | null;
  scope: ChangeReviewConflictScope | null;
  expectedHydrationKey: { current: string | null };
  hydrateDecisions: (
    scope: ChangeReviewConflictScope,
    hydrationKey: string
  ) => Promise<void>;
  port: ChangeReviewConflictQueryPort;
}

let latest: ChangeReviewConflictDiscoveryController | null = null;

function DiscoveryProbe(props: Readonly<ProbeProps>): React.JSX.Element {
  latest = useChangeReviewConflictDiscoveryController({
    ...props,
    isExpectedHydrationKey: (hydrationKey) =>
      props.expectedHydrationKey.current === hydrationKey,
    clearReportedLoadError: vi.fn(),
    reportLoadError: vi.fn(),
  });
  return <div />;
}

describe('useChangeReviewConflictDiscoveryController', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const scopeA = { teamName: 'team-a', scopeKey: 'task-a', scopeToken: 'token-a' };
  const scopeB = { teamName: 'team-a', scopeKey: 'task-b', scopeToken: 'token-b' };

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    latest = null;
    host.remove();
    vi.unstubAllGlobals();
  });

  it('lets only the newest concurrent discovery commit candidates', async () => {
    const decisionLoads = [
      deferred<ReviewDecisionConflictCandidateSummary[]>(),
      deferred<ReviewDecisionConflictCandidateSummary[]>(),
    ];
    const draftLoads = [deferred<[]>(), deferred<[]>()];
    let decisionLoadIndex = 0;
    let draftLoadIndex = 0;
    const port: ChangeReviewConflictQueryPort = {
      loadDecisionCandidates: vi.fn(() => decisionLoads[decisionLoadIndex++].promise),
      loadDraftHistoryCandidates: vi.fn(() => draftLoads[draftLoadIndex++].promise),
    };
    const expectedHydrationKey = { current: 'scope-a' };
    act(() => {
      root.render(
        <DiscoveryProbe
          active
          hydrationKey="scope-a"
          scope={scopeA}
          expectedHydrationKey={expectedHydrationKey}
          hydrateDecisions={vi.fn(() => Promise.resolve())}
          port={port}
        />
      );
    });

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = latest!.refresh();
      second = latest!.refresh();
    });
    await act(async () => {
      decisionLoads[1].resolve([decision('newest')]);
      draftLoads[1].resolve([]);
      await second;
    });
    expect(latest!.decisionCandidates.map(({ id }) => id)).toEqual(['newest']);
    expect(latest!.refreshPending).toBe(false);

    await act(async () => {
      decisionLoads[0].resolve([decision('stale')]);
      draftLoads[0].resolve([]);
      await first;
    });
    expect(latest!.decisionCandidates.map(({ id }) => id)).toEqual(['newest']);
    expect(latest!.refreshPending).toBe(false);
  });

  it('fences a stale load across A -> B -> A even when the key repeats', async () => {
    const decisionLoad = deferred<ReviewDecisionConflictCandidateSummary[]>();
    const draftLoad = deferred<[]>();
    const port: ChangeReviewConflictQueryPort = {
      loadDecisionCandidates: vi.fn(() => decisionLoad.promise),
      loadDraftHistoryCandidates: vi.fn(() => draftLoad.promise),
    };
    const expectedHydrationKey = { current: 'scope-a' };
    const render = (hydrationKey: string, scope: ChangeReviewConflictScope): void => {
      expectedHydrationKey.current = hydrationKey;
      act(() => {
        root.render(
          <DiscoveryProbe
            active
            hydrationKey={hydrationKey}
            scope={scope}
            expectedHydrationKey={expectedHydrationKey}
            hydrateDecisions={vi.fn(() => Promise.resolve())}
            port={port}
          />
        );
      });
    };
    render('scope-a', scopeA);
    let pending!: Promise<void>;
    act(() => {
      pending = latest!.refresh();
    });
    render('scope-b', scopeB);
    render('scope-a', scopeA);

    await act(async () => {
      decisionLoad.resolve([decision('stale-a')]);
      draftLoad.resolve([]);
      await pending;
    });
    expect(latest!.decisionCandidates).toEqual([]);
  });

  it('does not publish candidates after decision hydration becomes stale', async () => {
    const hydration = deferred<void>();
    const hydrateDecisions = vi.fn(() => hydration.promise);
    const port: ChangeReviewConflictQueryPort = {
      loadDecisionCandidates: vi.fn(() => Promise.resolve([decision('candidate-a')])),
      loadDraftHistoryCandidates: vi.fn(() => Promise.resolve([])),
    };
    const expectedHydrationKey = { current: 'scope-a' };
    const render = (hydrationKey: string, scope: ChangeReviewConflictScope): void => {
      expectedHydrationKey.current = hydrationKey;
      act(() => {
        root.render(
          <DiscoveryProbe
            active
            hydrationKey={hydrationKey}
            scope={scope}
            expectedHydrationKey={expectedHydrationKey}
            hydrateDecisions={hydrateDecisions}
            port={port}
          />
        );
      });
    };
    render('scope-a', scopeA);
    let pending!: Promise<void>;
    act(() => {
      pending = latest!.refresh();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(hydrateDecisions).toHaveBeenCalledWith(scopeA, 'scope-a');

    render('scope-b', scopeB);
    await act(async () => {
      hydration.resolve();
      await pending;
    });
    expect(latest!.decisionCandidates).toEqual([]);
  });
});
