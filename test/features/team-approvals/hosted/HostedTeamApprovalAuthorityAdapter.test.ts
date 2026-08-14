import {
  HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
  type HostedTeamApprovalDecisionCommand,
  type HostedTeamApprovalDecisionReceipt,
  type HostedTeamApprovalItem,
  parseHostedTeamApprovalGeneration,
  parseHostedTeamApprovalId,
  parseHostedTeamApprovalIdempotencyKey,
  parseHostedTeamApprovalPreviewRef,
} from '@features/team-approvals/contracts';
import {
  HOSTED_TEAM_APPROVAL_MAX_PAGE_BYTES,
  HOSTED_TEAM_APPROVAL_MAX_PREVIEW_BYTES,
  HOSTED_TEAM_APPROVAL_MAX_SOURCE_ITEMS,
} from '@features/team-approvals/core/application/models/HostedTeamApprovalModels';
import { HostedTeamApprovalAuthorityAdapter } from '@features/team-approvals/main/adapters/output/HostedTeamApprovalAuthorityAdapter';
import {
  createQueryContext,
  parseCursor,
  parseRunId,
  parseTeamId,
  type QueryContext,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import type {
  HostedTeamApprovalDecisionAdmissionResult,
  HostedTeamApprovalPageSourceRequest,
  HostedTeamApprovalPageSourceResult,
  HostedTeamApprovalPreviewSourceRequest,
  HostedTeamApprovalPreviewSourceResult,
} from '@features/team-approvals/core/application/ports/HostedTeamApprovalPorts';
import type { HostedTeamApprovalAuthorityPort } from '@features/team-approvals/main/hosted';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const runId = parseRunId(`run_${'e'.repeat(32)}`);
const otherTeamId = parseTeamId(`team_${'b'.repeat(32)}`);
const approvalId = parseHostedTeamApprovalId(`approval_${'c'.repeat(32)}`);
const otherApprovalId = parseHostedTeamApprovalId(`approval_${'d'.repeat(32)}`);
const generation = parseHostedTeamApprovalGeneration('generation_authority-1');
const replacementGeneration = parseHostedTeamApprovalGeneration('generation_authority-2');
const previewRef = parseHostedTeamApprovalPreviewRef('approval_preview_authority-1');
const cursor = parseCursor('cursor_approval-authority-1');
const nextCursor = parseCursor('cursor_approval-authority-2');

function context(deadlineAtMs = 1_000, signal = new AbortController().signal): QueryContext {
  return createQueryContext({
    actorId: 'actor_approval-authority',
    sessionId: 'session_approval-authority',
    deploymentId: 'deployment_approval-authority',
    bootId: 'boot_approval-authority',
    requestId: 'request_approval-authority',
    authorizedScope: 'scope_approval-authority',
    deadlineAtMs,
    signal,
  });
}

function item(overrides: Partial<HostedTeamApprovalItem> = {}): HostedTeamApprovalItem {
  return Object.freeze({
    teamId,
    runId,
    approvalId,
    generation,
    category: 'command',
    summary: 'Allow the bounded operation',
    requestedAtMs: 100,
    expiresAtMs: 900,
    previewRef,
    ...overrides,
  });
}

function pageRequest(
  overrides: Partial<HostedTeamApprovalPageSourceRequest> = {}
): HostedTeamApprovalPageSourceRequest {
  return Object.freeze({
    teamId,
    cursor: null,
    itemLimit: 2,
    byteLimit: HOSTED_TEAM_APPROVAL_MAX_PAGE_BYTES,
    deadlineAtMs: 500,
    ...overrides,
  });
}

function foundPage(
  candidates: Extract<HostedTeamApprovalPageSourceResult, { kind: 'found' }>['candidates'] = [
    { item: item(), cursorAfter: nextCursor },
  ],
  overrides: Partial<Extract<HostedTeamApprovalPageSourceResult, { kind: 'found' }>> = {}
): Extract<HostedTeamApprovalPageSourceResult, { kind: 'found' }> {
  return Object.freeze({
    kind: 'found',
    teamId,
    candidates: Object.freeze([...candidates]),
    hasMore: false,
    ...overrides,
  });
}

function previewRequest(
  overrides: Partial<HostedTeamApprovalPreviewSourceRequest> = {}
): HostedTeamApprovalPreviewSourceRequest {
  return Object.freeze({
    teamId,
    expectedRunId: runId,
    approvalId,
    expectedGeneration: generation,
    previewRef,
    byteLimit: HOSTED_TEAM_APPROVAL_MAX_PREVIEW_BYTES,
    deadlineAtMs: 500,
    ...overrides,
  });
}

function foundPreview(
  overrides: Partial<
    Extract<HostedTeamApprovalPreviewSourceResult, { kind: 'found' }>['preview']
  > = {}
): Extract<HostedTeamApprovalPreviewSourceResult, { kind: 'found' }> {
  return Object.freeze({
    kind: 'found',
    preview: Object.freeze({
      teamId,
      runId,
      approvalId,
      generation,
      content: 'preview',
      byteLength: 7,
      truncated: false,
      isBinary: false,
      ...overrides,
    }),
  });
}

function decisionCommand(
  overrides: Partial<HostedTeamApprovalDecisionCommand> = {}
): HostedTeamApprovalDecisionCommand {
  return Object.freeze({
    schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
    teamId,
    expectedRunId: runId,
    approvalId,
    expectedGeneration: generation,
    idempotencyKey: parseHostedTeamApprovalIdempotencyKey('approval-authority-key-1'),
    decision: 'allow',
    ...overrides,
  });
}

function receipt(
  outcome: HostedTeamApprovalDecisionReceipt['outcome'],
  overrides: Partial<HostedTeamApprovalDecisionReceipt> = {}
): HostedTeamApprovalDecisionReceipt {
  return Object.freeze({
    schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
    outcome,
    teamId,
    runId,
    approvalId,
    generation,
    decision: 'allow',
    ...overrides,
  } as HostedTeamApprovalDecisionReceipt);
}

function authorityHarness(
  options: {
    readonly page?: unknown;
    readonly preview?: unknown;
    readonly decision?: unknown;
  } = {}
) {
  const readPendingPage = vi.fn<HostedTeamApprovalAuthorityPort['readPendingPage']>(
    async () => (options.page ?? foundPage()) as HostedTeamApprovalPageSourceResult
  );
  const readPreviewByOpaqueRef = vi.fn<HostedTeamApprovalAuthorityPort['readPreviewByOpaqueRef']>(
    async () => (options.preview ?? foundPreview()) as HostedTeamApprovalPreviewSourceResult
  );
  const compareAndClaimDecision = vi.fn<HostedTeamApprovalAuthorityPort['compareAndClaimDecision']>(
    async () =>
      (options.decision ?? { kind: 'not_found' }) as HostedTeamApprovalDecisionAdmissionResult
  );
  const authority: HostedTeamApprovalAuthorityPort = {
    readPendingPage,
    readPreviewByOpaqueRef,
    compareAndClaimDecision,
  };
  return { authority, readPendingPage, readPreviewByOpaqueRef, compareAndClaimDecision };
}

describe('HostedTeamApprovalAuthorityAdapter pending pages', () => {
  it('preserves bounded authority order and propagates the exact request and QueryContext', async () => {
    const second = item({ approvalId: otherApprovalId });
    const candidates = [
      Object.freeze({ item: item(), cursorAfter: cursor }),
      Object.freeze({ item: second, cursorAfter: nextCursor }),
    ];
    const harness = authorityHarness({ page: foundPage(candidates) });
    const adapter = new HostedTeamApprovalAuthorityAdapter(harness.authority, { now: () => 10 });
    const request = pageRequest();
    const queryContext = context();

    await expect(adapter.readPage(request, queryContext)).resolves.toEqual({
      kind: 'found',
      teamId,
      candidates,
      hasMore: false,
    });
    expect(harness.readPendingPage).toHaveBeenCalledWith(request, queryContext);
    expect(harness.readPendingPage.mock.calls[0]?.[0]).toEqual(request);
    expect(Object.isFrozen(harness.readPendingPage.mock.calls[0]?.[0])).toBe(true);
    expect(harness.readPendingPage.mock.calls[0]?.[1]).toBe(queryContext);
  });

  it('maps every stable non-page result and rejects widened failure records', async () => {
    const cases: readonly [unknown, HostedTeamApprovalPageSourceResult][] = [
      [{ kind: 'not_found' }, { kind: 'not_found' }],
      [{ kind: 'unavailable' }, { kind: 'unavailable' }],
      [
        { kind: 'unavailable', retryAfterMs: 250 },
        { kind: 'unavailable', retryAfterMs: 250 },
      ],
      [{ kind: 'not_found', detail: 'private' }, { kind: 'unavailable' }],
      [{ kind: 'unavailable', retryAfterMs: 60_001 }, { kind: 'unavailable' }],
    ];

    for (const [authorityResult, expected] of cases) {
      const harness = authorityHarness({ page: authorityResult });
      const adapter = new HostedTeamApprovalAuthorityAdapter(harness.authority, { now: () => 10 });
      await expect(adapter.readPage(pageRequest(), context())).resolves.toEqual(expected);
    }
  });

  it('fails closed on team, candidate, cursor, uniqueness, and byte-budget mismatches', async () => {
    const invalidResults: readonly unknown[] = [
      foundPage(undefined, { teamId: otherTeamId }),
      foundPage([{ item: item({ teamId: otherTeamId }), cursorAfter: nextCursor }]),
      foundPage([
        { item: item(), cursorAfter: cursor },
        { item: item(), cursorAfter: nextCursor },
      ]),
      foundPage([
        { item: item(), cursorAfter: cursor },
        { item: item({ approvalId: otherApprovalId }), cursorAfter: cursor },
      ]),
      foundPage([{ item: item(), cursorAfter: cursor }]),
      foundPage([], { hasMore: true }),
      foundPage([{ item: { ...item(), privateField: true } as never, cursorAfter: nextCursor }]),
      foundPage([
        { item: item(), cursorAfter: cursor },
        { item: item({ approvalId: otherApprovalId }), cursorAfter: nextCursor },
      ]),
      foundPage(),
    ];

    for (const [index, invalidResult] of invalidResults.entries()) {
      const harness = authorityHarness({ page: invalidResult });
      const adapter = new HostedTeamApprovalAuthorityAdapter(harness.authority, { now: () => 10 });
      const request = pageRequest({
        ...(index === 4 ? { cursor } : {}),
        ...(index === 7 ? { itemLimit: 1 } : {}),
        ...(index === 8 ? { byteLimit: 10 } : {}),
      });
      await expect(adapter.readPage(request, context())).resolves.toEqual({ kind: 'unavailable' });
    }
  });

  it('rejects invalid bounds and fails closed before and after abort or deadline expiry', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const harness = authorityHarness();
    const adapter = new HostedTeamApprovalAuthorityAdapter(harness.authority, { now: () => 10 });
    const invalidRequests: readonly HostedTeamApprovalPageSourceRequest[] = [
      { ...pageRequest(), itemLimit: HOSTED_TEAM_APPROVAL_MAX_SOURCE_ITEMS + 1 },
      { ...pageRequest(), byteLimit: HOSTED_TEAM_APPROVAL_MAX_PAGE_BYTES + 1 },
      { ...pageRequest(), deadlineAtMs: 1_001 },
      { ...pageRequest(), extra: true } as never,
    ];
    for (const request of invalidRequests) {
      await expect(adapter.readPage(request, context())).resolves.toEqual({ kind: 'unavailable' });
    }
    await expect(adapter.readPage(pageRequest(), context(1_000, aborted.signal))).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(harness.readPendingPage).not.toHaveBeenCalled();

    let now = 10;
    const late = authorityHarness();
    late.readPendingPage.mockImplementationOnce(async () => {
      now = 500;
      return foundPage();
    });
    const lateAdapter = new HostedTeamApprovalAuthorityAdapter(late.authority, { now: () => now });
    await expect(lateAdapter.readPage(pageRequest(), context())).resolves.toEqual({
      kind: 'unavailable',
    });

    const faulting = authorityHarness();
    faulting.readPendingPage.mockRejectedValueOnce(new Error('private failure'));
    const containing = new HostedTeamApprovalAuthorityAdapter(faulting.authority, {
      now: () => 10,
    });
    await expect(containing.readPage(pageRequest(), context())).resolves.toEqual({
      kind: 'unavailable',
    });
  });
});

