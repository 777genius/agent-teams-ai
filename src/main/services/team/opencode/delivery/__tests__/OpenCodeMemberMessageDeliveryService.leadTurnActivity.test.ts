import * as memberWorkSync from '@features/member-work-sync/main';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openCodeLaneTurnActivityRegistry } from '../OpenCodeLaneTurnActivityRegistry';
import {
  type OpenCodeLeadTurnActivityNotification,
  type OpenCodeMemberLaneIdentity,
  type OpenCodeMemberMessageDeliveryInput,
  type OpenCodeMemberMessageDeliveryServiceDependencies,
} from '../OpenCodeMemberMessageDeliveryPorts';
import { OpenCodeMemberMessageDeliveryService } from '../OpenCodeMemberMessageDeliveryService';
import { OpenCodePromptDeliveryFollowUpPolicy } from '../OpenCodePromptDeliveryFollowUpPolicy';
import {
  createOpenCodePromptDeliveryLedgerStore,
  type OpenCodePromptDeliveryLedgerRecord,
} from '../OpenCodePromptDeliveryLedger';
import { OPENCODE_STALE_PENDING_POLICY_CONFIG } from '../OpenCodePromptDeliveryStalePendingPolicy';
import { OpenCodePromptDeliveryWatchdogScheduler } from '../OpenCodePromptDeliveryWatchdogScheduler';

import type { OpenCodeTeamRuntimeMessageResult } from '../../../runtime';

const PRIMARY_LANE: OpenCodeMemberLaneIdentity = {
  laneId: 'primary',
  laneKind: 'primary',
  laneOwnerProviderId: 'opencode',
};

const SECONDARY_LANE: OpenCodeMemberLaneIdentity = {
  laneId: 'secondary:opencode:muse',
  laneKind: 'secondary',
  laneOwnerProviderId: 'opencode',
};

function acceptedResult(memberName: string): OpenCodeTeamRuntimeMessageResult {
  return {
    ok: true,
    providerId: 'opencode',
    memberName,
    sessionId: 'session-1',
    runtimePromptMessageId: 'prompt-1',
    diagnostics: [],
  };
}

/** Read-commit gate that settles only once the runtime has accepted the prompt. */
const settleAfterAcceptance = (record?: OpenCodePromptDeliveryLedgerRecord | null): boolean =>
  record != null && record.status !== 'pending';

