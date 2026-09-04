import { describe, expect, it, vi } from 'vitest';

import {
  PRIMARY_LANE_REBOOTSTRAP_BUDGET_EXHAUSTED_DIAGNOSTIC,
  PRIMARY_LANE_REBOOTSTRAP_DISABLED_DIAGNOSTIC,
} from '../OpenCodePrimaryLaneBootstrapSelfHeal';
import {
  OpenCodePromptDeliveryFollowUpPolicy,
  settleUndeliverableOpenCodePrimaryLaneBootstrap,
} from '../OpenCodePromptDeliveryFollowUpPolicy';
import { isOpenCodePromptDeliveryAttemptDue } from '../OpenCodePromptDeliveryLedger';

import type {
  OpenCodePromptDeliveryFollowUpDependencies,
  UndeliverableOpenCodePrimaryLaneBootstrapDeps,
} from '../OpenCodePromptDeliveryFollowUpPolicy';
import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
} from '../OpenCodePromptDeliveryLedger';
import type { Mock } from 'vitest';

const NOW_MS = 1_700_000_000_000;
const TEAM_NAME = 'lane-team';
const MEMBER_NAME = 'team-lead';
const MISSING_REASON = 'opencode_primary_lane_bootstrap_missing';

/**
 * A row that has already spent its whole send budget on an unwinnable lane:
 * `attempts === maxAttempts` with no deadline left. Terminalizing it is exactly
 * the outcome this policy branch exists to prevent, because a terminal row is
 * never re-armed: the watchdog treats it as finished.
 */
function spentLedgerRecord(): OpenCodePromptDeliveryLedgerRecord {
  return {
    id: 'ledger-1',
    teamName: TEAM_NAME,
    memberName: MEMBER_NAME,
    laneId: 'primary',
    inboxMessageId: 'launch-prompt-1',
    status: 'retry_scheduled',
    attempts: 3,
    maxAttempts: 3,
    sessionRefreshAttempts: 0,
    diagnostics: [],
    nextAttemptAt: null,
  } as unknown as OpenCodePromptDeliveryLedgerRecord;
}

/**
 * The harness the two factories below return, spelled out so each stand-in
 * carries the signature of the port it replaces: a mocked call site cannot then
 * drift from the dependency it stands for.
 */
interface PolicyHarness {
  policy: OpenCodePromptDeliveryFollowUpPolicy;
  ledger: OpenCodePromptDeliveryLedgerStore;
  markNextAttemptDeferred: Mock<OpenCodePromptDeliveryLedgerStore['markNextAttemptDeferred']>;
  markFailedTerminal: Mock<OpenCodePromptDeliveryFollowUpDependencies['markFailedTerminal']>;
  scheduleWatchdog: Mock<OpenCodePromptDeliveryFollowUpDependencies['scheduleWatchdog']>;
  logEvent: Mock<OpenCodePromptDeliveryFollowUpDependencies['logEvent']>;
}

function createPolicy(): PolicyHarness {
  const markNextAttemptDeferred = vi.fn<
    OpenCodePromptDeliveryLedgerStore['markNextAttemptDeferred']
  >(async (input) => ({
    ...spentLedgerRecord(),
    nextAttemptAt: input.nextAttemptAt,
  }));
  const markFailedTerminal = vi.fn<
    OpenCodePromptDeliveryFollowUpDependencies['markFailedTerminal']
  >(async (input) => ({
    ...spentLedgerRecord(),
    status: 'failed_terminal' as const,
    diagnostics: input.diagnostics ?? [],
  }));
  const scheduleWatchdog = vi.fn<OpenCodePromptDeliveryFollowUpDependencies['scheduleWatchdog']>();
  const logEvent = vi.fn<OpenCodePromptDeliveryFollowUpDependencies['logEvent']>();
  const policy = new OpenCodePromptDeliveryFollowUpPolicy({
    markFailedTerminal,
    logEvent,
    scheduleWatchdog,
    nowIso: () => new Date(NOW_MS).toISOString(),
    nowMs: () => NOW_MS,
  });
  const ledger = { markNextAttemptDeferred } as unknown as OpenCodePromptDeliveryLedgerStore;
  return {
    policy,
    ledger,
    markNextAttemptDeferred,
    markFailedTerminal,
    scheduleWatchdog,
    logEvent,
  };
}

