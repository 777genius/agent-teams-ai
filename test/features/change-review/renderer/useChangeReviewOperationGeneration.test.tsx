import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useChangeReviewOperationGeneration } from '@features/change-review/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReviewOperationScopeToken } from '@features/change-review/renderer';

interface ProbeProps {
  active: boolean;
  decisionHydrationKey: string | null;
  fallbackScopeKey: string;
  changeSetEpoch: number;
  resetGenerationState: () => void;
}

interface ProbeValue {
  captureReviewOperationScope: () => ReviewOperationScopeToken | null;
  isCurrentReviewOperationScope: (
    operationScope: ReviewOperationScopeToken | null
  ) => operationScope is ReviewOperationScopeToken;
}

let latest: ProbeValue | null = null;

function OperationProbe(props: ProbeProps): React.JSX.Element {
  latest = useChangeReviewOperationGeneration(props);
  return <div />;
}

describe('useChangeReviewOperationGeneration', () => {
  afterEach(() => {
    latest = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('exposes no token until the dialog owns an active scope', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const resetGenerationState = vi.fn();

    await act(async () => {
      root.render(
        <OperationProbe
          active={false}
          decisionHydrationKey="scope-a"
          fallbackScopeKey="unscoped:team-a:task:task-a"
          changeSetEpoch={1}
          resetGenerationState={resetGenerationState}
        />
      );
    });
    expect(latest!.captureReviewOperationScope()).toBeNull();

    await act(async () => {
      root.render(
        <OperationProbe
          active
          decisionHydrationKey="scope-a"
          fallbackScopeKey="unscoped:team-a:task:task-a"
          changeSetEpoch={1}
          resetGenerationState={resetGenerationState}
        />
      );
    });
    expect(latest!.captureReviewOperationScope()).toMatchObject({ hydrationKey: 'scope-a' });
    expect(resetGenerationState).toHaveBeenCalledTimes(2);

    await act(async () => root.unmount());
  });

  it('invalidates stale work across A -> B -> A and same-scope epoch changes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const resetGenerationState = vi.fn();
    const renderProbe = async (decisionHydrationKey: string, changeSetEpoch: number) => {
      await act(async () => {
        root.render(
          <OperationProbe
            active
            decisionHydrationKey={decisionHydrationKey}
            fallbackScopeKey="unscoped:team-a:task:task-a"
            changeSetEpoch={changeSetEpoch}
            resetGenerationState={resetGenerationState}
          />
        );
      });
      return latest!.captureReviewOperationScope()!;
    };

    const firstA = await renderProbe('scope-a', 1);
    const scopeB = await renderProbe('scope-b', 1);
    const reopenedA = await renderProbe('scope-a', 1);
    const refreshedA = await renderProbe('scope-a', 2);

    expect(latest!.isCurrentReviewOperationScope(firstA)).toBe(false);
    expect(latest!.isCurrentReviewOperationScope(scopeB)).toBe(false);
    expect(latest!.isCurrentReviewOperationScope(reopenedA)).toBe(false);
    expect(latest!.isCurrentReviewOperationScope(refreshedA)).toBe(true);
    expect(new Set([firstA, scopeB, reopenedA, refreshedA]).size).toBe(4);
    expect(resetGenerationState).toHaveBeenCalledTimes(4);

    await act(async () => root.unmount());
    expect(latest!.captureReviewOperationScope()).toBeNull();
    expect(latest!.isCurrentReviewOperationScope(refreshedA)).toBe(false);
  });
});
