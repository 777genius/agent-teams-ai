import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useChangeReviewOperationState } from '@features/change-review/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ChangeReviewOperationState,
  ChangeReviewOperationStatePort,
} from '@features/change-review/renderer';

interface ProbeProps {
  decisionHydrationKey: string;
  resetKey: string;
  port: ChangeReviewOperationStatePort;
}

let latest: ChangeReviewOperationState | null = null;

function Probe({ decisionHydrationKey, resetKey, port }: Readonly<ProbeProps>): React.JSX.Element {
  latest = useChangeReviewOperationState({
    active: true,
    decisionHydrationKey,
    fallbackScopeKey: 'unscoped:team-a:task:task-a',
    changeSetEpoch: 1,
    resetKey,
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

describe('useChangeReviewOperationState', () => {
  afterEach(() => {
    latest = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('tracks exact file work and resets mutation latches with the review scope', async () => {
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
      root.render(<Probe decisionHydrationKey="scope-a" resetKey="team-a:task-a:1" port={port} />)
    );
    expect(latest!.captureReviewOperationScope()).toMatchObject({ hydrationKey: 'scope-a' });

    act(() => {
      latest!.viewPortBindings.fileApplyInFlightRef.current.add('/repo/src/a.ts');
      latest!.viewPortBindings.undoInFlightRef.current = true;
      latest!.viewPortBindings.recentReviewWritesRef.current.set('/repo/src/a.ts', {
        at: 1000,
        expectedContent: 'committed',
      });
      latest!.viewPortBindings.setFilesApplying(new Set(['/repo/src/a.ts']));
    });

    expect(latest!.isFileMutationInFlight('/repo/src/a.ts')).toBe(true);
    expect(latest!.isPathMutationInFlight('/repo/src/a.ts')).toBe(true);
    expect(latest!.isPathMutationInFlight('/repo/src/b.ts')).toBe(true);
    expect(latest!.filesApplying).toEqual(new Set(['/repo/src/a.ts']));

    await flushReact(() =>
      root.render(<Probe decisionHydrationKey="scope-b" resetKey="team-a:task-a:1" port={port} />)
    );

    expect(latest!.viewPortBindings.fileApplyInFlightRef.current.size).toBe(0);
    expect(latest!.viewPortBindings.undoInFlightRef.current).toBe(false);
    expect(latest!.filesApplying.size).toBe(0);
    expect(latest!.viewPortBindings.recentReviewWritesRef.current.has('/repo/src/a.ts')).toBe(true);

    await flushReact(() =>
      root.render(<Probe decisionHydrationKey="scope-b" resetKey="team-a:task-b:1" port={port} />)
    );
    expect(latest!.viewPortBindings.recentReviewWritesRef.current.size).toBe(0);

    snapshot.applying = true;
    expect(latest!.isPathMutationInFlight('/repo/src/b.ts')).toBe(true);

    await flushReact(() => root.unmount());
  });
});
