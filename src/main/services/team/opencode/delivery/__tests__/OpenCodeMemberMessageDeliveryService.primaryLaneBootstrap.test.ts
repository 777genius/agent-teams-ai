import { describe, expect, it, vi } from 'vitest';

import { OpenCodeMemberMessageDeliveryService } from '../OpenCodeMemberMessageDeliveryService';

import type {
  OpenCodeMemberMessageDeliveryInput,
  OpenCodeMemberMessageDeliveryServiceDependencies,
} from '../OpenCodeMemberMessageDeliveryPorts';

/**
 * The dependency ports as plain function-valued properties. The interface
 * declares them as methods, so asserting on a stand-in - `expect(deps.probe)` -
 * reads as an unbound method reference. Mapping them to properties says what
 * these stand-ins actually are and keeps the assertions direct.
 */
type DeliveryDeps = {
  [K in keyof OpenCodeMemberMessageDeliveryServiceDependencies]: OpenCodeMemberMessageDeliveryServiceDependencies[K];
};

const TEAM_NAME = 'lane-team';

/** The relay's ledger row for the refused prompt; see `settleUndeliverable...`. */
const ledgerRecord = {
  id: 'ledger-1',
  teamName: TEAM_NAME,
  memberName: 'team-lead',
  laneId: 'primary',
  inboxMessageId: 'launch-prompt-1',
  status: 'retry_scheduled',
  attempts: 0,
  maxAttempts: 3,
  diagnostics: [],
  nextAttemptAt: null,
};

const ensurePending = vi.fn(async () => ledgerRecord);
const schedule = vi.fn(async () => ledgerRecord);
/** The row the relay already owns, read before any lane is relaunched. */
const getByInboxMessage = vi.fn(async (): Promise<unknown> => null);

const sendMessageToMember = vi.fn(async () => ({
  ok: true,
  providerId: 'opencode' as const,
  memberName: 'team-lead',
  diagnostics: [],
}));

/**
 * The delivery boundary for a lane whose index says active and whose run is
 * tracked, but which holds no committed session record. The bridge refusal text
 * is produced outside this repo, so nothing here matches on it: the trigger is
 * the local structured probe behind `requestOpenCodePrimaryLaneRebootstrap`.
 */
function createDeps(input: {
  laneKind: 'primary' | 'secondary';
  bootstrapSession: unknown;
  requestRebootstrap?: ReturnType<typeof vi.fn>;
  /** `null` mirrors a team whose tracked run is fenced by a stop or cleanup. */
  deliverableTrackedRunId?: string | null;
}): DeliveryDeps {
  const laneId = input.laneKind === 'primary' ? 'primary' : 'secondary:opencode:worker';
  const memberName = input.laneKind === 'primary' ? 'team-lead' : 'Worker';
  return {
    createOpenCodePromptDeliveryLedger: vi.fn(() => ({ ensurePending, getByInboxMessage })),
    openCodePromptDeliveryFollowUpPolicy: { schedule },
    getOpenCodeRuntimeMessageAdapter: vi.fn(() => ({ sendMessageToMember: sendMessageToMember })),
    readOpenCodeMemberDirectory: vi.fn(async () => ({
      config: { name: TEAM_NAME, projectPath: '/repo', members: [] },
      teamMeta: null,
      metaMembers: [{ name: memberName, providerId: 'opencode' as const }],
    })),
    resolveOpenCodeMemberIdentityFromDirectory: vi.fn(() => ({
      ok: true as const,
      canonicalMemberName: memberName,
      laneId,
      laneIdentity: {
        laneId,
        laneKind: input.laneKind,
        laneOwnerProviderId: 'opencode' as const,
      },
      metaMember: { name: memberName, providerId: 'opencode' as const },
      memberRuntimeCwd: '/repo',
    })),
    stoppingSecondaryRuntimeTeams: { has: () => false },
    readPersistedTeamProjectPath: vi.fn(() => '/repo'),
    resolveDeliverableTrackedRuntimeRunId: vi.fn(() =>
      input.deliverableTrackedRunId === undefined ? 'run-a1' : input.deliverableTrackedRunId
    ),
    runs: { get: vi.fn(() => undefined) },
    getCurrentOpenCodeRuntimeRunId: vi.fn(() => 'run-a1'),
    resolveCurrentOpenCodeRuntimeRunId: vi.fn(async () => 'run-a1'),
    isOpenCodeRuntimeLaneIndexActive: vi.fn(async () => true),
    tryRecoverOpenCodeRuntimeLaneBeforeDelivery: vi.fn(async () => false),
    tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery: vi.fn(async () => false),
    cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: vi.fn(),
    deleteSecondaryRuntimeRun: vi.fn(),
    findDeliverableOpenCodeRuntimeBootstrapSessionEvidence: vi.fn(
      async () => input.bootstrapSession
    ),
    getOpenCodeAppMcpTransportMismatchDiagnostic: vi.fn(() => null),
    stampOpenCodeAppMcpTransportEvidenceIfMissing: vi.fn(async () => undefined),
    ...(input.requestRebootstrap
      ? { requestOpenCodePrimaryLaneRebootstrap: input.requestRebootstrap }
      : {}),
  } as unknown as OpenCodeMemberMessageDeliveryServiceDependencies;
}

