import {
  createTeamRuntimeRecoveryFeature,
  JsonTeamRuntimeRecoveryRepository,
  TeamRuntimeRecoveryStorePaths,
  type TeamRuntimeRecoveryFeatureFacade,
} from '@features/team-runtime-recovery/main';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage, SendMessageRequest, TeamAgentRuntimeSnapshot } from '@shared/types';

const TEAM_NAME = 'sandbox-runtime-recovery';
const RUN_ID = 'sandbox-run-1';

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  description: string,
  timeoutMs = 6_000
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function inboxKey(teamName: string, memberName: string): string {
  return `${teamName}\u0000${memberName.toLowerCase()}`;
}

interface SandboxHarness {
  root: string;
  repository: JsonTeamRuntimeRecoveryRepository;
  messages: Map<string, InboxMessage[]>;
  config: {
    transientErrorsEnabled: boolean;
    rateLimitsEnabled: boolean;
    initialDelaySeconds: number;
    maxAttempts: number;
  };
  configListeners: Set<(section: string) => void>;
  snapshot: TeamAgentRuntimeSnapshot;
  notifications: Array<{ summary?: string; body?: string }>;
  relay: ReturnType<typeof vi.fn>;
  createFeature(): TeamRuntimeRecoveryFeatureFacade;
}

async function createHarness(memberNames: string[]): Promise<SandboxHarness> {
  const root = await mkdtemp(join(tmpdir(), 'team-runtime-recovery-e2e-'));
  const messages = new Map<string, InboxMessage[]>();
  const configListeners = new Set<(section: string) => void>();
  const notifications: Array<{ summary?: string; body?: string }> = [];
  const config = {
    transientErrorsEnabled: true,
    rateLimitsEnabled: false,
    initialDelaySeconds: 15,
    maxAttempts: 2,
  };
  const snapshot: TeamAgentRuntimeSnapshot = {
    teamName: TEAM_NAME,
    runId: RUN_ID,
    updatedAt: new Date().toISOString(),
    members: Object.fromEntries(
      memberNames.map((memberName, index) => [
        memberName,
        {
          memberName,
          alive: true,
          restartable: true,
          providerId: 'anthropic' as const,
          providerBackendId: 'cli-sdk' as const,
          runtimeModel: 'claude-sonnet',
          runtimeSessionId: `session-${index}`,
          updatedAt: new Date().toISOString(),
        },
      ])
    ),
  };
  const relay = vi.fn(
    async (
      _teamName: string,
      _memberName: string,
      _options: { source: 'manual'; onlyMessageId: string }
    ) => ({
      kind: 'native_member_noop' as const,
      relayed: 0,
    })
  );
  const harness: SandboxHarness = {
    root,
    repository: new JsonTeamRuntimeRecoveryRepository(new TeamRuntimeRecoveryStorePaths(root)),
    messages,
    config,
    configListeners,
    snapshot,
    notifications,
    relay,
    createFeature() {
      return createTeamRuntimeRecoveryFeature({
        teamsBasePath: root,
        configManager: {
          getConfig: () => ({ teamRuntimeRecovery: { ...config } }),
          onConfigChanged: (listener) => {
            configListeners.add(listener);
            return () => configListeners.delete(listener);
          },
        },
        getCurrentContextId: () => 'local',
        listActiveTeamNames: async () => [TEAM_NAME],
        isTeamActive: async () => true,
        getRuntimeState: async () => ({ isAlive: true, runId: RUN_ID }),
        getRuntimeSnapshot: async () => snapshot,
        getLeadName: async () => 'team-lead',
        getTeamDisplayName: async () => 'Sandbox runtime recovery',
        getInboxMessages: async (teamName, memberName) =>
          messages.get(inboxKey(teamName, memberName)) ?? [],
        inboxWriter: {
          sendMessage: async (teamName: string, request: SendMessageRequest) => {
            const key = inboxKey(teamName, request.member);
            const rows = messages.get(key) ?? [];
            rows.push({
              from: request.from ?? 'user',
              to: request.to ?? request.member,
              text: request.text,
              timestamp: request.timestamp ?? new Date().toISOString(),
              read: false,
              messageId: request.messageId,
              messageKind: request.messageKind,
              source: request.source,
              actionMode: request.actionMode,
              taskRefs: request.taskRefs,
              runtimeRecovery: request.runtimeRecovery,
            });
            messages.set(key, rows);
            return { deliveredToInbox: true, messageId: request.messageId! };
          },
        },
        relay: (...args) => relay(...args),
        getTask: async () => null,
        getMemberAdvisory: async () => null,
        getOpenCodeBusyStatus: async () => ({ busy: false }),
        addNotification: async (payload) => {
          notifications.push(payload);
        },
      });
    },
  };
  return harness;
}

