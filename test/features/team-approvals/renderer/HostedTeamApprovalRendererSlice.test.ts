import {
  HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
  type HostedTeamApprovalDecision,
  type HostedTeamApprovalItem,
  type HostedTeamApprovalPage,
  parseHostedTeamApprovalGeneration,
  parseHostedTeamApprovalId,
  parseHostedTeamApprovalIdempotencyKey,
  parseHostedTeamApprovalPreviewRef,
} from '@features/team-approvals/contracts';
import {
  createHostedTeamApprovalRendererSlice,
  type HostedTeamApprovalTransport,
} from '@features/team-approvals/renderer';
import { parseCursor, parseRunId, parseTeamId } from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const runId = parseRunId(`run_${'d'.repeat(32)}`);
const replacementRunId = parseRunId(`run_${'e'.repeat(32)}`);
const firstId = parseHostedTeamApprovalId(`approval_${'b'.repeat(32)}`);
const secondId = parseHostedTeamApprovalId(`approval_${'c'.repeat(32)}`);
const firstGeneration = parseHostedTeamApprovalGeneration('generation_renderer-1');
const secondGeneration = parseHostedTeamApprovalGeneration('generation_renderer-2');
const firstPreviewRef = parseHostedTeamApprovalPreviewRef('approval_preview_renderer-1');
const secondPreviewRef = parseHostedTeamApprovalPreviewRef('approval_preview_renderer-2');
const nextCursor = parseCursor('cursor_renderer-next');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function item(
  approvalId: typeof firstId,
  generation = firstGeneration,
  summary = 'Run a safe command',
  itemRunId = runId
): HostedTeamApprovalItem {
  return Object.freeze({
    teamId,
    runId: itemRunId,
    approvalId,
    generation,
    category: 'command',
    summary,
    requestedAtMs: 100,
    expiresAtMs: 10_000,
    previewRef: approvalId === firstId ? firstPreviewRef : secondPreviewRef,
  });
}

function page(
  items: readonly HostedTeamApprovalItem[],
  cursor: typeof nextCursor | null = null
): HostedTeamApprovalPage {
  return Object.freeze({
    schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
    kind: 'approval_page',
    teamId,
    items: Object.freeze([...items]),
    nextCursor: cursor,
    truncated: cursor !== null,
    budget: Object.freeze({
      itemLimit: 25,
      byteLimit: 128 * 1024,
      timeLimitMs: 250,
      usedItems: items.length,
      usedBytes: items.length * 40,
      elapsedMs: 1,
    }),
  });
}

function preview(approval: HostedTeamApprovalItem, content: string) {
  return {
    kind: 'success' as const,
    preview: Object.freeze({
      schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
      kind: 'approval_preview' as const,
      teamId,
      runId: approval.runId,
      approvalId: approval.approvalId,
      generation: approval.generation,
      content,
      byteLength: content.length,
      truncated: false,
      isBinary: false,
    }),
  };
}

function receipt(approval: HostedTeamApprovalItem, decision: HostedTeamApprovalDecision) {
  return {
    kind: 'committed' as const,
    receipt: Object.freeze({
      schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
      outcome: 'committed' as const,
      teamId,
      runId: approval.runId,
      approvalId: approval.approvalId,
      generation: approval.generation,
      decision,
    }),
  };
}