const message: OpenCodeMemberMessageDeliveryInput = {
  memberName: 'team-lead',
  text: 'Summarize the repo',
  messageId: 'launch-prompt-1',
  source: 'watcher',
};

describe('OpenCodeMemberMessageDeliveryService primary lane bootstrap', () => {
  it('never sends when the primary lane provably holds no runtime evidence', async () => {
    sendMessageToMember.mockClear();
    const requestRebootstrap = vi.fn(async () => ({
      action: 'wait' as const,
      retryAfterMs: 15_000,
      diagnostic: 'grace',
    }));
    const service = new OpenCodeMemberMessageDeliveryService(
      createDeps({ laneKind: 'primary', bootstrapSession: null, requestRebootstrap })
    );

    const delivery = await service.deliver(TEAM_NAME, message);

    expect(delivery.delivered).toBe(false);
    expect(delivery.reason).toBe('opencode_primary_lane_bootstrap_missing');
    expect(delivery.diagnostics?.[0]).toContain('no committed session record for team-lead');
    expect(sendMessageToMember).not.toHaveBeenCalled();
  });

  /**
   * Negative control: a lane whose evidence is on disk raced its own commit, so
   * the self-heal answers `not_applicable` and the delivery must continue down
   * the unchanged path. A "healed" healthy lane would be a relaunch nobody asked
   * for.
   */
  it('falls through unchanged when the lane evidence is on disk and the probe raced it', async () => {
    const requestRebootstrap = vi.fn(async () => ({
      action: 'not_applicable' as const,
      diagnostic: 'raced',
    }));
    const service = new OpenCodeMemberMessageDeliveryService(
      createDeps({ laneKind: 'primary', bootstrapSession: null, requestRebootstrap })
    );

    const delivery = await service.deliver(TEAM_NAME, message).catch(() => null);

    expect(requestRebootstrap).toHaveBeenCalledTimes(1);
    expect(delivery?.reason).not.toBe('opencode_primary_lane_bootstrap_missing');
  });

  it('asks the self-heal exactly once, with the lane identity and run', async () => {
    const requestRebootstrap = vi.fn(async () => ({
      action: 'rebootstrap' as const,
      attempt: 1,
      retryAfterMs: 15_000,
    }));
    const service = new OpenCodeMemberMessageDeliveryService(
      createDeps({ laneKind: 'primary', bootstrapSession: null, requestRebootstrap })
    );

    const delivery = await service.deliver(TEAM_NAME, message);

    expect(requestRebootstrap).toHaveBeenCalledTimes(1);
    expect(requestRebootstrap).toHaveBeenCalledWith({
      teamName: TEAM_NAME,
      laneId: 'primary',
      memberName: 'team-lead',
      runId: 'run-a1',
      reason: 'opencode_primary_lane_bootstrap_missing',
    });
    expect(delivery.diagnostics?.[0]).toContain('re-bootstrapping the lead (attempt 1)');
  });

  it('reports an exhausted budget instead of claiming a heal', async () => {
    const requestRebootstrap = vi.fn(async () => ({
      action: 'give_up' as const,
      diagnostic: 'the lead re-bootstrap budget is exhausted for this run.',
    }));
    const service = new OpenCodeMemberMessageDeliveryService(
      createDeps({ laneKind: 'primary', bootstrapSession: null, requestRebootstrap })
    );

    const delivery = await service.deliver(TEAM_NAME, message);

    expect(delivery.diagnostics?.[0]).toContain('budget is exhausted');
  });

  // The refusal returns before the normal ledger write, so nothing ever reached
  // the follow-up policy: `give_up` produced no `failed_terminal`, no
  // `opencode_primary_lane_bootstrap_unrecoverable` row and no terminal signal.
  it('drives the relay ledger row through the follow-up policy on every refusal', async () => {
    ensurePending.mockClear();
    schedule.mockClear();
    const requestRebootstrap = vi.fn(async () => ({
      action: 'give_up' as const,
      diagnostic: 'the lead re-bootstrap budget is exhausted for this run.',
    }));
    const service = new OpenCodeMemberMessageDeliveryService(
      createDeps({ laneKind: 'primary', bootstrapSession: null, requestRebootstrap })
    );

    const delivery = await service.deliver(TEAM_NAME, message);

    expect(ensurePending).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: TEAM_NAME,
        memberName: 'team-lead',
        retry: true,
        reason: 'opencode_primary_lane_bootstrap_missing',
        selfHealExhausted: true,
      })
    );
    expect(delivery.ledgerRecordId).toBe('ledger-1');
  });

  it('does not claim an exhausted budget while the self-heal is still waiting', async () => {
    schedule.mockClear();
    const requestRebootstrap = vi.fn(async () => ({
      action: 'wait' as const,
      retryAfterMs: 15_000,
      diagnostic: 'grace',
    }));
    const service = new OpenCodeMemberMessageDeliveryService(
      createDeps({ laneKind: 'primary', bootstrapSession: null, requestRebootstrap })
    );

    await service.deliver(TEAM_NAME, message);

    expect(schedule).toHaveBeenCalledWith(expect.objectContaining({ selfHealExhausted: false }));
  });

  /**
   * Negative control: a non-primary lane must never reach the self-heal, even
   * under the identical "no committed bootstrap session" refusal. Its own
   * runtime check-in path owns that case.
   */
  it('leaves the secondary-lane behaviour unchanged under the same refusal', async () => {
    sendMessageToMember.mockClear();
    const requestRebootstrap = vi.fn(async () => ({
      action: 'rebootstrap' as const,
      attempt: 1,
      retryAfterMs: 15_000,
    }));
    const service = new OpenCodeMemberMessageDeliveryService(
      createDeps({ laneKind: 'secondary', bootstrapSession: null, requestRebootstrap })
    );

    const delivery = await service.deliver(TEAM_NAME, { ...message, memberName: 'Worker' });

    expect(delivery.reason).toBe('opencode_runtime_not_active');
    expect(delivery.diagnostics?.[0]).toContain('retried after runtime check-in');
    expect(requestRebootstrap).not.toHaveBeenCalled();
    expect(sendMessageToMember).not.toHaveBeenCalled();
  });

  it('still dispatches on the primary lane once evidence exists', async () => {
    sendMessageToMember.mockClear();
    const deps = createDeps({
      laneKind: 'primary',
      bootstrapSession: { id: 'ses_1', appMcpTransportHash: 'hash-1' },
    });
    const service = new OpenCodeMemberMessageDeliveryService(deps);

    // The dispatch chain past this point needs the full watchdog/ledger harness;
    // what this pins is that the evidence branch is still taken (the `else` at
    // the bootstrap-session check), not the new primary-lane refusal.
    const delivery = await service.deliver(TEAM_NAME, message).catch(() => null);

    expect(delivery?.reason).not.toBe('opencode_primary_lane_bootstrap_missing');
    expect(deps.getOpenCodeAppMcpTransportMismatchDiagnostic).toHaveBeenCalledTimes(1);
  });

  /**
   * Negative control: a team whose tracked run is fenced (a stop in flight, or
   * a cleanup owning the lane) must never be healed. Relaunching there would
   * race the stop that is already running, and the send path owns that refusal.
   */
  it('never asks the self-heal while the tracked run is not deliverable', async () => {
    const requestRebootstrap = vi.fn(async () => ({
      action: 'rebootstrap' as const,
      attempt: 1,
      retryAfterMs: 15_000,
    }));
    const service = new OpenCodeMemberMessageDeliveryService(
      createDeps({
        laneKind: 'primary',
        bootstrapSession: null,
        requestRebootstrap,
        deliverableTrackedRunId: null,
      })
    );

    const delivery = await service.deliver(TEAM_NAME, message).catch(() => null);

    expect(requestRebootstrap).not.toHaveBeenCalled();
    expect(delivery?.reason).not.toBe('opencode_primary_lane_bootstrap_missing');
  });

  /**
   * Negative control on the force-stop ordering: force stop persists the
   * delivery cancellation before it stops the team, so the cancelled row lands
   * while the tracked run is still deliverable. Healing there would relaunch the
   * lane into the stop that cancelled it.
   */
  it('never relaunches the lane for a row a stop has already cancelled', async () => {
    getByInboxMessage.mockImplementationOnce(async () => ({
      ...ledgerRecord,
      cancelledAt: '2026-09-04T10:00:00.000Z',
    }));
    const requestRebootstrap = vi.fn(async () => ({
      action: 'rebootstrap' as const,
      attempt: 1,
      retryAfterMs: 15_000,
    }));
    const service = new OpenCodeMemberMessageDeliveryService(
      createDeps({ laneKind: 'primary', bootstrapSession: null, requestRebootstrap })
    );

    const delivery = await service.deliver(TEAM_NAME, message);

    expect(requestRebootstrap).not.toHaveBeenCalled();
    expect(delivery.delivered).toBe(false);
    expect(delivery.reason).toBe('opencode_prompt_delivery_cancelled');
    expect(delivery.ledgerRecordId).toBe('ledger-1');
  });

  /**
   * Without the port the delivery keeps its old behaviour exactly: the refusal
   * is never escalated and the primary lane falls through as it did before, and
   * no ledger is opened to decide it.
   */
  it('changes nothing when no self-heal port is wired in', async () => {
    getByInboxMessage.mockClear();
    const service = new OpenCodeMemberMessageDeliveryService(
      createDeps({ laneKind: 'primary', bootstrapSession: null })
    );

    const delivery = await service.deliver(TEAM_NAME, message).catch(() => null);

    expect(delivery?.reason).not.toBe('opencode_primary_lane_bootstrap_missing');
    expect(getByInboxMessage).not.toHaveBeenCalled();
  });
});