describe('HostedTeamApprovalAuthorityAdapter previews', () => {
  it('returns only an exactly bound opaque preview and propagates QueryContext identity', async () => {
    const harness = authorityHarness();
    const adapter = new HostedTeamApprovalAuthorityAdapter(harness.authority, { now: () => 10 });
    const request = previewRequest();
    const queryContext = context();

    await expect(adapter.readPreview(request, queryContext)).resolves.toEqual(foundPreview());
    expect(harness.readPreviewByOpaqueRef).toHaveBeenCalledWith(request, queryContext);
    expect(harness.readPreviewByOpaqueRef.mock.calls[0]?.[0]).toEqual(request);
    expect(Object.isFrozen(harness.readPreviewByOpaqueRef.mock.calls[0]?.[0])).toBe(true);
    expect(harness.readPreviewByOpaqueRef.mock.calls[0]?.[1]).toBe(queryContext);
  });

  it('maps every stable preview result and rejects contradictory generations', async () => {
    const cases: readonly [unknown, HostedTeamApprovalPreviewSourceResult][] = [
      [{ kind: 'not_found' }, { kind: 'not_found' }],
      [
        { kind: 'stale_generation', currentGeneration: replacementGeneration },
        { kind: 'stale_generation', currentGeneration: replacementGeneration },
      ],
      [{ kind: 'unavailable' }, { kind: 'unavailable' }],
      [
        { kind: 'unavailable', retryAfterMs: 250 },
        { kind: 'unavailable', retryAfterMs: 250 },
      ],
      [{ kind: 'stale_generation', currentGeneration: generation }, { kind: 'unavailable' }],
      [
        { kind: 'stale_generation', currentGeneration: replacementGeneration, detail: true },
        { kind: 'unavailable' },
      ],
    ];

    for (const [authorityResult, expected] of cases) {
      const harness = authorityHarness({ preview: authorityResult });
      const adapter = new HostedTeamApprovalAuthorityAdapter(harness.authority, { now: () => 10 });
      await expect(adapter.readPreview(previewRequest(), context())).resolves.toEqual(expected);
    }
  });

  it('fails closed on team, approval, generation, shape, and byte binding mismatches', async () => {
    const invalidResults: readonly unknown[] = [
      foundPreview({ teamId: otherTeamId }),
      foundPreview({ approvalId: otherApprovalId }),
      foundPreview({ generation: replacementGeneration }),
      foundPreview({ byteLength: HOSTED_TEAM_APPROVAL_MAX_PREVIEW_BYTES + 1 }),
      { ...foundPreview(), previewRef },
      { kind: 'found', preview: { ...foundPreview().preview, privateField: true } },
    ];
    for (const invalidResult of invalidResults) {
      const harness = authorityHarness({ preview: invalidResult });
      const adapter = new HostedTeamApprovalAuthorityAdapter(harness.authority, { now: () => 10 });
      await expect(adapter.readPreview(previewRequest(), context())).resolves.toEqual({
        kind: 'unavailable',
      });
    }
  });

  it('rejects invalid requests and fails closed before and after abort or deadline expiry', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const harness = authorityHarness();
    const adapter = new HostedTeamApprovalAuthorityAdapter(harness.authority, { now: () => 10 });
    const invalidRequests: readonly HostedTeamApprovalPreviewSourceRequest[] = [
      { ...previewRequest(), byteLimit: HOSTED_TEAM_APPROVAL_MAX_PREVIEW_BYTES + 1 },
      { ...previewRequest(), deadlineAtMs: 1_001 },
      { ...previewRequest(), previewRef: 'approval_preview_not valid' } as never,
      { ...previewRequest(), privateField: true } as never,
    ];
    for (const request of invalidRequests) {
      await expect(adapter.readPreview(request, context())).resolves.toEqual({
        kind: 'unavailable',
      });
    }
    await expect(
      adapter.readPreview(previewRequest(), context(1_000, aborted.signal))
    ).resolves.toEqual({ kind: 'unavailable' });
    expect(harness.readPreviewByOpaqueRef).not.toHaveBeenCalled();

    let now = 10;
    const late = authorityHarness();
    late.readPreviewByOpaqueRef.mockImplementationOnce(async () => {
      now = 500;
      return foundPreview();
    });
    const lateAdapter = new HostedTeamApprovalAuthorityAdapter(late.authority, { now: () => now });
    await expect(lateAdapter.readPreview(previewRequest(), context())).resolves.toEqual({
      kind: 'unavailable',
    });

    const faulting = authorityHarness();
    faulting.readPreviewByOpaqueRef.mockRejectedValueOnce(new Error('private failure'));
    const containing = new HostedTeamApprovalAuthorityAdapter(faulting.authority, {
      now: () => 10,
    });
    await expect(containing.readPreview(previewRequest(), context())).resolves.toEqual({
      kind: 'unavailable',
    });
  });
});

