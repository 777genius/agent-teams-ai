import React, { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import {
  type GetHostedMemberLogPageResult,
  HOSTED_MEMBER_LOG_MAX_PAGE_BYTES,
  HOSTED_MEMBER_LOG_MAX_PAGE_TIME_MS,
  HOSTED_MEMBER_LOG_MAX_RENDERED_ENTRIES,
  HOSTED_MEMBER_LOG_SCHEMA_VERSION,
  type HostedMemberLogEntry,
  type HostedMemberLogPage,
  hostedMemberLogPageByteLength,
  type HostedMemberLogSelectionId,
  parseHostedMemberLogEntryId,
  parseHostedMemberLogSelectionId,
  parseHostedMemberLogSourceGeneration,
} from '@features/member-log-stream/contracts/hosted';
import {
  type HostedMemberLogTransport,
  useHostedMemberLog,
  type UseHostedMemberLogResult,
} from '@features/member-log-stream/renderer/hosted';
import { parseCursor, parseMemberId, parseRevision, parseTeamId } from '@shared/contracts/hosted';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const teamId = parseTeamId(`team_${'e'.repeat(32)}`);
const memberId = parseMemberId(`member_${'f'.repeat(32)}`);
const revision = parseRevision('revision_member-log-hook');
const firstGeneration = parseHostedMemberLogSourceGeneration('generation_member-log-first');
const replacementGeneration = parseHostedMemberLogSourceGeneration(
  'generation_member-log-replacement'
);
const firstSelectionId = parseHostedMemberLogSelectionId(`member_log_selection_${'1'.repeat(32)}`);
const secondSelectionId = parseHostedMemberLogSelectionId(`member_log_selection_${'2'.repeat(32)}`);

let latest: UseHostedMemberLogResult | null = null;

function entry(index: number): HostedMemberLogEntry {
  return {
    teamId,
    memberId,
    entryId: parseHostedMemberLogEntryId(`member_log_${index.toString(16).padStart(32, '0')}`),
    level: 'info',
    occurredAtMs: index,
    text: `safe entry ${index}`,
  };
}

function page(
  entries: readonly HostedMemberLogEntry[],
  options: {
    readonly selectionId?: HostedMemberLogSelectionId;
    readonly sourceGeneration?: typeof firstGeneration;
    readonly nextCursor?: ReturnType<typeof parseCursor> | null;
    readonly itemLimit?: number;
  } = {}
): HostedMemberLogPage {
  const nextCursor = options.nextCursor ?? null;
  const truncationReasons = nextCursor === null ? [] : ['source_budget' as const];
  let usedBytes = 0;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate: HostedMemberLogPage = {
      schemaVersion: HOSTED_MEMBER_LOG_SCHEMA_VERSION,
      kind: 'member_log_page',
      selectionId: options.selectionId ?? firstSelectionId,
      teamId,
      memberId,
      sourceGeneration: options.sourceGeneration ?? firstGeneration,
      revision,
      entries,
      nextCursor,
      truncated: nextCursor !== null,
      truncationReasons,
      budget: {
        itemLimit: options.itemLimit ?? 25,
        byteLimit: HOSTED_MEMBER_LOG_MAX_PAGE_BYTES,
        timeLimitMs: HOSTED_MEMBER_LOG_MAX_PAGE_TIME_MS,
        usedItems: entries.length,
        usedBytes,
        elapsedMs: 1,
      },
    };
    const measured = hostedMemberLogPageByteLength(candidate);
    if (measured === usedBytes) return candidate;
    usedBytes = measured;
  }
  throw new Error('member-log-test-page-byte-budget-did-not-converge');
}

function Probe(props: {
  readonly selectionId: HostedMemberLogSelectionId;
  readonly transport: HostedMemberLogTransport;
  readonly pageLimit?: number;
  readonly onRender?: (result: UseHostedMemberLogResult) => void;
}): React.JSX.Element | null {
  const result = useHostedMemberLog({
    selectionId: props.selectionId,
    transport: props.transport,
    pageLimit: props.pageLimit,
  });
  latest = result;
  props.onRender?.(result);
  return null;
}