describe('OpenCodePromptDeliveryFollowUpPolicy primary lane bootstrap', () => {
  /**
   * Negative control: the deferral must move only the deadline. If it spent an
   * attempt, the ladder's budget and the send budget would race and the row
   * would die before the self-heal ever got its second try.
   */
  it('defers without spending an attempt on a lane that cannot accept a send', async () => {
    const { policy, ledger, markNextAttemptDeferred, markFailedTerminal, scheduleWatchdog } =
      createPolicy();
    const before = spentLedgerRecord();

    const record = await policy.schedule({
      ledger,
      ledgerRecord: before,
      teamName: TEAM_NAME,
      memberName: MEMBER_NAME,
      retry: true,
      reason: MISSING_REASON,
    });

    expect(markFailedTerminal).not.toHaveBeenCalled();
    expect(markNextAttemptDeferred).toHaveBeenCalledTimes(1);
    expect(record.attempts).toBe(before.attempts);
    expect(record.status).toBe(before.status);
    expect(new Date(record.nextAttemptAt!).getTime()).toBeGreaterThan(NOW_MS);
    expect(scheduleWatchdog).toHaveBeenCalledWith(
      expect.objectContaining({ teamName: TEAM_NAME, memberName: MEMBER_NAME })
    );
  });

  /**
   * Negative control on the durable deadline: the deferred row must survive the
   * next due check instead of being re-armed immediately, which is the whole
   * reason the deadline has to be written durably.
   */
  it('leaves the deferred row not due until the deferral elapses', async () => {
    const { policy, ledger } = createPolicy();

    const record = await policy.schedule({
      ledger,
      ledgerRecord: spentLedgerRecord(),
      teamName: TEAM_NAME,
      memberName: MEMBER_NAME,
      retry: true,
      reason: MISSING_REASON,
    });

    expect(isOpenCodePromptDeliveryAttemptDue(record, NOW_MS + 5_000)).toBe(false);
    expect(isOpenCodePromptDeliveryAttemptDue(record, NOW_MS + 60_000)).toBe(true);
  });

  it('terminals only once the self-heal budget is exhausted', async () => {
    const { policy, ledger, markFailedTerminal, markNextAttemptDeferred } = createPolicy();

    await policy.schedule({
      ledger,
      ledgerRecord: spentLedgerRecord(),
      teamName: TEAM_NAME,
      memberName: MEMBER_NAME,
      retry: true,
      reason: MISSING_REASON,
      selfHealExhausted: true,
      selfHealDiagnostic: PRIMARY_LANE_REBOOTSTRAP_BUDGET_EXHAUSTED_DIAGNOSTIC,
    });

    expect(markNextAttemptDeferred).not.toHaveBeenCalled();
    expect(markFailedTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'opencode_primary_lane_bootstrap_unrecoverable',
        diagnostics: [MISSING_REASON, PRIMARY_LANE_REBOOTSTRAP_BUDGET_EXHAUSTED_DIAGNOSTIC],
      })
    );
  });

  /**
   * Force stop persists the delivery cancellation BEFORE the stop runs, so a
   * re-bootstrap decision taken a moment earlier can still arrive here. A
   * cancelled row is finished: deferring it would move a deadline, and arm a
   * watchdog wake, for a run the user has already ended.
   */
  it('leaves a cancelled row untouched instead of deferring it', async () => {
    const {
      policy,
      ledger,
      markNextAttemptDeferred,
      markFailedTerminal,
      scheduleWatchdog,
      logEvent,
    } = createPolicy();
    const cancelled = {
      ...spentLedgerRecord(),
      cancelledAt: new Date(NOW_MS).toISOString(),
    } as OpenCodePromptDeliveryLedgerRecord;

    const record = await policy.schedule({
      ledger,
      ledgerRecord: cancelled,
      teamName: TEAM_NAME,
      memberName: MEMBER_NAME,
      retry: true,
      reason: MISSING_REASON,
    });

    expect(record).toBe(cancelled);
    expect(markNextAttemptDeferred).not.toHaveBeenCalled();
    expect(markFailedTerminal).not.toHaveBeenCalled();
    expect(scheduleWatchdog).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
  });

  /**
   * The same fence on the terminal half of the branch: an exhausted ladder must
   * not overwrite the cancellation's own terminal reason, which is what tells the
   * force-stop path that this row was cancelled rather than abandoned.
   */
  it('never terminalizes a cancelled row when the ladder is spent', async () => {
    const { policy, ledger, markFailedTerminal } = createPolicy();

    await policy.schedule({
      ledger,
      ledgerRecord: {
        ...spentLedgerRecord(),
        cancelledAt: new Date(NOW_MS).toISOString(),
      } as OpenCodePromptDeliveryLedgerRecord,
      teamName: TEAM_NAME,
      memberName: MEMBER_NAME,
      retry: true,
      reason: MISSING_REASON,
      selfHealExhausted: true,
      selfHealDiagnostic: PRIMARY_LANE_REBOOTSTRAP_BUDGET_EXHAUSTED_DIAGNOSTIC,
    });

    expect(markFailedTerminal).not.toHaveBeenCalled();
  });

  /**
   * The cancellation can also land between the read and the deferral write. The
   * ledger refuses to move a cancelled record, so the write hands back the
   * cancelled row; nothing may then be logged or woken for it.
   */
  it('arms no wake when the cancellation lands during the deferral write', async () => {
    const { policy, ledger, markNextAttemptDeferred, scheduleWatchdog, logEvent } = createPolicy();
    markNextAttemptDeferred.mockImplementation(
      async () =>
        ({
          ...spentLedgerRecord(),
          cancelledAt: new Date(NOW_MS).toISOString(),
        }) as OpenCodePromptDeliveryLedgerRecord
    );

    const record = await policy.schedule({
      ledger,
      ledgerRecord: spentLedgerRecord(),
      teamName: TEAM_NAME,
      memberName: MEMBER_NAME,
      retry: true,
      reason: MISSING_REASON,
    });

    expect(markNextAttemptDeferred).toHaveBeenCalledTimes(1);
    expect(record.cancelledAt).toBeTruthy();
    expect(scheduleWatchdog).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
  });

  it('leaves every other reason terminalling at the attempt cap', async () => {
    const { policy, ledger, markFailedTerminal } = createPolicy();

    await policy.schedule({
      ledger,
      ledgerRecord: spentLedgerRecord(),
      teamName: TEAM_NAME,
      memberName: MEMBER_NAME,
      retry: true,
      reason: 'opencode_message_bridge_failed',
    });

    expect(markFailedTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'opencode_message_bridge_failed' })
    );
  });
});