describe('HostedTeamApprovalAuthorityAdapter decisions', () => {
  it.each(['committed', 'idempotent_replay'] as const)(
    'returns a validated durable %s receipt with exact command and context identity',
    async (outcome) => {
      const command = decisionCommand();
      const durableReceipt = receipt(outcome);
      const harness = authorityHarness({ decision: { kind: outcome, receipt: durableReceipt } });
      const adapter = new HostedTeamApprovalAuthorityAdapter(harness.authority, { now: () => 10 });
      const queryContext = context();

      await expect(adapter.admit(command, queryContext)).resolves.toEqual({
        kind: outcome,
        receipt: durableReceipt,
      });
      expect(harness.compareAndClaimDecision).toHaveBeenCalledWith(command, queryContext);
      expect(harness.compareAndClaimDecision.mock.calls[0]?.[0]).toEqual(command);
      expect(Object.isFrozen(harness.compareAndClaimDecision.mock.calls[0]?.[0])).toBe(true);
      expect(harness.compareAndClaimDecision.mock.calls[0]?.[1]).toBe(queryContext);
    }
  );

  it('maps every stable non-receipt decision result', async () => {
    const cases: readonly [unknown, HostedTeamApprovalDecisionAdmissionResult][] = [
      [
        { kind: 'already_resolved', generation, decision: 'deny' },
        { kind: 'already_resolved', generation, decision: 'deny' },
      ],
      [
        { kind: 'stale_generation', currentGeneration: replacementGeneration },
        { kind: 'stale_generation', currentGeneration: replacementGeneration },
      ],
      [
        { kind: 'conflict', reason: 'idempotency_mismatch' },
        { kind: 'conflict', reason: 'idempotency_mismatch' },
      ],
      [{ kind: 'expired' }, { kind: 'expired' }],
      [{ kind: 'not_found' }, { kind: 'not_found' }],
      [{ kind: 'unavailable' }, { kind: 'unavailable' }],
      [
        { kind: 'unavailable', retryAfterMs: 250 },
        { kind: 'unavailable', retryAfterMs: 250 },
      ],
    ];

    for (const [authorityResult, expected] of cases) {
      const harness = authorityHarness({ decision: authorityResult });
      const adapter = new HostedTeamApprovalAuthorityAdapter(harness.authority, { now: () => 10 });
      await expect(adapter.admit(decisionCommand(), context())).resolves.toEqual(expected);
    }
  });

  it('rejects mismatched receipt identity, outcome, generation, decision, and widened data', async () => {
    const invalidReceipts: readonly unknown[] = [
      receipt('committed', { teamId: otherTeamId }),
      receipt('committed', { approvalId: otherApprovalId }),
      receipt('committed', { generation: replacementGeneration }),
      receipt('committed', { decision: 'deny' }),
      receipt('idempotent_replay'),
      { ...receipt('committed'), deliveryToken: 'private' },
    ];
    for (const invalidReceipt of invalidReceipts) {
      const harness = authorityHarness({
        decision: { kind: 'committed', receipt: invalidReceipt },
      });
      const adapter = new HostedTeamApprovalAuthorityAdapter(harness.authority, { now: () => 10 });
      await expect(adapter.admit(decisionCommand(), context())).resolves.toEqual({
        kind: 'unavailable',
      });
    }
  });

  it('fails closed on contradictory or widened stable results', async () => {
    const invalidResults: readonly unknown[] = [
      { kind: 'already_resolved', generation: replacementGeneration, decision: 'allow' },
      { kind: 'already_resolved', generation, decision: 'invalid' },
      { kind: 'stale_generation', currentGeneration: generation },
      { kind: 'conflict', reason: 'private_conflict' },
      { kind: 'expired', detail: true },
      { kind: 'unavailable', retryAfterMs: 60_001 },
    ];
    for (const invalidResult of invalidResults) {
      const harness = authorityHarness({ decision: invalidResult });
      const adapter = new HostedTeamApprovalAuthorityAdapter(harness.authority, { now: () => 10 });
      await expect(adapter.admit(decisionCommand(), context())).resolves.toEqual({
        kind: 'unavailable',
      });
    }
  });

  it('preserves exactly-once concurrent claim outcomes without synthesizing authority state', async () => {
    let claimed = false;
    const compareAndClaimDecision = vi.fn<
      HostedTeamApprovalAuthorityPort['compareAndClaimDecision']
    >(async () => {
      if (claimed)
        return { kind: 'already_resolved' as const, generation, decision: 'allow' as const };
      claimed = true;
      return { kind: 'committed' as const, receipt: receipt('committed') };
    });
    const authority: HostedTeamApprovalAuthorityPort = {
      readPendingPage: vi.fn<HostedTeamApprovalAuthorityPort['readPendingPage']>(async () => ({
        kind: 'not_found',
      })),
      readPreviewByOpaqueRef: vi.fn<HostedTeamApprovalAuthorityPort['readPreviewByOpaqueRef']>(
        async () => ({ kind: 'not_found' })
      ),
      compareAndClaimDecision,
    };
    const adapter = new HostedTeamApprovalAuthorityAdapter(authority, { now: () => 10 });

    const results = await Promise.all([
      adapter.admit(decisionCommand(), context()),
      adapter.admit(decisionCommand(), context()),
    ]);

    expect(results).toEqual([
      { kind: 'committed', receipt: receipt('committed') },
      { kind: 'already_resolved', generation, decision: 'allow' },
    ]);
    expect(compareAndClaimDecision).toHaveBeenCalledTimes(2);
  });

  it('suppresses a late committed response and accepts its durable idempotent retry receipt', async () => {
    let now = 10;
    let attempts = 0;
    const authority: HostedTeamApprovalAuthorityPort = {
      readPendingPage: vi.fn<HostedTeamApprovalAuthorityPort['readPendingPage']>(async () => ({
        kind: 'not_found',
      })),
      readPreviewByOpaqueRef: vi.fn<HostedTeamApprovalAuthorityPort['readPreviewByOpaqueRef']>(
        async () => ({ kind: 'not_found' })
      ),
      compareAndClaimDecision: vi.fn<HostedTeamApprovalAuthorityPort['compareAndClaimDecision']>(
        async () => {
          attempts += 1;
          if (attempts === 1) now = 1_000;
          const outcome = attempts === 1 ? 'committed' : 'idempotent_replay';
          return { kind: outcome, receipt: receipt(outcome) };
        }
      ),
    };
    const adapter = new HostedTeamApprovalAuthorityAdapter(authority, { now: () => now });

    await expect(adapter.admit(decisionCommand(), context())).resolves.toEqual({
      kind: 'unavailable',
    });
    now = 10;
    await expect(adapter.admit(decisionCommand(), context())).resolves.toEqual({
      kind: 'idempotent_replay',
      receipt: receipt('idempotent_replay'),
    });
  });

  it('contains faults and does not call authority for malformed, aborted, or expired input', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const harness = authorityHarness();
    const adapter = new HostedTeamApprovalAuthorityAdapter(harness.authority, { now: () => 10 });
    await expect(
      adapter.admit({ ...decisionCommand(), privateField: true } as never, context())
    ).resolves.toEqual({ kind: 'unavailable' });
    await expect(adapter.admit(decisionCommand(), context(1_000, aborted.signal))).resolves.toEqual(
      {
        kind: 'unavailable',
      }
    );
    await expect(adapter.admit(decisionCommand(), context(10))).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(harness.compareAndClaimDecision).not.toHaveBeenCalled();

    const faulting = authorityHarness();
    faulting.compareAndClaimDecision.mockRejectedValueOnce(new Error('private failure'));
    const containing = new HostedTeamApprovalAuthorityAdapter(faulting.authority, {
      now: () => 10,
    });
    await expect(containing.admit(decisionCommand(), context())).resolves.toEqual({
      kind: 'unavailable',
    });
  });
});
