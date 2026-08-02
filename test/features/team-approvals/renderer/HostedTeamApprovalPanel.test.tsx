import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
  type HostedTeamApprovalItem,
  type HostedTeamApprovalPage,
  parseHostedTeamApprovalGeneration,
  parseHostedTeamApprovalId,
  parseHostedTeamApprovalIdempotencyKey,
  parseHostedTeamApprovalPreviewRef,
} from '@features/team-approvals/contracts';
import {
  createHostedTeamApprovalRendererSlice,
  HostedTeamApprovalPanel,
  type HostedTeamApprovalRendererSlice,
  type HostedTeamApprovalRendererState,
  type HostedTeamApprovalTransport,
} from '@features/team-approvals/renderer';
import { parseTeamId } from '@shared/contracts/hosted';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const firstId = parseHostedTeamApprovalId(`approval_${'b'.repeat(32)}`);
const secondId = parseHostedTeamApprovalId(`approval_${'c'.repeat(32)}`);
const generation = parseHostedTeamApprovalGeneration('generation_panel-1');
const firstPreviewRef = parseHostedTeamApprovalPreviewRef('approval_preview_panel-1');
const secondPreviewRef = parseHostedTeamApprovalPreviewRef('approval_preview_panel-2');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function item(
  approvalId: typeof firstId,
  summary: string,
  previewRef = firstPreviewRef
): HostedTeamApprovalItem {
  return Object.freeze({
    teamId,
    approvalId,
    generation,
    category: 'command',
    summary,
    requestedAtMs: 100,
    expiresAtMs: null,
    previewRef,
  });
}

function page(items: readonly HostedTeamApprovalItem[]): HostedTeamApprovalPage {
  return Object.freeze({
    schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
    kind: 'approval_page',
    teamId,
    items: Object.freeze([...items]),
    nextCursor: null,
    truncated: false,
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

function signalSource() {
  const listeners = new Set<() => void>();
  return {
    emit: () => {
      for (const listener of listeners) listener();
    },
    port: {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}

function createSlice(transport: HostedTeamApprovalTransport) {
  const refresh = signalSource();
  const reconnect = signalSource();
  const slice = createHostedTeamApprovalRendererSlice({
    teamId,
    transport,
    refresh: refresh.port,
    reconnect: reconnect.port,
    idempotencyKeys: {
      create: ({ decision }) => parseHostedTeamApprovalIdempotencyKey(`panel-${decision}-command`),
    },
  });
  return { reconnect, refresh, slice };
}

async function renderPanel(
  slice: HostedTeamApprovalRendererSlice
): Promise<{ host: HTMLDivElement; root: Root }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<HostedTeamApprovalPanel slice={slice} />);
    await Promise.resolve();
  });
  return { host, root };
}

function focusedSlice(approval: HostedTeamApprovalItem): HostedTeamApprovalRendererSlice {
  const snapshot: HostedTeamApprovalRendererState = Object.freeze({
    mounted: true,
    items: Object.freeze([approval]),
    nextCursor: null,
    pageStatus: 'ready',
    pageError: null,
    selectedApprovalId: null,
    preview: null,
    previewStatus: 'idle',
    previewError: null,
    pendingDecision: null,
    decisionReceipt: null,
    decisionError: null,
    focusRequest: Object.freeze({ sequence: 1, approvalId: approval.approvalId }),
  });
  const noOp = async (): Promise<void> => undefined;
  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    mount: () => () => undefined,
    reload: noOp,
    loadMore: noOp,
    selectApproval: noOp,
    allow: noOp,
    deny: noOp,
  });
}