function createDeps(input: {
  ledgerDir: string;
  laneIdentity: OpenCodeMemberLaneIdentity;
  memberName: string;
  send: () => Promise<OpenCodeTeamRuntimeMessageResult>;
  readAllowed: (record?: OpenCodePromptDeliveryLedgerRecord | null) => boolean;
  notify: ReturnType<typeof vi.fn>;
}): OpenCodeMemberMessageDeliveryServiceDependencies {
  const ledger = createOpenCodePromptDeliveryLedgerStore({
    filePath: join(input.ledgerDir, `${input.laneIdentity.laneId.replace(/:/g, '_')}.json`),
  });
  const passthroughProof = vi.fn(async ({ ledgerRecord }: { ledgerRecord: unknown }) => ({
    ledgerRecord,
    visibleReply: null,
  }));
  return {
    getOpenCodeRuntimeMessageAdapter: vi.fn(
      () => ({ sendMessageToMember: vi.fn(async () => await input.send()) }) as never
    ),
    readOpenCodeMemberDirectory: vi.fn(async () => ({
      config: { name: 'team-a', projectPath: '/repo', members: [] } as never,
      teamMeta: null,
      metaMembers: [{ name: input.memberName, providerId: 'opencode' as const }],
    })),
    resolveOpenCodeMemberIdentityFromDirectory: vi.fn(() => ({
      ok: true as const,
      canonicalMemberName: input.memberName,
      laneId: input.laneIdentity.laneId,
      laneIdentity: input.laneIdentity,
      metaMember: { name: input.memberName, providerId: 'opencode' as const },
      memberRuntimeCwd: '/repo',
    })),
    stoppingSecondaryRuntimeTeams: { has: () => false },
    readPersistedTeamProjectPath: vi.fn(() => '/repo'),
    resolveDeliverableTrackedRuntimeRunId: vi.fn(() => 'run-1'),
    runs: { get: vi.fn(() => ({ mixedSecondaryLanes: [] })) },
    getCurrentOpenCodeRuntimeRunId: vi.fn(() => 'runtime-run-1'),
    resolveCurrentOpenCodeRuntimeRunId: vi.fn(async () => 'runtime-run-1'),
    isOpenCodeRuntimeLaneIndexActive: vi.fn(async () => true),
    tryRecoverOpenCodeRuntimeLaneBeforeDelivery: vi.fn(async () => false),
    tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery: vi.fn(async () => false),
    deleteSecondaryRuntimeRun: vi.fn(),
    cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: vi.fn(),
    findDeliverableOpenCodeRuntimeBootstrapSessionEvidence: vi.fn(
      async () => ({ appMcpTransportHash: 'hash' }) as never
    ),
    getOpenCodeAppMcpTransportMismatchDiagnostic: vi.fn(() => null),
    stampOpenCodeAppMcpTransportEvidenceIfMissing: vi.fn(async () => undefined),
    resolveControlApiBaseUrl: vi.fn(async () => null),
    sendOpenCodeMemberMessageToRuntimeSerialized: vi.fn(
      async ({ send }: { send: () => Promise<OpenCodeTeamRuntimeMessageResult> }) => await send()
    ),
    rememberOpenCodeRuntimePidFromBridge: vi.fn(async () => undefined),
    maybeSyncOpenCodeRuntimePermissionsAfterDelivery: vi.fn(async () => undefined),
    isLegacyOpenCodeMemberWorkSyncReadCommitAllowed: vi.fn(async () => true),
    createOpenCodePromptDeliveryLedger: vi.fn(() => ledger),
    openCodeVisibleReplyProofService: {
      applyDestinationProof: passthroughProof as never,
      materializePlainTextReplyIfNeeded: passthroughProof as never,
      findByRelayOfMessageId: vi.fn(async () => null),
    },
    openCodePromptDeliveryWatchdogScheduler: { isEnabled: () => true },
    openCodePromptDeliveryFollowUpPolicy: {
      schedule: vi.fn(
        async ({ ledgerRecord }: { ledgerRecord: OpenCodePromptDeliveryLedgerRecord }) =>
          ledgerRecord
      ),
    },
    openCodeStalePendingPolicyConfig: OPENCODE_STALE_PENDING_POLICY_CONFIG,
    isOpenCodeDeliveryResponseReadCommitAllowed: vi.fn(
      async ({ ledgerRecord }: { ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null }) =>
        input.readAllowed(ledgerRecord)
    ),
    getOpenCodeDeliveryPendingReason: vi.fn(() => 'opencode_delivery_response_pending'),
    markOpenCodeAcceptedDeliveryMissingPromptProofForRetry: vi.fn(
      async ({ ledgerRecord }: { ledgerRecord: OpenCodePromptDeliveryLedgerRecord }) => ledgerRecord
    ),
    scheduleOpenCodePromptDeliveryWatchdog: vi.fn(),
    logOpenCodePromptDeliveryEvent: vi.fn(),
    requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded: vi.fn(
      async ({ ledgerRecord }: { ledgerRecord: OpenCodePromptDeliveryLedgerRecord }) => ledgerRecord
    ),
    emitOpenCodePromptDeliveryTaskLogChange: vi.fn(),
    notifyOpenCodeLeadTurnActivity: input.notify as never,
    observeOpenCodeDirectUserDeliveryInlineIfNeeded: vi.fn(
      async ({ ledgerRecord }: { ledgerRecord: OpenCodePromptDeliveryLedgerRecord }) => ({
        ledgerRecord,
        visibleReply: null,
      })
    ),
  };
}

function states(notify: ReturnType<typeof vi.fn>): OpenCodeLeadTurnActivityNotification['state'][] {
  return notify.mock.calls.map(([call]) => (call as OpenCodeLeadTurnActivityNotification).state);
}

const leadMessage: OpenCodeMemberMessageDeliveryInput = {
  memberName: 'team-lead',
  text: 'plan the sprint',
  messageId: 'user-1',
  messageKind: 'default',
  source: 'ui-send',
};

