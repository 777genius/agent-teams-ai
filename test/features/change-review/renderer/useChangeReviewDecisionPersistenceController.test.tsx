import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
  useChangeReviewDecisionAutoPersistence,
  useChangeReviewDecisionPersistenceController,
} from '@features/change-review/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ChangeReviewDecisionPersistenceController,
  ChangeReviewDecisionPersistencePort,
  ChangeReviewDecisionPersistenceScope,
  ChangeReviewDecisionPersistenceSnapshot,
} from '@features/change-review/renderer';

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

function makeSnapshot(
  input: Partial<ChangeReviewDecisionPersistenceSnapshot> = {}
): ChangeReviewDecisionPersistenceSnapshot {
  return {
    hunkDecisions: {},
    fileDecisions: {},
    reviewActionHistory: [],
    reviewRedoHistory: [],
    fileContents: {},
    fileChunkCounts: {},
    decisionHydrationScopeKey: 'a',
    decisionHydrationStatus: 'loaded',
    applyError: null,
    ...input,
  };
}

function makePort(snapshotRef: { current: ChangeReviewDecisionPersistenceSnapshot }) {
  const port: ChangeReviewDecisionPersistencePort = {
    getSnapshot: vi.fn(() => snapshotRef.current),
    load: vi.fn(async () => {}),
    schedule: vi.fn(),
    flush: vi.fn(async () => true),
    clear: vi.fn(async () => true),
    reportError: vi.fn(),
    clearError: vi.fn(),
  };
  return port;
}

interface ProbeProps {
  hydrationKey: string | null;
  expectedHydrationKey: string | null;
  scope: ChangeReviewDecisionPersistenceScope | null;
  hydrationReady: boolean;
  port: ChangeReviewDecisionPersistencePort;
  refresh: () => Promise<void>;
  autoActive?: boolean;
  blocked?: boolean;
  hasDurableReviewState?: boolean;
  snapshot: ChangeReviewDecisionPersistenceSnapshot;
}

let latest: ChangeReviewDecisionPersistenceController | null = null;

function Probe(props: ProbeProps): React.JSX.Element {
  latest = useChangeReviewDecisionPersistenceController({
    hydrationKey: props.hydrationKey,
    scope: props.scope,
    hydrationReady: props.hydrationReady,
    isExpectedHydrationKey: (key) => key === props.expectedHydrationKey,
    refreshConflictCandidates: props.refresh,
    port: props.port,
  });
  useChangeReviewDecisionAutoPersistence({
    active: props.autoActive ?? false,
    hydrationKey: props.hydrationKey,
    scope: props.scope,
    hydrationReady: props.hydrationReady,
    blocked: props.blocked ?? false,
    hasDurableReviewState: props.hasDurableReviewState ?? false,
    hunkDecisions: props.snapshot.hunkDecisions,
    fileDecisions: props.snapshot.fileDecisions,
    undoHistory: props.snapshot.reviewActionHistory,
    redoHistory: props.snapshot.reviewRedoHistory,
    fileContents: props.snapshot.fileContents,
    fileChunkCounts: props.snapshot.fileChunkCounts,
    scheduleAutoPersistence: latest.scheduleAutoPersistence,
    clearAfterDurableStateEmptied: latest.clearAfterDurableStateEmptied,
  });
  return <div />;
}

const scopeA = { teamName: 'team', scopeKey: 'task-a', scopeToken: 'token-a' };
const scopeB = { teamName: 'team', scopeKey: 'task-b', scopeToken: 'token-b' };