describe('HostedTeamApprovalPanel', () => {
  beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('renders accessible shared controls and authoritative preview content without native titles', async () => {
    const first = item(firstId, 'Run project tests');
    const transport: HostedTeamApprovalTransport = {
      getPage: vi.fn().mockResolvedValue({ kind: 'success', page: page([first]) }),
      getPreview: vi.fn().mockResolvedValue({
        kind: 'success',
        preview: {
          schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
          kind: 'approval_preview',
          teamId,
          approvalId: firstId,
          generation,
          content: 'pnpm test --filter approvals',
          byteLength: 28,
          truncated: false,
          isBinary: false,
        },
      }),
      decide: vi.fn().mockResolvedValue({ kind: 'unavailable' }),
    };
    const { slice } = createSlice(transport);
    const { host, root } = await renderPanel(slice);
    await vi.waitFor(() => expect(host.textContent).toContain('Run project tests'));

    const refresh = host.querySelector<HTMLButtonElement>('button[aria-label="Refresh approvals"]');
    const approval = host.querySelector<HTMLButtonElement>(`[data-approval-id="${firstId}"]`);
    expect(refresh).not.toBeNull();
    expect(approval?.getAttribute('aria-pressed')).toBe('false');
    expect(host.querySelector('[title]')).toBeNull();
    expect(host.querySelector('ul[aria-label="Pending approval requests"]')).not.toBeNull();

    await act(async () => {
      approval?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(transport.getPreview).toHaveBeenCalledOnce();
    expect(host.textContent).toContain('pnpm test --filter approvals');
    expect(host.querySelector(`button[aria-label="Allow: ${first.summary}"]`)).not.toBeNull();
    expect(host.querySelector(`button[aria-label="Deny: ${first.summary}"]`)).not.toBeNull();
    act(() => root.unmount());
  });

  it('suppresses duplicate decisions, waits for authoritative refresh and focuses the next request', async () => {
    const first = item(firstId, 'First approval');
    const second = item(secondId, 'Second approval', secondPreviewRef);
    const decision = deferred<Awaited<ReturnType<HostedTeamApprovalTransport['decide']>>>();
    const refreshedPage = deferred<Awaited<ReturnType<HostedTeamApprovalTransport['getPage']>>>();
    const getPage = vi
      .fn<HostedTeamApprovalTransport['getPage']>()
      .mockResolvedValueOnce({ kind: 'success', page: page([first, second]) })
      .mockReturnValueOnce(refreshedPage.promise);
    const decide = vi
      .fn<HostedTeamApprovalTransport['decide']>()
      .mockReturnValueOnce(decision.promise);
    const transport: HostedTeamApprovalTransport = {
      getPage,
      getPreview: vi.fn().mockResolvedValue({ kind: 'unavailable' }),
      decide,
    };
    const { slice } = createSlice(transport);
    const { host, root } = await renderPanel(slice);
    await vi.waitFor(() => expect(host.textContent).toContain('First approval'));

    await act(async () => {
      host.querySelector<HTMLButtonElement>(`[data-approval-id="${firstId}"]`)?.click();
      await Promise.resolve();
    });
    const allow = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Allow: First approval"]'
    );
    await act(async () => {
      allow?.click();
      allow?.click();
      await Promise.resolve();
    });
    expect(decide).toHaveBeenCalledOnce();
    expect(host.textContent).toContain('First approval');

    await act(async () => {
      decision.resolve({
        kind: 'committed',
        receipt: {
          schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
          outcome: 'committed',
          teamId,
          approvalId: firstId,
          generation,
          decision: 'allow',
        },
      });
      await decision.promise;
      await Promise.resolve();
    });
    expect(getPage).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('First approval');

    await act(async () => {
      refreshedPage.resolve({ kind: 'success', page: page([second]) });
      await refreshedPage.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    const secondButton = host.querySelector<HTMLButtonElement>(`[data-approval-id="${secondId}"]`);
    expect(host.textContent).not.toContain('First approval');
    expect(host.textContent).toContain('Allowed and confirmed by the server.');
    expect(document.activeElement).toBe(secondButton);
    act(() => root.unmount());
  });

  it('lets remount and reconnect fence stale content without stealing focus', async () => {
    const staleMount = deferred<Awaited<ReturnType<HostedTeamApprovalTransport['getPage']>>>();
    const currentMount = deferred<Awaited<ReturnType<HostedTeamApprovalTransport['getPage']>>>();
    const staleReconnect = deferred<Awaited<ReturnType<HostedTeamApprovalTransport['getPage']>>>();
    const currentReconnect =
      deferred<Awaited<ReturnType<HostedTeamApprovalTransport['getPage']>>>();
    const getPage = vi
      .fn<HostedTeamApprovalTransport['getPage']>()
      .mockReturnValueOnce(staleMount.promise)
      .mockReturnValueOnce(currentMount.promise)
      .mockReturnValueOnce(staleReconnect.promise)
      .mockReturnValueOnce(currentReconnect.promise);
    const transport: HostedTeamApprovalTransport = {
      getPage,
      getPreview: vi.fn().mockResolvedValue({ kind: 'unavailable' }),
      decide: vi.fn().mockResolvedValue({ kind: 'unavailable' }),
    };
    const { reconnect, slice } = createSlice(transport);
    const firstRender = await renderPanel(slice);
    act(() => firstRender.root.unmount());

    const secondRender = await renderPanel(slice);
    await act(async () => {
      currentMount.resolve({
        kind: 'success',
        page: page([item(secondId, 'Current mount', secondPreviewRef)]),
      });
      await currentMount.promise;
      await Promise.resolve();
    });
    const refresh = secondRender.host.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh approvals"]'
    );
    await act(async () => {
      refresh?.focus();
      await Promise.resolve();
    });
    await act(async () => {
      staleMount.resolve({ kind: 'success', page: page([item(firstId, 'Stale mount')]) });
      await staleMount.promise;
      await Promise.resolve();
    });
    expect(secondRender.host.textContent).toContain('Current mount');
    expect(secondRender.host.textContent).not.toContain('Stale mount');
    expect(document.activeElement).toBe(refresh);

    await act(async () => {
      refresh?.click();
      reconnect.emit();
      await Promise.resolve();
    });
    await act(async () => {
      currentReconnect.resolve({
        kind: 'success',
        page: page([item(secondId, 'Current reconnect', secondPreviewRef)]),
      });
      await currentReconnect.promise;
      await Promise.resolve();
    });
    const currentButton = secondRender.host.querySelector<HTMLButtonElement>(
      `[data-approval-id="${secondId}"]`
    );
    await act(async () => {
      currentButton?.focus();
      await Promise.resolve();
    });
    await act(async () => {
      staleReconnect.resolve({ kind: 'success', page: page([item(firstId, 'Stale reconnect')]) });
      await staleReconnect.promise;
      await Promise.resolve();
    });
    expect(secondRender.host.textContent).toContain('Current reconnect');
    expect(secondRender.host.textContent).not.toContain('Stale reconnect');
    expect(document.activeElement).toBe(currentButton);
    act(() => secondRender.root.unmount());
  });

  it('applies an equal focus sequence after a slice prop rebind without remounting', async () => {
    const firstSlice = focusedSlice(item(firstId, 'First slice'));
    const secondSlice = focusedSlice(item(secondId, 'Second slice', secondPreviewRef));
    const { host, root } = await renderPanel(firstSlice);
    const section = host.querySelector('section');
    expect(document.activeElement).toBe(
      host.querySelector<HTMLButtonElement>(`[data-approval-id="${firstId}"]`)
    );

    await act(async () => {
      root.render(<HostedTeamApprovalPanel slice={secondSlice} />);
      await Promise.resolve();
    });

    expect(host.querySelector('section')).toBe(section);
    expect(document.activeElement).toBe(
      host.querySelector<HTMLButtonElement>(`[data-approval-id="${secondId}"]`)
    );
    act(() => root.unmount());
  });
});