function signalSource() {
  const listeners = new Set<() => void>();
  return {
    emit: () => {
      for (const listener of listeners) listener();
    },
    size: () => listeners.size,
    port: {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}

function createHarness(transportOverrides: Partial<HostedTeamApprovalTransport> = {}) {
  const refresh = signalSource();
  const reconnect = signalSource();
  let keySequence = 0;
  let activeRunId = runId;
  const getPage = vi.fn<HostedTeamApprovalTransport['getPage']>(() =>
    Promise.resolve({ kind: 'success', page: page([]) })
  );
  const getPreview = vi.fn<HostedTeamApprovalTransport['getPreview']>(() =>
    Promise.resolve({ kind: 'unavailable' })
  );
  const decide = vi.fn<HostedTeamApprovalTransport['decide']>(() =>
    Promise.resolve({ kind: 'unavailable' })
  );
  const createKey = vi.fn(({ decision }: { readonly decision: HostedTeamApprovalDecision }) =>
    parseHostedTeamApprovalIdempotencyKey(`renderer-${decision}-${++keySequence}`)
  );
  const transport: HostedTeamApprovalTransport = {
    getPage,
    getPreview,
    decide,
    ...transportOverrides,
  };
  const slice = createHostedTeamApprovalRendererSlice({
    teamId,
    currentRunId: () => activeRunId,
    transport,
    refresh: refresh.port,
    reconnect: reconnect.port,
    idempotencyKeys: { create: createKey },
  });
  return {
    createKey,
    decide,
    getPage,
    getPreview,
    reconnect,
    refresh,
    setCurrentRunId: (value: typeof runId) => {
      activeRunId = value;
    },
    slice,
  };
}

async function mountWithPage(
  harness: ReturnType<typeof createHarness>,
  initialPage: HostedTeamApprovalPage
): Promise<() => void> {
  harness.getPage.mockResolvedValueOnce({ kind: 'success', page: initialPage });
  const unmount = harness.slice.mount();
  await vi.waitFor(() => expect(harness.slice.getSnapshot().pageStatus).toBe('ready'));
  return unmount;
}

describe('createHostedTeamApprovalRendererSlice', () => {
  it('uses authoritative page, cursor, preview and receipt results without optimistic removal', async () => {
    const harness = createHarness();
    const first = item(firstId);
    const second = item(secondId, firstGeneration, 'Write a network configuration');
    const unmount = await mountWithPage(harness, page([first], nextCursor));

    harness.getPage.mockResolvedValueOnce({ kind: 'success', page: page([second]) });
    await harness.slice.loadMore();
    expect(harness.getPage.mock.calls[1]?.[0].cursor).toBe(nextCursor);
    expect(harness.slice.getSnapshot().items).toEqual([first, second]);
    expect(harness.slice.getSnapshot().nextCursor).toBeNull();

    harness.getPreview.mockResolvedValueOnce(preview(first, 'npm test'));
    await harness.slice.selectApproval(firstId, runId);
    expect(harness.slice.getSnapshot().preview?.content).toBe('npm test');

    const pendingDecision = deferred<ReturnType<typeof receipt>>();
    const authoritativeRefresh = deferred<{
      kind: 'success';
      page: HostedTeamApprovalPage;
    }>();
    harness.decide.mockReturnValueOnce(pendingDecision.promise);
    harness.getPage.mockReturnValueOnce(authoritativeRefresh.promise);
    const decision = harness.slice.allow();

    expect(harness.slice.getSnapshot().items).toEqual([first, second]);
    expect(harness.slice.getSnapshot().pendingDecision?.decision).toBe('allow');
    expect(harness.getPage).toHaveBeenCalledTimes(2);

    pendingDecision.resolve(receipt(first, 'allow'));
    await vi.waitFor(() => expect(harness.getPage).toHaveBeenCalledTimes(3));
    expect(harness.slice.getSnapshot().items).toEqual([first, second]);
    expect(harness.slice.getSnapshot().decisionReceipt?.decision).toBe('allow');

    authoritativeRefresh.resolve({ kind: 'success', page: page([second]) });
    await decision;
    expect(harness.slice.getSnapshot()).toMatchObject({
      items: [second],
      selectedApprovalId: null,
      selectedRunId: null,
      preview: null,
      pendingDecision: null,
      decisionReceipt: { decision: 'allow', outcome: 'committed' },
      focusRequest: { approvalId: secondId },
    });
    expect(harness.createKey).toHaveBeenCalledOnce();
    expect(harness.decide.mock.calls[0]?.[0]).toMatchObject({
      approvalId: firstId,
      expectedGeneration: firstGeneration,
      decision: 'allow',
    });
    unmount();
  });

  it('fences stale page and preview completions after refresh and selection', async () => {
    const harness = createHarness();
    const first = item(firstId);
    const second = item(secondId, firstGeneration, 'Second approval');
    const unmount = await mountWithPage(harness, page([first, second]));

    const oldPage = deferred<{ kind: 'success'; page: HostedTeamApprovalPage }>();
    const currentPage = deferred<{ kind: 'success'; page: HostedTeamApprovalPage }>();
    harness.getPage.mockReturnValueOnce(oldPage.promise).mockReturnValueOnce(currentPage.promise);
    const oldReload = harness.slice.reload();
    harness.refresh.emit();
    currentPage.resolve({ kind: 'success', page: page([second]) });
    await vi.waitFor(() => expect(harness.slice.getSnapshot().items).toEqual([second]));
    oldPage.resolve({ kind: 'success', page: page([first]) });
    await oldReload;
    expect(harness.slice.getSnapshot().items).toEqual([second]);

    harness.getPage.mockResolvedValueOnce({ kind: 'success', page: page([first, second]) });
    harness.refresh.emit();
    await vi.waitFor(() => expect(harness.slice.getSnapshot().items).toHaveLength(2));
    const oldPreview = deferred<ReturnType<typeof preview>>();
    harness.getPreview
      .mockReturnValueOnce(oldPreview.promise)
      .mockResolvedValueOnce(preview(second, 'current preview'));
    const firstSelection = harness.slice.selectApproval(firstId, runId);
    await harness.slice.selectApproval(secondId, runId);
    oldPreview.resolve(preview(first, 'stale preview'));
    await firstSelection;

    expect(harness.slice.getSnapshot()).toMatchObject({
      selectedApprovalId: secondId,
      selectedRunId: runId,
      preview: { content: 'current preview' },
      previewStatus: 'ready',
    });
    unmount();
  });

  it('rejects a deferred preview after the same approval id/generation moves to another run', async () => {
    const harness = createHarness();
    const original = item(firstId);
    const replacement = item(firstId, firstGeneration, 'Replacement run approval', replacementRunId);
    const unmount = await mountWithPage(harness, page([original]));
    const oldPreview = deferred<ReturnType<typeof preview>>();
    harness.getPreview.mockReturnValueOnce(oldPreview.promise);
    const selection = harness.slice.selectApproval(firstId, runId);

    harness.setCurrentRunId(replacementRunId);
    harness.getPage.mockResolvedValueOnce({ kind: 'success', page: page([replacement]) });
    harness.refresh.emit();
    await vi.waitFor(() =>
      expect(harness.slice.getSnapshot().items[0]?.runId).toBe(replacementRunId)
    );
    oldPreview.resolve(preview(original, 'stale cross-run preview'));
    await selection;

    expect(harness.slice.getSnapshot()).toMatchObject({
      selectedApprovalId: null,
      selectedRunId: null,
      preview: null,
    });
    unmount();
  });

  it('fences stale decisions after a newer command and refreshes only the accepted receipt', async () => {
    const harness = createHarness();
    const first = item(firstId);
    const unmount = await mountWithPage(harness, page([first]));
    harness.getPreview.mockResolvedValueOnce(preview(first, 'command'));
    await harness.slice.selectApproval(firstId, runId);

    const oldAllow = deferred<ReturnType<typeof receipt>>();
    const currentDeny = deferred<ReturnType<typeof receipt>>();
    harness.decide.mockReturnValueOnce(oldAllow.promise).mockReturnValueOnce(currentDeny.promise);
    harness.getPage.mockResolvedValueOnce({ kind: 'success', page: page([]) });
    const allow = harness.slice.allow();
    const deny = harness.slice.deny();
    currentDeny.resolve(receipt(first, 'deny'));
    await deny;
    oldAllow.resolve(receipt(first, 'allow'));
    await allow;

    expect(harness.decide).toHaveBeenCalledTimes(2);
    expect(harness.getPage).toHaveBeenCalledTimes(2);
    expect(harness.slice.getSnapshot()).toMatchObject({
      items: [],
      decisionReceipt: { decision: 'deny' },
      selectedApprovalId: null,
      selectedRunId: null,
      focusRequest: { approvalId: null },
    });
    unmount();
  });

  it('fences old transport work across reconnect, unmount and remount', async () => {
    const harness = createHarness();
    const initial = deferred<{ kind: 'success'; page: HostedTeamApprovalPage }>();
    const reconnected = deferred<{ kind: 'success'; page: HostedTeamApprovalPage }>();
    harness.getPage.mockReturnValueOnce(initial.promise).mockReturnValueOnce(reconnected.promise);
    const firstUnmount = harness.slice.mount();
    harness.reconnect.emit();
    reconnected.resolve({ kind: 'success', page: page([item(secondId)]) });
    await vi.waitFor(() => expect(harness.slice.getSnapshot().items[0]?.approvalId).toBe(secondId));
    initial.resolve({ kind: 'success', page: page([item(firstId)]) });
    await initial.promise;
    expect(harness.slice.getSnapshot().items[0]?.approvalId).toBe(secondId);

    const staleRemount = deferred<{ kind: 'success'; page: HostedTeamApprovalPage }>();
    const currentRemount = deferred<{ kind: 'success'; page: HostedTeamApprovalPage }>();
    harness.getPage
      .mockReturnValueOnce(staleRemount.promise)
      .mockReturnValueOnce(currentRemount.promise);
    harness.refresh.emit();
    firstUnmount();
    expect(harness.slice.getSnapshot().mounted).toBe(false);
    const secondUnmount = harness.slice.mount();
    currentRemount.resolve({ kind: 'success', page: page([item(secondId)]) });
    await vi.waitFor(() => expect(harness.slice.getSnapshot().pageStatus).toBe('ready'));
    staleRemount.resolve({ kind: 'success', page: page([item(firstId)]) });
    await staleRemount.promise;
    expect(harness.slice.getSnapshot().items[0]?.approvalId).toBe(secondId);
    expect(harness.refresh.size()).toBe(1);
    expect(harness.reconnect.size()).toBe(1);
    secondUnmount();
    expect(harness.refresh.size()).toBe(0);
    expect(harness.reconnect.size()).toBe(0);
  });

  it('suppresses duplicate pending page, preview and decision commands', async () => {
    const harness = createHarness();
    const first = item(firstId);
    const initial = deferred<{ kind: 'success'; page: HostedTeamApprovalPage }>();
    harness.getPage.mockReturnValueOnce(initial.promise);
    const unmount = harness.slice.mount();
    const duplicatePage = harness.slice.reload();
    expect(harness.getPage).toHaveBeenCalledOnce();
    initial.resolve({ kind: 'success', page: page([first]) });
    await duplicatePage;

    const pendingPreview = deferred<ReturnType<typeof preview>>();
    harness.getPreview.mockReturnValueOnce(pendingPreview.promise);
    const selection = harness.slice.selectApproval(firstId, runId);
    const duplicateSelection = harness.slice.selectApproval(firstId, runId);
    expect(harness.getPreview).toHaveBeenCalledOnce();
    pendingPreview.resolve(preview(first, 'one preview'));
    await Promise.all([selection, duplicateSelection]);

    const pendingDecision = deferred<ReturnType<typeof receipt>>();
    harness.decide.mockReturnValueOnce(pendingDecision.promise);
    harness.getPage.mockResolvedValueOnce({ kind: 'success', page: page([]) });
    const decision = harness.slice.allow();
    const duplicateDecision = harness.slice.allow();
    expect(harness.decide).toHaveBeenCalledOnce();
    expect(harness.createKey).toHaveBeenCalledOnce();
    pendingDecision.resolve(receipt(first, 'allow'));
    await Promise.all([decision, duplicateDecision]);
    expect(harness.getPage).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('polls without overlap and stops the timer on final unmount', async () => {
    vi.useFakeTimers();
    const pending = deferred<{ kind: 'success'; page: HostedTeamApprovalPage }>();
    const harness = createHarness({ getPage: vi.fn(() => pending.promise) });
    const unmount = harness.slice.mount();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(harness.slice.getSnapshot().pageStatus).toBe('loading');
    pending.resolve({ kind: 'success', page: page([]) });
    await pending.promise;
    unmount();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(harness.slice.getSnapshot().mounted).toBe(false);
    vi.useRealTimers();
  });

  it('clears a generation-mismatched selection on mixed authoritative refresh and requests focus', async () => {
    const harness = createHarness();
    const first = item(firstId);
    const second = item(secondId, firstGeneration, 'Second approval');
    const unmount = await mountWithPage(harness, page([first, second]));
    harness.getPreview.mockResolvedValueOnce(preview(first, 'old generation'));
    await harness.slice.selectApproval(firstId, runId);

    harness.getPage.mockResolvedValueOnce({
      kind: 'success',
      page: page([item(firstId, secondGeneration, 'Updated approval'), second]),
    });
    harness.refresh.emit();
    await vi.waitFor(() => expect(harness.slice.getSnapshot().pageStatus).toBe('ready'));

    expect(harness.slice.getSnapshot()).toMatchObject({
      selectedApprovalId: null,
      selectedRunId: null,
      preview: null,
      previewStatus: 'idle',
      focusRequest: { approvalId: firstId },
    });
    unmount();
  });
});