function seedTerminalFailures(harness: SandboxHarness, memberNames: string[]): void {
  const observedAt = new Date(Date.now() - 1_000).toISOString();
  const leadMessages = harness.messages.get(inboxKey(TEAM_NAME, 'team-lead')) ?? [];
  memberNames.forEach((memberName, index) => {
    const failedMessageId = `failed-message-${index}`;
    harness.messages.set(inboxKey(TEAM_NAME, memberName), [
      {
        from: 'team-lead',
        to: memberName,
        text: `Original sandbox work ${index}`,
        timestamp: new Date(Date.parse(observedAt) - 1_000).toISOString(),
        read: true,
        messageId: failedMessageId,
        source: 'inbox',
      },
    ]);
    leadMessages.push({
      from: memberName,
      to: 'team-lead',
      text: `${memberName} hit a mailbox turn execution error. API Error: 529`,
      timestamp: observedAt,
      read: false,
      messageId: `agent-error-${index}`,
      messageKind: 'agent_error',
      agentError: {
        schemaVersion: 1,
        type: 'api_error',
        phase: 'terminal',
        detail: 'API Error: 529 overloaded_error',
        failedMessageId,
        runtimeSessionId: `session-${index}`,
        bootstrapRunId: RUN_ID,
        innerRecoveryAttempts: 3,
      },
    });
  });
  harness.messages.set(inboxKey(TEAM_NAME, 'team-lead'), leadMessages);
}

async function forceAllJobsDue(harness: SandboxHarness): Promise<void> {
  const dueAt = new Date(Date.now() - 1_000).toISOString();
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  await harness.repository.update(TEAM_NAME, (state) => ({
    state: {
      ...state,
      jobs: state.jobs.map((job) => ({ ...job, nextAttemptAt: dueAt, expiresAt })),
      circuits: state.circuits.map((circuit) => ({ ...circuit, nextProbeAt: dueAt })),
      updatedAt: new Date().toISOString(),
    },
    result: undefined,
  }));
}