describe('OpenCodeMemberMessageDeliveryService lead turn activity', () => {
  let ledgerDir: string;

  beforeEach(async () => {
    ledgerDir = await mkdtemp(join(tmpdir(), 'opencode-lead-turn-activity-'));
    openCodeLaneTurnActivityRegistry.clear();
  });

  afterEach(async () => {
    await rm(ledgerDir, { recursive: true, force: true });
  });

  it("emits 'active' on acceptance and 'idle' once the primary-lane response is read-committable", async () => {
    const notify = vi.fn();
    const service = new OpenCodeMemberMessageDeliveryService(
      createDeps({
        ledgerDir,
        laneIdentity: PRIMARY_LANE,
        memberName: 'team-lead',
        send: async () => acceptedResult('team-lead'),
        readAllowed: settleAfterAcceptance,
        notify,
      })
    );

    const delivery = await service.deliver('team-a', leadMessage);

    expect(delivery.accepted).toBe(true);
    expect(delivery.responsePending).toBe(false);
    expect(states(notify)).toEqual(['active', 'idle']);
    expect(notify).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'team-lead',
      laneId: 'primary',
      runId: 'run-1',
      state: 'active',
    });
  });

  it("keeps the lead 'active' while an accepted primary-lane turn is still pending", async () => {
    const notify = vi.fn();
    const service = new OpenCodeMemberMessageDeliveryService(
      createDeps({
        ledgerDir,
        laneIdentity: PRIMARY_LANE,
        memberName: 'team-lead',
        send: async () => acceptedResult('team-lead'),
        readAllowed: () => false,
        notify,
      })
    );

    const delivery = await service.deliver('team-a', leadMessage);

    expect(delivery.accepted).toBe(true);
    expect(delivery.responsePending).toBe(true);
    expect(states(notify)).toEqual(['active']);
  });

  it("emits 'idle' when the primary-lane send throws", async () => {
    const notify = vi.fn();
    const service = new OpenCodeMemberMessageDeliveryService(
      createDeps({
        ledgerDir,
        laneIdentity: PRIMARY_LANE,
        memberName: 'team-lead',
        send: async () => {
          throw new Error('bridge down');
        },
        readAllowed: () => false,
        notify,
      })
    );

    const delivery = await service.deliver('team-a', leadMessage);

    expect(delivery.delivered).toBe(false);
    expect(states(notify)).toEqual(['idle']);
  });

  it('never reports lead activity for a secondary lane', async () => {
    const notify = vi.fn();
    const service = new OpenCodeMemberMessageDeliveryService(
      createDeps({
        ledgerDir,
        laneIdentity: SECONDARY_LANE,
        memberName: 'Muse',
        send: async () => acceptedResult('Muse'),
        readAllowed: settleAfterAcceptance,
        notify,
      })
    );

    const delivery = await service.deliver('team-a', { ...leadMessage, memberName: 'Muse' });

    expect(delivery.accepted).toBe(true);
    expect(notify).not.toHaveBeenCalled();
    // The turn is still recorded: nothing else in the app sees a secondary lane settle.
    expect(openCodeLaneTurnActivityRegistry.get('team-a', 'Muse')).toMatchObject({
      laneId: SECONDARY_LANE.laneId,
      state: 'idle',
    });
  });

  it('never reports lead activity for a same-model primary teammate', async () => {
    const notify = vi.fn();
    const service = new OpenCodeMemberMessageDeliveryService(
      createDeps({
        ledgerDir,
        laneIdentity: PRIMARY_LANE,
        memberName: 'Muse',
        send: async () => acceptedResult('Muse'),
        readAllowed: settleAfterAcceptance,
        notify,
      })
    );

    const delivery = await service.deliver('team-a', { ...leadMessage, memberName: 'Muse' });

    expect(delivery.accepted).toBe(true);
    expect(notify).not.toHaveBeenCalled();
    // Lane membership is not lead identity, but the turn still belongs in the registry.
    expect(openCodeLaneTurnActivityRegistry.get('team-a', 'Muse')).toMatchObject({
      laneId: 'primary',
      state: 'idle',
    });
  });

  it('swallows notification failures without affecting the delivery result', async () => {
    const notify = vi.fn(() => {
      throw new Error('renderer gone');
    });
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new OpenCodeMemberMessageDeliveryService(
      createDeps({
        ledgerDir,
        laneIdentity: PRIMARY_LANE,
        memberName: 'team-lead',
        send: async () => acceptedResult('team-lead'),
        readAllowed: settleAfterAcceptance,
        notify,
      })
    );

    try {
      const delivery = await service.deliver('team-a', leadMessage);

      expect(delivery.accepted).toBe(true);
      expect(delivery.responsePending).toBe(false);
      expect(states(notify)).toEqual(['active', 'idle']);
      expect(consoleWarnSpy).toHaveBeenCalledTimes(2);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[Service:OpenCodeMemberMessageDelivery]',
        expect.stringContaining('lead turn activity (active) notification failed: renderer gone')
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });
});

