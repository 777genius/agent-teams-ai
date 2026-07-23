import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useChangeReviewScopeIdentity } from '@features/change-review/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ChangeReviewScopeProjection,
  ReviewDraftHistoryHydrationState,
} from '@features/change-review/renderer';

interface ProbeProps {
  draftHistoryHydration: ReviewDraftHistoryHydrationState;
}

let latestProjection: ChangeReviewScopeProjection | null = null;

function Probe({ draftHistoryHydration }: Readonly<ProbeProps>): React.JSX.Element {
  latestProjection = useChangeReviewScopeIdentity({
    teamName: 'team-a',
    mode: 'task',
    taskId: 'task-a',
    activeChangeSet: null,
    decisionHydrationScopeKey: null,
    decisionHydrationStatus: 'idle',
    draftHistoryHydration,
  });
  return <div />;
}

describe('useChangeReviewScopeIdentity', () => {
  afterEach(() => {
    latestProjection = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('keeps the review scope reference stable across hydration state changes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const root = createRoot(document.body.appendChild(document.createElement('div')));

    await act(async () => {
      root.render(<Probe draftHistoryHydration={{ key: null, status: 'idle' }} />);
      await Promise.resolve();
    });
    const initialScope = latestProjection?.reviewScope;

    await act(async () => {
      root.render(<Probe draftHistoryHydration={{ key: 'hydration-a', status: 'loading' }} />);
      await Promise.resolve();
    });

    expect(latestProjection?.reviewScope).toBe(initialScope);
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
