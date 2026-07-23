import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
  createReviewOperationScopeToken,
  useChangeReviewConflictInteractionController,
} from '@features/change-review/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ChangeReviewConflictCommandPort,
  ChangeReviewConflictInteractionController,
  ChangeReviewConflictScope,
  ReviewOperationScopeToken,
} from '@features/change-review/renderer';
import type { ReviewDraftHistoryConflictCandidateSummary } from '@features/change-review-history/contracts';
import type {
  ReviewConflictResolution,
  ReviewDecisionConflictCandidateSummary,
} from '@shared/types';

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

function decision(): ReviewDecisionConflictCandidateSummary {
  return {
    id: 'decision-a',
    capturedAt: '2026-07-23T12:00:00.000Z',
    origin: 'current-snapshot',
    recoverability: 'recoverable',
    expectedRevision: 1,
    observedCurrentRevision: 2,
    hunkDecisionCount: 0,
    fileDecisionCount: 0,
    undoDepth: 1,
    redoDepth: 0,
  };
}

function draft(): ReviewDraftHistoryConflictCandidateSummary {
  return {
    id: 'draft-a',
    capturedAt: '2026-07-23T12:00:00.000Z',
    origin: 'current-snapshot',
    recoverability: 'recoverable',
    filePath: '/repo/file.ts',
    expectedRevision: 1,
    expectedGeneration: 'first',
    observedCurrentRevision: 2,
    observedCurrentGeneration: 'second',
    entryRevision: 1,
  };
}

interface ProbeProps {
  active: boolean;
  hydrationKey: string;
  scope: ChangeReviewConflictScope;
  decisionCandidates: ReviewDecisionConflictCandidateSummary[];
  draftHistoryCandidates: ReviewDraftHistoryConflictCandidateSummary[];
  currentOperation: { value: ReviewOperationScopeToken | null };
  currentHydrationKey: { value: string };
  port: ChangeReviewConflictCommandPort;
  hydrateDecisions: () => Promise<void>;
  isDecisionHydrationLoaded: () => boolean;
  publishDecisionPersistenceSaved: () => void;
  resolveDraftHistoryCandidate: (
    candidate: ReviewDraftHistoryConflictCandidateSummary,
    resolution: ReviewConflictResolution,
    operationScope: ReviewOperationScopeToken
  ) => Promise<boolean>;
  clearResolutionError: () => void;
  reportResolutionError: (message: string) => void;
  refreshCandidates: () => Promise<void>;
}

let latest: ChangeReviewConflictInteractionController | null = null;

function InteractionProbe(props: Readonly<ProbeProps>): React.JSX.Element {
  latest = useChangeReviewConflictInteractionController({
    ...props,
    captureOperationScope: () => props.currentOperation.value,
    isCurrentOperationScope: (
      operationScope
    ): operationScope is ReviewOperationScopeToken =>
      props.currentOperation.value !== null &&
      props.currentOperation.value === operationScope,
    isExpectedHydrationKey: (hydrationKey) =>
      props.currentHydrationKey.value === hydrationKey,
    hydrateDecisions: () => props.hydrateDecisions(),
    isDecisionHydrationLoaded: () => props.isDecisionHydrationLoaded(),
    resolveDraftHistoryCandidate: (candidate, resolution, operationScope) =>
      props.resolveDraftHistoryCandidate(candidate, resolution, operationScope),
  });
  return <div />;
}