describe('secondary delivery waiting for a native bootstrap commit', () => {
  let ledgerDir: string;
  beforeEach(async () => {
    ledgerDir = await mkdtemp(join(tmpdir(), 'opencode-bootstrap-wake-'));
    vi.useFakeTimers();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(ledgerDir, { recursive: true, force: true });
  });

  function harness(responsePending = false, realFollowUps = false) {
    const send = vi.fn(async () => acceptedResult('Muse'));
    const deps = createDeps({
      ledgerDir,
      laneIdentity: SECONDARY_LANE,
      memberName: 'Muse',
      send,
      readAllowed: responsePending ? () => false : settleAfterAcceptance,
      notify: vi.fn(),
    });
    const lane = {
      laneId: SECONDARY_LANE.laneId,
      member: { name: 'Muse' },
      runId: 'runtime-run-1',
    };
    const root = { mixedSecondaryLanes: [lane] };
    deps.runs = { get: () => root };
    let committed = false;
    deps.findDeliverableOpenCodeRuntimeBootstrapSessionEvidence = vi.fn(async () =>
      committed ? ({ appMcpTransportHash: 'hash' } as never) : null
    );
    const service = new OpenCodeMemberMessageDeliveryService(deps);
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const message = { ...leadMessage, memberName: 'Muse', source: 'watcher' as const };
    const relay = vi.fn(async (wake: { isCurrent?: () => boolean }) => {
      try {
        return await service.deliver('team-a', { ...message, isCurrent: wake.isCurrent });
      } finally {
        complete();
      }
    });
    const scheduler = new OpenCodePromptDeliveryWatchdogScheduler({
      canDeliverToTeamRuntime: () => true,
      recoverBeforeDelivery: async () => false,
      relay,
      getInboxMessages: async () => [],
      resolveIdentity: async () => null,
      isLaneActive: async () => true,
      isRecordNotFoundError: () => false,
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      diagnostic: vi.fn(),
      getErrorMessage: String,
    });
    const scheduled = vi.fn(
      (input: Parameters<OpenCodePromptDeliveryWatchdogScheduler['schedule']>[0]) =>
        scheduler.schedule(input)
    );
    deps.scheduleOpenCodePromptDeliveryWatchdog = scheduled;
    if (realFollowUps)
      deps.openCodePromptDeliveryFollowUpPolicy = new OpenCodePromptDeliveryFollowUpPolicy({
        scheduleWatchdog: scheduled,
        logEvent: vi.fn(),
        markFailedTerminal: async (input) => await input.ledger.markFailedTerminal(input),
      });
    return {
      deps,
      scheduled,
      service,
      scheduler,
      send,
      relay,
      message,
      lane,
      root,
      completed,
      commit: () => {
        committed = true;
      },
    };
  }

  it.each(['policy-followup', 'queued-behind', 'not-due', 'new-retry'] as const)(
    'keeps %s watchdog descendants scoped when the lane is replaced',
    async (path) => {
      const h = harness(true, path !== 'queued-behind');
      h.commit();
      let current = true;
      if (path === 'new-retry')
        h.send.mockResolvedValueOnce({
          ...acceptedResult('Muse'),
          runtimePromptMessageId: undefined,
        });
      try {
        await h.service.deliver('team-a', { ...h.message, isCurrent: () => current });
        if (path === 'queued-behind' || path === 'not-due') {
          h.scheduler.cancelTeam('team-a');
          await h.service.deliver('team-a', {
            ...h.message,
            messageId: path === 'queued-behind' ? 'queued-second' : h.message.messageId,
            isCurrent: () => current,
          });
        }
        expect(h.scheduled.mock.calls.length).toBeGreaterThan(0);
        const ledger = h.deps.createOpenCodePromptDeliveryLedger('team-a', SECONDARY_LANE.laneId);
        const before = await ledger.list();
        current = false;
        h.lane.runId = 'replacement-run';
        h.deps.getCurrentOpenCodeRuntimeRunId = () => 'replacement-run';
        await vi.advanceTimersByTimeAsync(15_000);
        if (h.relay.mock.calls.length) await h.completed;
        expect(h.relay).not.toHaveBeenCalled();
        expect(h.send).toHaveBeenCalledTimes(1);
        expect(await ledger.list()).toEqual(before);
      } finally {
        h.scheduler.cancelTeam('team-a');
      }
    }
  );

  it('keeps a current scoped followup observing its one accepted send', async () => {
    const h = harness(true, true);
    h.commit();
    try {
      await h.service.deliver('team-a', { ...h.message, isCurrent: () => true });
      await vi.advanceTimersByTimeAsync(15_000);
      await h.completed;
      expect(h.relay).toHaveBeenCalledTimes(1);
      expect(h.send).toHaveBeenCalledTimes(1);
    } finally {
      h.scheduler.cancelTeam('team-a');
    }
  });

  it('submits a message queued during Relaunch once after late native commit without another inbox mutation', async () => {
    const h = harness();
    try {
      const refused = await h.service.deliver('team-a', h.message);
      expect(refused.delivered).toBe(false);
      expect(h.send).not.toHaveBeenCalled();
      h.commit();
      await vi.advanceTimersByTimeAsync(3_000);
      await h.completed;
      expect(h.relay).toHaveBeenCalledTimes(1);
      expect(h.send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(h.send).toHaveBeenCalledTimes(1);
    } finally {
      h.scheduler.cancelTeam('team-a');
    }
  });

  it('observes an already submitted prompt without sending it again when bootstrap temporarily disappears', async () => {
    const h = harness(true);
    try {
      h.commit();
      const accepted = await h.service.deliver('team-a', h.message);
      expect(accepted.accepted).toBe(true);
      expect(h.send).toHaveBeenCalledTimes(1);
      const probe = h.deps.findDeliverableOpenCodeRuntimeBootstrapSessionEvidence.bind(h.deps);
      h.deps.findDeliverableOpenCodeRuntimeBootstrapSessionEvidence = async () => null;
      await h.service.deliver('team-a', h.message);
      h.deps.findDeliverableOpenCodeRuntimeBootstrapSessionEvidence = probe;
      await vi.advanceTimersByTimeAsync(3_000);
      await h.completed;
      expect(h.send).toHaveBeenCalledTimes(1);
    } finally {
      h.scheduler.cancelTeam('team-a');
    }
  });

  it.each(['stop', 'replacement', 'removed-lane', 'root-replacement', 'secondary-owner'] as const)(
    'does not resurrect a pending wake after %s during bootstrap read',
    async (change) => {
      const h = harness();
      let finish!: () => void;
      const waiting = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let started!: () => void;
      const reading = new Promise<void>((resolve) => {
        started = resolve;
      });
      h.deps.findDeliverableOpenCodeRuntimeBootstrapSessionEvidence = async () => {
        started();
        await waiting;
        return null;
      };
      const delivery = h.service.deliver('team-a', h.message);
      await reading;
      if (change === 'stop') h.deps.stoppingSecondaryRuntimeTeams = { has: () => true };
      if (change === 'replacement') h.lane.runId = 'replacement-run';
      if (change === 'removed-lane') h.root.mixedSecondaryLanes = [];
      if (change === 'root-replacement') h.deps.runs = { get: () => ({ ...h.root }) };
      if (change === 'secondary-owner') h.deps.getCurrentOpenCodeRuntimeRunId = () => 'other-run';
      h.scheduler.cancelTeam('team-a');
      finish();
      await delivery;
      expect(h.scheduled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(h.relay).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
    }
  );

  it('restores the existing lane ticket when authorization is revoked during gate hydration', async () => {
    const h = harness();
    let current = true;
    const restore = vi.fn();
    const gate = vi
      .spyOn(memberWorkSync, 'gateOpenCodeWorkSyncLaneDelivery')
      .mockImplementationOnce(async () => {
        current = false;
        return { restore };
      });
    try {
      const result = await h.service.deliver('team-a', { ...h.message, isCurrent: () => current });
      expect(result.reason).toBe('opencode_prompt_delivery_cancelled');
      expect(restore).toHaveBeenCalledTimes(1);
      expect(h.send).not.toHaveBeenCalled();
      expect(h.scheduled).not.toHaveBeenCalled();
    } finally {
      gate.mockRestore();
      h.scheduler.cancelTeam('team-a');
    }
  });

  it('does not restore a consumed lane ticket after the provider has accepted a revoked scoped send', async () => {
    const h = harness();
    h.commit();
    let current = true;
    const restore = vi.fn();
    const consumed = vi.fn(() => ({}));
    const gate = vi
      .spyOn(memberWorkSync, 'gateOpenCodeWorkSyncLaneDelivery')
      .mockResolvedValueOnce({ restore, consumeForSend: consumed });
    h.send.mockImplementationOnce(async () => {
      current = false;
      return acceptedResult('Muse');
    });
    try {
      await h.service.deliver('team-a', {
        ...h.message,
        messageKind: 'member_work_sync_nudge',
        workSyncRuntimeTicketId: 'ticket',
        isCurrent: () => current,
      });
      expect(consumed).toHaveBeenCalledTimes(1);
      expect(h.send).toHaveBeenCalledTimes(1);
      expect(restore).not.toHaveBeenCalled();
    } finally {
      gate.mockRestore();
      h.scheduler.cancelTeam('team-a');
    }
  });

  it('restores a lane ticket before scheduling a bootstrap-pending retry', async () => {
    const h = harness();
    const restore = vi.fn();
    const gate = vi
      .spyOn(memberWorkSync, 'gateOpenCodeWorkSyncLaneDelivery')
      .mockResolvedValueOnce({ restore });
    try {
      await h.service.deliver('team-a', h.message);
      expect(restore).toHaveBeenCalledTimes(1);
      expect(h.scheduled).toHaveBeenCalledTimes(1);
      expect(h.send).not.toHaveBeenCalled();
    } finally {
      gate.mockRestore();
      h.scheduler.cancelTeam('team-a');
    }
  });

  it('delivers once for a replacement generation whose wake shares the previous message key', async () => {
    const h = harness();
    await h.service.deliver('team-a', h.message);
    h.lane.runId = 'runtime-run-2';
    h.deps.getCurrentOpenCodeRuntimeRunId = () => 'runtime-run-2';
    await h.service.deliver('team-a', h.message);
    h.commit();
    await vi.advanceTimersByTimeAsync(3_000);
    await h.completed;
    expect(h.relay).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledTimes(1);
    h.scheduler.cancelTeam('team-a');
  });

  it('keeps the originating generation fence while the relay is reading delivery context', async () => {
    const h = harness();
    await h.service.deliver('team-a', h.message);
    h.commit();
    const readDirectory = h.deps.readOpenCodeMemberDirectory.bind(h.deps);
    h.deps.readOpenCodeMemberDirectory = async (teamName) => {
      const directory = await readDirectory(teamName);
      h.lane.runId = 'replacement-run';
      return directory;
    };
    await vi.advanceTimersByTimeAsync(3_000);
    await h.completed;
    expect(h.send).not.toHaveBeenCalled();
    h.scheduler.cancelTeam('team-a');
  });

  it('drops an already scheduled wake when its lane owner changes', async () => {
    const h = harness();
    await h.service.deliver('team-a', h.message);
    h.commit();
    h.lane.runId = 'replacement-run';
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.relay).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    h.scheduler.cancelTeam('team-a');
  });
});