describe('useChangeReviewDecisionPersistenceController', () => {
  afterEach(() => {
    latest = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('marks hydration before auto persistence and compares snapshot identity by reference', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const root = createRoot(document.body.appendChild(document.createElement('div')));
    const snapshotRef = {
      current: makeSnapshot({ hunkDecisions: { h: 'accepted' } }),
    };
    const port = makePort(snapshotRef);
    const refresh = vi.fn(async () => {});
    const render = async (snapshot: ChangeReviewDecisionPersistenceSnapshot, autoActive: boolean) => {
      snapshotRef.current = snapshot;
      await act(async () => {
        root.render(
          <Probe
            hydrationKey="a"
            expectedHydrationKey="a"
            scope={scopeA}
            hydrationReady
            port={port}
            refresh={refresh}
            autoActive={autoActive}
            hasDurableReviewState
            snapshot={snapshot}
          />
        );
      });
    };

    await render(snapshotRef.current, false);
    await act(async () => latest!.hydrate(scopeA, 'a'));
    await render(snapshotRef.current, true);
    expect(port.schedule).not.toHaveBeenCalled();

    const changedIdentity = {
      ...snapshotRef.current,
      hunkDecisions: { h: 'accepted' },
    };
    await render(changedIdentity, true);
    expect(port.schedule).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it('fences overlapping writes, stale A -> B -> A hydration, and current failures', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const root = createRoot(document.body.appendChild(document.createElement('div')));
    const snapshotRef = { current: makeSnapshot({ hunkDecisions: { h: 'accepted' } }) };
    const port = makePort(snapshotRef);
    const refresh = vi.fn(async () => {});
    const render = async (
      hydrationKey: string,
      expectedHydrationKey: string,
      scope: ChangeReviewDecisionPersistenceScope
    ) => {
      await act(async () => {
        root.render(
          <Probe
            hydrationKey={hydrationKey}
            expectedHydrationKey={expectedHydrationKey}
            scope={scope}
            hydrationReady
            port={port}
            refresh={refresh}
            snapshot={snapshotRef.current}
          />
        );
      });
    };
    await render('a', 'a', scopeA);

    const firstFlush = deferred<boolean>();
    const secondFlush = deferred<boolean>();
    vi.mocked(port.flush)
      .mockImplementationOnce(() => firstFlush.promise)
      .mockImplementationOnce(() => secondFlush.promise);
    let firstWrite!: Promise<boolean>;
    let secondWrite!: Promise<boolean>;
    await act(async () => {
      firstWrite = latest!.persistLatest();
      await Promise.resolve();
      secondWrite = latest!.persistLatest();
      await Promise.resolve();
    });
    await act(async () => {
      firstFlush.resolve(false);
      await firstWrite;
    });
    expect(port.reportError).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => {
      secondFlush.resolve(true);
      await secondWrite;
    });
    expect(latest!.status).toBe('saved');

    const staleLoad = deferred<void>();
    vi.mocked(port.load).mockImplementationOnce(() => staleLoad.promise);
    let staleHydration!: Promise<void>;
    await act(async () => {
      staleHydration = latest!.hydrate(scopeA, 'a');
      await Promise.resolve();
    });
    await render('b', 'b', scopeB);
    await render('a', 'a', scopeA);
    await act(async () => {
      staleLoad.resolve();
      await staleHydration;
    });
    latest!.scheduleAutoPersistence(scopeA);
    expect(port.schedule).toHaveBeenCalledTimes(3);

    vi.mocked(port.flush).mockResolvedValueOnce(false);
    await act(async () => {
      expect(await latest!.persistLatest()).toBe(false);
    });
    expect(latest!.status).toBe('error');
    expect(port.reportError).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it('fails closed without a durable scope', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const root = createRoot(document.body.appendChild(document.createElement('div')));
    const snapshotRef = { current: makeSnapshot() };
    const port = makePort(snapshotRef);
    await act(async () => {
      root.render(
        <Probe
          hydrationKey={null}
          expectedHydrationKey={null}
          scope={null}
          hydrationReady={false}
          port={port}
          refresh={vi.fn(async () => {})}
          snapshot={snapshotRef.current}
        />
      );
    });
    await act(async () => {
      expect(await latest!.persistLatest()).toBe(false);
    });
    expect(latest!.status).toBe('error');
    expect(port.schedule).not.toHaveBeenCalled();
    expect(port.reportError).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it('clears an emptied durable scope once after the awaited clear succeeds', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const root = createRoot(document.body.appendChild(document.createElement('div')));
    const snapshotRef = {
      current: makeSnapshot({ fileDecisions: { file: 'accepted' } }),
    };
    const port = makePort(snapshotRef);
    const refresh = vi.fn(async () => {});
    const render = async (
      snapshot: ChangeReviewDecisionPersistenceSnapshot,
      hasState: boolean
    ) => {
      snapshotRef.current = snapshot;
      await act(async () => {
        root.render(
          <Probe
            hydrationKey="a"
            expectedHydrationKey="a"
            scope={scopeA}
            hydrationReady
            port={port}
            refresh={refresh}
            autoActive
            hasDurableReviewState={hasState}
            snapshot={snapshot}
          />
        );
        await Promise.resolve();
      });
    };

    await render(snapshotRef.current, true);
    const empty = makeSnapshot();
    await render(empty, false);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await render({ ...empty, fileContents: {} }, false);
    expect(port.clear).toHaveBeenCalledTimes(1);
    expect(latest!.getDiagnostics().pendingDecisionClear).toBe(false);
    expect(port.reportError).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('awaits one nonempty -> empty clear and fences a stale A -> B -> A completion', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const root = createRoot(document.body.appendChild(document.createElement('div')));
    const nonempty = makeSnapshot({ hunkDecisions: { h: 'accepted' } });
    const empty = makeSnapshot();
    const snapshotRef = { current: nonempty };
    const port = makePort(snapshotRef);
    const refresh = vi.fn(async () => {});
    const clear = deferred<boolean>();
    vi.mocked(port.clear).mockImplementation(() => clear.promise);
    const render = async (
      snapshot: ChangeReviewDecisionPersistenceSnapshot,
      hydrationKey: string,
      scope: ChangeReviewDecisionPersistenceScope,
      hasState: boolean
    ) => {
      snapshotRef.current = snapshot;
      await act(async () => {
        root.render(
          <Probe
            hydrationKey={hydrationKey}
            expectedHydrationKey={hydrationKey}
            scope={scope}
            hydrationReady
            port={port}
            refresh={refresh}
            autoActive
            hasDurableReviewState={hasState}
            snapshot={snapshot}
          />
        );
      });
    };

    await render(nonempty, 'a', scopeA, true);
    await render(empty, 'a', scopeA, false);
    await render(empty, 'a', scopeA, false);
    expect(port.clear).toHaveBeenCalledTimes(1);
    expect(latest!.getDiagnostics()).toEqual({
      pendingDecisionClear: true,
      persistenceStatus: 'saved',
    });
    await render(nonempty, 'b', scopeB, true);
    await render(empty, 'a', scopeA, false);
    await act(async () => {
      clear.resolve(false);
      await Promise.resolve();
    });
    expect(port.reportError).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(latest!.status).toBe('saved');
    await act(async () => root.unmount());
  });

  it('retains the durable-state marker when new state appears before clear completes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const root = createRoot(document.body.appendChild(document.createElement('div')));
    const nonempty = makeSnapshot({ hunkDecisions: { h: 'accepted' } });
    const empty = makeSnapshot();
    const snapshotRef = { current: nonempty };
    const port = makePort(snapshotRef);
    const firstClear = deferred<boolean>();
    vi.mocked(port.clear)
      .mockImplementationOnce(() => firstClear.promise)
      .mockResolvedValue(true);
    const render = async (
      snapshot: ChangeReviewDecisionPersistenceSnapshot,
      hasState: boolean
    ) => {
      snapshotRef.current = snapshot;
      await act(async () => {
        root.render(
          <Probe
            hydrationKey="a"
            expectedHydrationKey="a"
            scope={scopeA}
            hydrationReady
            port={port}
            refresh={vi.fn(async () => {})}
            autoActive
            hasDurableReviewState={hasState}
            snapshot={snapshot}
          />
        );
      });
    };

    await render(nonempty, true);
    await render(empty, false);
    await render({ ...nonempty, hunkDecisions: { h: 'rejected' } }, true);
    await act(async () => {
      firstClear.resolve(true);
      await Promise.resolve();
    });
    await render({ ...empty, fileContents: {} }, false);
    await act(async () => {
      await Promise.resolve();
    });

    expect(port.clear).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });

  it('chooses save versus clear for close and reuses a pending clear', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const root = createRoot(document.body.appendChild(document.createElement('div')));
    const nonempty = makeSnapshot({ reviewActionHistory: [{ id: 'a' }] });
    const snapshotRef = { current: nonempty };
    const port = makePort(snapshotRef);
    const refresh = vi.fn(async () => {});
    const render = async (snapshot: ChangeReviewDecisionPersistenceSnapshot) => {
      snapshotRef.current = snapshot;
      await act(async () => {
        root.render(
          <Probe
            hydrationKey="a"
            expectedHydrationKey="a"
            scope={scopeA}
            hydrationReady
            port={port}
            refresh={refresh}
            snapshot={snapshot}
          />
        );
      });
    };
    await render(nonempty);
    await act(async () => expect(await latest!.flushForClose()).toBe(true));
    expect(port.schedule).toHaveBeenCalledTimes(1);
    expect(port.flush).toHaveBeenCalledTimes(1);
    expect(port.clear).not.toHaveBeenCalled();

    await render(makeSnapshot());
    await act(async () => expect(await latest!.flushForClose()).toBe(true));
    expect(port.clear).toHaveBeenCalledTimes(1);

    const pending = deferred<boolean>();
    vi.mocked(port.clear).mockImplementationOnce(() => pending.promise);
    let autoClear!: Promise<unknown>;
    await act(async () => {
      autoClear = latest!.clearAfterDurableStateEmptied(scopeA, 'a');
      await Promise.resolve();
    });
    let closeFlush!: Promise<boolean>;
    await act(async () => {
      closeFlush = latest!.flushForClose();
      await Promise.resolve();
    });
    expect(port.clear).toHaveBeenCalledTimes(2);
    await act(async () => {
      pending.resolve(true);
      await autoClear;
      expect(await closeFlush).toBe(true);
    });
    await act(async () => root.unmount());
  });
});