describe('useChangeReviewConflictInteractionController', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const scope = { teamName: 'team-a', scopeKey: 'task-a', scopeToken: 'token-a' };

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

  function baseProps(overrides: Partial<ProbeProps> = {}): ProbeProps {
    const token = createReviewOperationScopeToken('scope-a');
    return {
      hydrationKey: 'scope-a',
      active: true,
      scope,
      decisionCandidates: [decision()],
      draftHistoryCandidates: [],
      currentOperation: { value: token },
      currentHydrationKey: { value: 'scope-a' },
      port: { resolveDecisionCandidate: vi.fn(() => Promise.resolve({ revision: 3 })) },
      hydrateDecisions: vi.fn(() => Promise.resolve()),
      isDecisionHydrationLoaded: vi.fn(() => true),
      publishDecisionPersistenceSaved: vi.fn(),
      resolveDraftHistoryCandidate: vi.fn(() => Promise.resolve(true)),
      clearResolutionError: vi.fn(),
      reportResolutionError: vi.fn(),
      refreshCandidates: vi.fn(() => Promise.resolve()),
      ...overrides,
    };
  }

  it('preserves strict decision resolve, reload, verification, publish and refresh order', async () => {
    const order: string[] = [];
    const props = baseProps({
      port: {
        resolveDecisionCandidate: vi.fn(() => {
          order.push('resolve');
          return Promise.resolve({ revision: 3 });
        }),
      },
      hydrateDecisions: vi.fn(() => {
        order.push('hydrate');
        return Promise.resolve();
      }),
      isDecisionHydrationLoaded: vi.fn(() => {
        order.push('verify');
        return true;
      }),
      publishDecisionPersistenceSaved: vi.fn(() => order.push('publish')),
      clearResolutionError: vi.fn(() => order.push('clear-error')),
      refreshCandidates: vi.fn(() => {
        order.push('refresh');
        return Promise.resolve();
      }),
    });
    act(() => root.render(<InteractionProbe {...props} />));

    await act(() => latest!.resolveActiveCandidate('recover-candidate'));

    expect(order).toEqual([
      'resolve',
      'hydrate',
      'verify',
      'publish',
      'clear-error',
      'refresh',
    ]);
    expect(latest!.resolvingCandidateId).toBeNull();
  });

  it('fails closed when reloaded decisions do not verify as loaded', async () => {
    const order: string[] = [];
    const props = baseProps({
      port: {
        resolveDecisionCandidate: vi.fn(() => {
          order.push('resolve');
          return Promise.resolve({ revision: 3 });
        }),
      },
      hydrateDecisions: vi.fn(() => {
        order.push('hydrate');
        return Promise.resolve();
      }),
      isDecisionHydrationLoaded: vi.fn(() => {
        order.push('verify');
        return false;
      }),
      publishDecisionPersistenceSaved: vi.fn(() => order.push('publish')),
      clearResolutionError: vi.fn(() => order.push('clear-error')),
      reportResolutionError: vi.fn(() => order.push('report-error')),
      refreshCandidates: vi.fn(() => {
        order.push('refresh');
        return Promise.resolve();
      }),
    });
    act(() => root.render(<InteractionProbe {...props} />));

    await act(() => latest!.resolveActiveCandidate('recover-candidate'));

    expect(order).toEqual(['resolve', 'hydrate', 'verify', 'report-error', 'refresh']);
    expect(props.reportResolutionError).toHaveBeenCalledWith(
      'Unable to resolve the durable recovery copy: Error: Resolved decisions could not be reloaded'
    );
  });

  it('delegates draft resolution and ignores its stale result after dialog deactivation', async () => {
    const resolution = deferred<boolean>();
    const props = baseProps({
      decisionCandidates: [],
      draftHistoryCandidates: [draft()],
      resolveDraftHistoryCandidate: vi.fn(() => resolution.promise),
    });
    act(() => root.render(<InteractionProbe {...props} />));
    const initialOperation = props.currentOperation.value;
    let pending!: Promise<void>;
    act(() => {
      pending = latest!.resolveActiveCandidate('recover-candidate');
    });
    expect(props.resolveDraftHistoryCandidate).toHaveBeenCalledWith(
      draft(),
      'recover-candidate',
      initialOperation
    );
    expect(latest!.resolvingCandidateId).toBe('draft-a');

    props.currentOperation.value = null;
    act(() => root.render(<InteractionProbe {...props} active={false} />));
    await act(async () => {
      resolution.resolve(true);
      await pending;
    });

    expect(props.clearResolutionError).not.toHaveBeenCalled();
    expect(props.refreshCandidates).not.toHaveBeenCalled();
    expect(latest!.resolvingCandidateId).toBeNull();
  });

  it('keeps one in-flight decision identity and rejects a stale expected candidate', async () => {
    const resolution = deferred<{ revision: number }>();
    const resolveDecisionCandidate = vi.fn(() => resolution.promise);
    const props = baseProps({
      port: { resolveDecisionCandidate },
    });
    act(() => root.render(<InteractionProbe {...props} />));

    await act(() =>
      latest!.resolveActiveCandidate('keep-current', 'different-candidate')
    );
    expect(resolveDecisionCandidate).not.toHaveBeenCalled();

    let first!: Promise<void>;
    let duplicate!: Promise<void>;
    act(() => {
      first = latest!.resolveActiveCandidate('recover-candidate');
      duplicate = latest!.resolveActiveCandidate('recover-candidate');
    });
    expect(resolveDecisionCandidate).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolution.resolve({ revision: 3 });
      await Promise.all([first, duplicate]);
    });
    expect(resolveDecisionCandidate).toHaveBeenCalledTimes(1);
  });
});