async function renderAndFlush(
  root: ReturnType<typeof createRoot>,
  selectionId: HostedMemberLogSelectionId,
  transport: HostedMemberLogTransport,
  pageLimit?: number
): Promise<void> {
  await act(async () => {
    root.render(<Probe selectionId={selectionId} transport={transport} pageLimit={pageLimit} />);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('useHostedMemberLog', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    latest = null;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('merges a bounded same-generation continuation in authority order', async () => {
    const getPage = vi.fn<HostedMemberLogTransport['getPage']>();
    getPage
      .mockResolvedValueOnce({
        kind: 'success' as const,
        page: page([entry(1)], { nextCursor: parseCursor('cursor_first') }),
      })
      .mockResolvedValueOnce({
        kind: 'success' as const,
        page: page([entry(2)]),
      });
    const transport: HostedMemberLogTransport = { getPage };
    const root = createRoot(document.createElement('div'));

    await renderAndFlush(root, firstSelectionId, transport);
    expect(latest).toMatchObject({
      entries: [entry(1)],
      nextCursor: 'cursor_first',
      sourceGeneration: firstGeneration,
    });

    await act(async () => {
      await latest?.loadMore();
      await Promise.resolve();
    });
    expect(latest).toMatchObject({ entries: [entry(1), entry(2)], nextCursor: null, error: null });
    expect(getPage.mock.calls[1]?.[0]).toMatchObject({
      selectionId: firstSelectionId,
      cursor: 'cursor_first',
      expectedSourceGeneration: firstGeneration,
    });
    await act(async () => root.unmount());
  });

  it('discards a stale continuation and restarts from its replacement generation', async () => {
    const getPage = vi.fn<HostedMemberLogTransport['getPage']>();
    getPage
      .mockResolvedValueOnce({
        kind: 'success' as const,
        page: page([entry(1)], { nextCursor: parseCursor('cursor_first') }),
      })
      .mockResolvedValueOnce({
        kind: 'stale_generation' as const,
        currentSourceGeneration: replacementGeneration,
      })
      .mockResolvedValueOnce({
        kind: 'success' as const,
        page: page([entry(3)], { sourceGeneration: replacementGeneration }),
      });
    const transport: HostedMemberLogTransport = { getPage };
    const root = createRoot(document.createElement('div'));

    await renderAndFlush(root, firstSelectionId, transport);
    await act(async () => {
      await latest?.loadMore();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latest).toMatchObject({
      entries: [entry(3)],
      sourceGeneration: replacementGeneration,
      nextCursor: null,
      error: null,
    });
    expect(getPage.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ selectionId: firstSelectionId, cursor: null }),
      expect.objectContaining({
        selectionId: firstSelectionId,
        cursor: 'cursor_first',
        expectedSourceGeneration: firstGeneration,
      }),
      expect.objectContaining({ selectionId: firstSelectionId, cursor: null }),
    ]);
    await act(async () => root.unmount());
  });

  it('never commits an earlier selection completion after the selected member changes', async () => {
    const first = deferred<GetHostedMemberLogPageResult>();
    const second = deferred<GetHostedMemberLogPageResult>();
    const getPage = vi.fn<HostedMemberLogTransport['getPage']>((request) =>
      request.selectionId === firstSelectionId ? first.promise : second.promise
    );
    const transport: HostedMemberLogTransport = { getPage };
    const root = createRoot(document.createElement('div'));

    await renderAndFlush(root, firstSelectionId, transport);
    expect(getPage).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(<Probe selectionId={secondSelectionId} transport={transport} />);
      await Promise.resolve();
      first.resolve({
        kind: 'success',
        page: page([entry(1)], { selectionId: firstSelectionId }),
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest).toMatchObject({ entries: [], loading: true, error: null });

    await act(async () => {
      second.resolve({
        kind: 'success',
        page: page([entry(2)], { selectionId: secondSelectionId }),
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest).toMatchObject({ entries: [entry(2)], loading: false, error: null });
    await act(async () => root.unmount());
  });

  it('synchronously masks a prior selection and transport incarnation during rerender', async () => {
    const firstTransport: HostedMemberLogTransport = {
      getPage: vi.fn(async () => ({ kind: 'success' as const, page: page([entry(1)]) })),
    };
    const second = deferred<GetHostedMemberLogPageResult>();
    const secondTransport: HostedMemberLogTransport = {
      getPage: vi.fn(() => second.promise),
    };
    const root = createRoot(document.createElement('div'));

    await renderAndFlush(root, firstSelectionId, firstTransport);
    expect(latest).toMatchObject({ entries: [entry(1)], loading: false });

    const renders: Array<{
      readonly entries: readonly HostedMemberLogEntry[];
      readonly sourceGeneration: UseHostedMemberLogResult['sourceGeneration'];
      readonly revision: UseHostedMemberLogResult['revision'];
      readonly nextCursor: UseHostedMemberLogResult['nextCursor'];
      readonly loading: boolean;
    }> = [];
    await act(async () => {
      flushSync(() => {
        root.render(
          <Probe
            selectionId={secondSelectionId}
            transport={secondTransport}
            onRender={(result) => {
              renders.push({
                entries: result.entries,
                sourceGeneration: result.sourceGeneration,
                revision: result.revision,
                nextCursor: result.nextCursor,
                loading: result.loading,
              });
            }}
          />
        );
      });
    });

    expect(renders[0]).toEqual({
      entries: [],
      sourceGeneration: null,
      revision: null,
      nextCursor: null,
      loading: true,
    });

    await act(async () => {
      second.resolve({
        kind: 'success',
        page: page([entry(2)], { selectionId: secondSelectionId }),
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest).toMatchObject({ entries: [entry(2)], loading: false });

    const third = deferred<GetHostedMemberLogPageResult>();
    const thirdTransport: HostedMemberLogTransport = {
      getPage: vi.fn(() => third.promise),
    };
    renders.length = 0;
    await act(async () => {
      flushSync(() => {
        root.render(
          <Probe
            selectionId={secondSelectionId}
            transport={thirdTransport}
            onRender={(result) => {
              renders.push({
                entries: result.entries,
                sourceGeneration: result.sourceGeneration,
                revision: result.revision,
                nextCursor: result.nextCursor,
                loading: result.loading,
              });
            }}
          />
        );
      });
    });
    expect(renders[0]).toEqual({
      entries: [],
      sourceGeneration: null,
      revision: null,
      nextCursor: null,
      loading: true,
    });

    await act(async () => {
      third.resolve({
        kind: 'success',
        page: page([entry(3)], { selectionId: secondSelectionId }),
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest).toMatchObject({ entries: [entry(3)], loading: false });
    await act(async () => root.unmount());
  });

  it('bounds retained entries and stops continuation state at the renderer limit', async () => {
    const getPage = vi.fn<HostedMemberLogTransport['getPage']>();
    for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
      const start = pageIndex * 50 + 1;
      getPage.mockResolvedValueOnce({
        kind: 'success' as const,
        page: page(
          Array.from({ length: 50 }, (_, offset) => entry(start + offset)),
          {
            nextCursor: parseCursor(`cursor_page_${pageIndex + 1}`),
            itemLimit: 50,
          }
        ),
      });
    }
    const transport: HostedMemberLogTransport = { getPage };
    const root = createRoot(document.createElement('div'));

    await renderAndFlush(root, firstSelectionId, transport, 50);
    for (let index = 0; index < 3; index += 1) {
      await act(async () => {
        await latest?.loadMore();
        await Promise.resolve();
      });
    }

    expect(latest).toMatchObject({
      entries: Array.from({ length: HOSTED_MEMBER_LOG_MAX_RENDERED_ENTRIES }, (_, index) =>
        entry(index + 1)
      ),
      nextCursor: null,
      error: null,
    });
    await act(async () => {
      await latest?.loadMore();
    });
    expect(getPage).toHaveBeenCalledTimes(4);
    await act(async () => root.unmount());
  });
});