/**
 * The refusal reason above is produced ONLY by the delivery service's
 * primary-lane refusal, which returns before any ledger row exists - so the
 * branch would be unreachable and a `give_up` would terminalize nothing. This is
 * the wiring that opens the relay's row and settles it at the refusal.
 */
describe('settleUndeliverableOpenCodePrimaryLaneBootstrap', () => {
  const message = { messageId: 'launch-prompt-1', text: 'Summarize the repo' };
  const target = {
    teamName: TEAM_NAME,
    laneId: 'primary',
    memberName: MEMBER_NAME,
    runId: 'run-a1',
  };

  function createDeps(): {
    deps: UndeliverableOpenCodePrimaryLaneBootstrapDeps;
    ensurePending: Mock<OpenCodePromptDeliveryLedgerStore['ensurePending']>;
    createOpenCodePromptDeliveryLedger: Mock<
      UndeliverableOpenCodePrimaryLaneBootstrapDeps['createOpenCodePromptDeliveryLedger']
    >;
    markFailedTerminal: PolicyHarness['markFailedTerminal'];
    markNextAttemptDeferred: PolicyHarness['markNextAttemptDeferred'];
  } {
    const { policy, ledger, markFailedTerminal, markNextAttemptDeferred } = createPolicy();
    const ensurePending = vi.fn<OpenCodePromptDeliveryLedgerStore['ensurePending']>(async () =>
      spentLedgerRecord()
    );
    Object.assign(ledger, { ensurePending });
    const createOpenCodePromptDeliveryLedger = vi.fn<
      UndeliverableOpenCodePrimaryLaneBootstrapDeps['createOpenCodePromptDeliveryLedger']
    >(() => ledger);
    return {
      deps: {
        createOpenCodePromptDeliveryLedger,
        openCodePromptDeliveryFollowUpPolicy: policy,
        nowIso: () => new Date(NOW_MS).toISOString(),
      },
      ensurePending,
      createOpenCodePromptDeliveryLedger,
      markFailedTerminal,
      markNextAttemptDeferred,
    };
  }

  it('opens the relay ledger row and defers it while the budget holds', async () => {
    const { deps, ensurePending, markNextAttemptDeferred, markFailedTerminal } = createDeps();

    const delivery = await settleUndeliverableOpenCodePrimaryLaneBootstrap(deps, message, {
      ...target,
      decision: { action: 'wait', retryAfterMs: 15_000, diagnostic: 'grace' },
    });

    expect(ensurePending).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: TEAM_NAME,
        memberName: MEMBER_NAME,
        laneId: 'primary',
        runId: 'run-a1',
        inboxMessageId: 'launch-prompt-1',
      })
    );
    expect(markNextAttemptDeferred).toHaveBeenCalledTimes(1);
    expect(markFailedTerminal).not.toHaveBeenCalled();
    expect(delivery.delivered).toBe(false);
    expect(delivery.reason).toBe(MISSING_REASON);
    expect(delivery.diagnostics[0]).toContain('waiting for the bootstrap commit');
  });

  it('terminalizes the row once the self-heal ladder is exhausted', async () => {
    const { deps, markFailedTerminal } = createDeps();

    const delivery = await settleUndeliverableOpenCodePrimaryLaneBootstrap(deps, message, {
      ...target,
      decision: {
        action: 'give_up',
        diagnostic: 'the lead re-bootstrap budget is exhausted for this run.',
      },
    });

    expect(markFailedTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'opencode_primary_lane_bootstrap_unrecoverable' })
    );
    expect(delivery.ledgerStatus).toBe('failed_terminal');
    expect(delivery.ledgerRecordId).toBe('ledger-1');
    expect(delivery.diagnostics[0]).toContain('budget is exhausted');
  });

  /**
   * Negative control for the opt-out, end to end through the ledger: with the
   * ladder switched off the row still ends somewhere visible, and it says the
   * self-heal is disabled rather than blaming an exhausted budget.
   */
  it('settles terminal saying the self-heal is disabled when the ladder is off', async () => {
    const { deps, markFailedTerminal, markNextAttemptDeferred } = createDeps();

    const delivery = await settleUndeliverableOpenCodePrimaryLaneBootstrap(deps, message, {
      ...target,
      decision: { action: 'give_up', diagnostic: PRIMARY_LANE_REBOOTSTRAP_DISABLED_DIAGNOSTIC },
    });

    expect(markNextAttemptDeferred).not.toHaveBeenCalled();
    expect(markFailedTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'opencode_primary_lane_bootstrap_unrecoverable',
        diagnostics: [
          MISSING_REASON,
          `OpenCode primary lane has no committed session record for ${MEMBER_NAME}; ${PRIMARY_LANE_REBOOTSTRAP_DISABLED_DIAGNOSTIC}`,
        ],
      })
    );
    expect(delivery.ledgerStatus).toBe('failed_terminal');
    expect(delivery.diagnostics[0]).toContain('disabled');
  });

  it('touches no ledger for a message the relay does not own', async () => {
    const { deps, createOpenCodePromptDeliveryLedger } = createDeps();

    const delivery = await settleUndeliverableOpenCodePrimaryLaneBootstrap(
      deps,
      { text: 'Summarize the repo' },
      { ...target, decision: { action: 'give_up', diagnostic: 'budget' } }
    );

    expect(createOpenCodePromptDeliveryLedger).not.toHaveBeenCalled();
    expect(delivery.ledgerStatus).toBeUndefined();
    expect(delivery.reason).toBe(MISSING_REASON);
  });
});