describe('TeamRuntimeRecoveryFeature sandbox E2E', () => {
  const roots: string[] = [];
  const features: TeamRuntimeRecoveryFeatureFacade[] = [];

  afterEach(async () => {
    await Promise.allSettled(features.splice(0).map((feature) => feature.dispose()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('survives app restart, limits ten simultaneous 529s to one probe, and completes on native proof', async () => {
    const memberNames = Array.from({ length: 10 }, (_, index) => `member-${index}`);
    const harness = await createHarness(memberNames);
    roots.push(harness.root);
    seedTerminalFailures(harness, memberNames);

    const firstApp = harness.createFeature();
    features.push(firstApp);
    firstApp.start();
    firstApp.noteTeamChange({ type: 'inbox', teamName: TEAM_NAME });
    await waitFor(
      async () => (await harness.repository.read(TEAM_NAME)).jobs.length === 10,
      'ten durable recovery jobs'
    );

    await firstApp.dispose();
    features.splice(features.indexOf(firstApp), 1);
    await forceAllJobsDue(harness);

    const restartedApp = harness.createFeature();
    features.push(restartedApp);
    restartedApp.start();
    await waitFor(async () => {
      const state = await harness.repository.read(TEAM_NAME);
      return state.jobs.filter((job) => job.status === 'awaiting_outcome').length === 1;
    }, 'one half-open recovery delivery after restart');

    const recoveryRows = memberNames
      .flatMap((memberName) => harness.messages.get(inboxKey(TEAM_NAME, memberName)) ?? [])
      .filter((message) => message.messageKind === 'runtime_recovery_nudge');
    expect(recoveryRows).toHaveLength(1);
    expect(harness.relay).toHaveBeenCalledTimes(1);

    recoveryRows[0]!.read = true;
    restartedApp.noteTeamChange({ type: 'inbox', teamName: TEAM_NAME });
    await waitFor(async () => {
      const state = await harness.repository.read(TEAM_NAME);
      return state.jobs.filter((job) => job.status === 'completed').length === 1;
    }, 'native inbox outcome proof');

    const finalState = await harness.repository.read(TEAM_NAME);
    expect(finalState.jobs.filter((job) => job.status === 'pending')).toHaveLength(9);
    expect(
      memberNames
        .flatMap((memberName) => harness.messages.get(inboxKey(TEAM_NAME, memberName)) ?? [])
        .filter((message) => message.messageKind === 'runtime_recovery_nudge')
    ).toHaveLength(1);
    expect(
      harness.notifications.some((notification) => notification.summary?.includes('member-0'))
    ).toBe(true);
  });

  it('chains a terminal lead failure emitted before delivery persistence without losing it', async () => {
    const harness = await createHarness(['team-lead']);
    roots.push(harness.root);
    let feature: TeamRuntimeRecoveryFeatureFacade;
    let observedRecoveryFailure = false;
    harness.relay.mockImplementation(async (_teamName, _memberName, options) => {
      if (!observedRecoveryFailure) {
        observedRecoveryFailure = true;
        feature.observeLeadFailure({
          teamName: TEAM_NAME,
          memberName: 'team-lead',
          runId: RUN_ID,
          runtimeSessionId: 'session-0',
          phase: 'terminal',
          detail: 'API Error: 529 overloaded_error',
          statusCode: 529,
          observedAt: new Date().toISOString(),
          providerId: 'anthropic',
          providerBackendId: 'cli-sdk',
          model: 'claude-sonnet',
          causedByRecoveryMessageId: options.onlyMessageId,
        });
        await waitFor(async () => {
          const [job] = (await harness.repository.read(TEAM_NAME)).jobs;
          return job?.status === 'pending' && job.attempt === 1;
        }, 'correlated recovery failure during relay');
      }
      return {
        kind: 'native_lead' as const,
        relayed: 1,
        lastDelivery: { delivered: true, accepted: true, responsePending: true },
      };
    });

    feature = harness.createFeature();
    features.push(feature);
    feature.start();
    feature.observeLeadFailure({
      teamName: TEAM_NAME,
      memberName: 'team-lead',
      runId: RUN_ID,
      runtimeSessionId: 'session-0',
      phase: 'terminal',
      detail: 'API Error: 529 overloaded_error',
      statusCode: 529,
      observedAt: new Date(Date.now() - 1_000).toISOString(),
      providerId: 'anthropic',
      providerBackendId: 'cli-sdk',
      model: 'claude-sonnet',
    });
    await waitFor(
      async () => (await harness.repository.read(TEAM_NAME)).jobs.length === 1,
      'initial lead recovery job'
    );
    await forceAllJobsDue(harness);
    await waitFor(async () => {
      const [job] = (await harness.repository.read(TEAM_NAME)).jobs;
      return job?.status === 'pending' && job.attempt === 1;
    }, 'second bounded lead attempt');

    const [job] = (await harness.repository.read(TEAM_NAME)).jobs;
    expect(job).toMatchObject({ status: 'pending', attempt: 1 });
    expect(job?.recoveryMessageId).toBeUndefined();
    expect(
      (harness.messages.get(inboxKey(TEAM_NAME, 'team-lead')) ?? []).filter(
        (message) => message.messageKind === 'runtime_recovery_nudge'
      )
    ).toHaveLength(1);
  });

  it('cancels durable pending work immediately when the setting is disabled', async () => {
    const harness = await createHarness(['team-lead']);
    roots.push(harness.root);
    const feature = harness.createFeature();
    features.push(feature);
    feature.start();
    feature.observeLeadFailure({
      teamName: TEAM_NAME,
      memberName: 'team-lead',
      runId: RUN_ID,
      runtimeSessionId: 'session-0',
      phase: 'terminal',
      detail: 'API Error: 529 overloaded_error',
      statusCode: 529,
      observedAt: new Date().toISOString(),
      providerId: 'anthropic',
      providerBackendId: 'cli-sdk',
      model: 'claude-sonnet',
    });
    await waitFor(
      async () => (await harness.repository.read(TEAM_NAME)).jobs.length === 1,
      'pending recovery before disabling'
    );

    harness.config.transientErrorsEnabled = false;
    for (const listener of harness.configListeners) listener('teamRuntimeRecovery');
    await waitFor(async () => {
      const [job] = (await harness.repository.read(TEAM_NAME)).jobs;
      return job?.status === 'cancelled';
    }, 'setting-disabled cancellation');

    expect(harness.relay).not.toHaveBeenCalled();
  });

  it('chains an OpenCode terminal ledger outcome and completes only on responded proof', async () => {
    const harness = await createHarness(['open-agent']);
    roots.push(harness.root);
    const runtimeEntry = harness.snapshot.members['open-agent']!;
    runtimeEntry.providerId = 'opencode';
    runtimeEntry.providerBackendId = 'opencode-cli';
    seedTerminalFailures(harness, ['open-agent']);
    harness.relay.mockImplementation(async () => {
      const call = harness.relay.mock.calls.length;
      if (call === 1) {
        return {
          kind: 'opencode_member' as const,
          relayed: 1,
          lastDelivery: {
            delivered: true,
            accepted: true,
            responsePending: true,
            responseState: 'pending',
          },
        };
      }
      if (call === 2) {
        return {
          kind: 'opencode_member' as const,
          relayed: 1,
          lastDelivery: {
            delivered: true,
            accepted: true,
            responsePending: false,
            responseState: 'session_error',
            reason: 'API Error: 529 overloaded_error',
          },
        };
      }
      return {
        kind: 'opencode_member' as const,
        relayed: 1,
        lastDelivery: {
          delivered: true,
          accepted: true,
          responsePending: false,
          responseState: 'responded_plain_text',
        },
      };
    });

    const feature = harness.createFeature();
    features.push(feature);
    feature.start();
    feature.noteTeamChange({ type: 'inbox', teamName: TEAM_NAME });
    await waitFor(
      async () => (await harness.repository.read(TEAM_NAME)).jobs.length === 1,
      'OpenCode recovery job'
    );
    await forceAllJobsDue(harness);
    await waitFor(async () => {
      const [job] = (await harness.repository.read(TEAM_NAME)).jobs;
      return job?.status === 'awaiting_outcome' && job.attempt === 1;
    }, 'OpenCode accepted delivery');

    feature.noteTeamChange({ type: 'member-turn-settled', teamName: TEAM_NAME });
    await waitFor(async () => {
      const [job] = (await harness.repository.read(TEAM_NAME)).jobs;
      return job?.status === 'pending' && job.attempt === 1;
    }, 'OpenCode correlated terminal outcome');
    expect((await harness.repository.read(TEAM_NAME)).jobs[0]?.status).not.toBe('completed');

    await forceAllJobsDue(harness);
    await waitFor(async () => {
      const [job] = (await harness.repository.read(TEAM_NAME)).jobs;
      return job?.status === 'completed' && job.attempt === 2;
    }, 'OpenCode responded outcome proof');

    const recoveryRows = (harness.messages.get(inboxKey(TEAM_NAME, 'open-agent')) ?? []).filter(
      (message) => message.messageKind === 'runtime_recovery_nudge'
    );
    expect(recoveryRows.map((message) => message.runtimeRecovery?.attempt)).toEqual([1, 2]);
    expect(harness.relay).toHaveBeenCalledTimes(3);
  });
});
