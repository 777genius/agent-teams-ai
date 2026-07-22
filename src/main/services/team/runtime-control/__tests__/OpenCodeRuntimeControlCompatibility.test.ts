import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';

import { RuntimeStaleEvidenceError } from '../../opencode/store/RuntimeRunTombstoneStore';
import {
  createTeamProvisioningOpenCodeRuntimeDeliveryBoundary,
  type TeamProvisioningOpenCodeRuntimeDeliveryBoundaryPorts,
} from '../../provisioning/TeamProvisioningOpenCodeRuntimeDelivery';
import { createOpenCodeRuntimeControlApi, createOpenCodeRuntimeControlRouter } from '../index';

import type { OpenCodeRuntimeCheckinRun } from '../../provisioning/TeamProvisioningOpenCodeRuntimeCheckin';
import type { OpenCodeRuntimeControlAck } from '../index';
import type { InboxMessage } from '@shared/types';

const OBSERVED_AT = '2026-01-01T00:00:00.000Z';

describe('OpenCodeRuntimeControlCompatibility', () => {
  it('preserves structured task refs through the runtime-control router and delivery envelope', async () => {
    const harness = createHarness();

    try {
      await expect(
        harness.api.deliverOpenCodeRuntimeMessage({
          teamName: 'Team',
          runId: 'run-1',
          fromMemberName: 'Builder',
          idempotencyKey: 'message-key-1',
          runtimeSessionId: 'session-1',
          to: 'user',
          text: 'Delivered text',
          createdAt: '2026-01-01T00:00:00Z',
          taskRefs: [{ taskId: 'task-1', displayId: '#1', teamName: 'Team' }],
        })
      ).resolves.toMatchObject({
        ok: true,
        providerId: 'opencode',
        teamName: 'Team',
        runId: 'run-1',
        state: 'delivered',
        idempotencyKey: 'message-key-1',
      });

      expect(harness.sentMessages).toHaveLength(1);
      expect(harness.sentMessages[0]).toMatchObject({
        from: 'Builder',
        to: 'user',
        text: 'Delivered text',
        timestamp: OBSERVED_AT,
        source: 'lead_process',
        leadSessionId: 'session-1',
        taskRefs: [{ taskId: 'task-1', displayId: '#1', teamName: 'Team' }],
      });
      expect(harness.ports.emitTeamChange).toHaveBeenCalledWith({
        type: 'lead-message',
        teamName: 'Team',
        detail: 'opencode-runtime-delivery',
      });
    } finally {
      harness.cleanup();
    }
  });

  it('preserves runtime evidence rejection from the OpenCode compatibility boundary', async () => {
    const harness = createHarness({
      resolveCurrentOpenCodeRuntimeRunId: vi.fn(async () => 'run-2'),
    });

    try {
      await expect(
        harness.api.deliverOpenCodeRuntimeMessage(createValidDeliveryRaw())
      ).rejects.toBeInstanceOf(RuntimeStaleEvidenceError);
      expect(harness.sentMessages).toEqual([]);
    } finally {
      harness.cleanup();
    }
  });

  it('preserves stale-run rejection after evidence acceptance', async () => {
    const harness = createHarness({
      resolveCurrentOpenCodeRuntimeRunId: vi
        .fn()
        .mockResolvedValueOnce('run-1')
        .mockResolvedValueOnce('run-2'),
    });

    try {
      await expect(
        harness.api.deliverOpenCodeRuntimeMessage(createValidDeliveryRaw())
      ).rejects.toThrow('OpenCode runtime delivery rejected: stale_run');
      expect(harness.sentMessages).toEqual([]);
    } finally {
      harness.cleanup();
    }
  });

  it('keeps malformed delivery envelopes out of the compatibility boundary', async () => {
    const harness = createHarness();

    try {
      await expect(
        harness.api.deliverOpenCodeRuntimeMessage({
          ...createValidDeliveryRaw(),
          text: '',
        })
      ).rejects.toThrow('Runtime delivery envelope missing text');
      expect(harness.sentMessages).toEqual([]);
    } finally {
      harness.cleanup();
    }
  });
});

function createValidDeliveryRaw() {
  return {
    teamName: 'Team',
    runId: 'run-1',
    fromMemberName: 'Builder',
    idempotencyKey: 'message-key-1',
    runtimeSessionId: 'session-1',
    to: 'user',
    text: 'Delivered text',
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function createHarness(
  overrides: Partial<
    TeamProvisioningOpenCodeRuntimeDeliveryBoundaryPorts<OpenCodeRuntimeCheckinRun>
  > = {}
) {
  const teamsBasePath = mkdtempSync(join(tmpdir(), 'opencode-runtime-control-'));
  const sentMessages: InboxMessage[] = [];
  const ports = createBoundaryPorts({
    getTeamsBasePath: () => teamsBasePath,
    sentMessagesStore: {
      appendMessage: vi.fn(async (_teamName, message) => {
        sentMessages.push(message);
      }),
      readMessages: vi.fn(async () => sentMessages),
    },
    ...overrides,
  });
  const boundary = createTeamProvisioningOpenCodeRuntimeDeliveryBoundary(ports);
  const api = createOpenCodeRuntimeControlApi({
    runtimeControl: createOpenCodeRuntimeControlRouter({
      ...boundary,
      answerOpenCodeRuntimePermission: vi.fn(
        async (): Promise<OpenCodeRuntimeControlAck> => ({
          ok: true,
          providerId: 'opencode',
          teamName: 'Team',
          runId: 'run-1',
          state: 'accepted',
          diagnostics: [],
          observedAt: OBSERVED_AT,
        })
      ),
    }),
    resolveOpenCodeRuntimeLaneId: (input) => ports.resolveOpenCodeRuntimeLaneId(input),
  });

  return {
    api,
    ports,
    sentMessages,
    cleanup: () => rmSync(teamsBasePath, { force: true, recursive: true }),
  };
}

function createBoundaryPorts(
  overrides: Partial<
    TeamProvisioningOpenCodeRuntimeDeliveryBoundaryPorts<OpenCodeRuntimeCheckinRun>
  > = {}
): TeamProvisioningOpenCodeRuntimeDeliveryBoundaryPorts<OpenCodeRuntimeCheckinRun> {
  return {
    getTeamsBasePath: () => tmpdir(),
    resolveOpenCodeRuntimeLaneId: vi.fn(async () => 'lane-1'),
    resolveCurrentOpenCodeRuntimeRunId: vi.fn(async () => 'run-1'),
    readLaunchState: vi.fn(async () => null),
    writeLaunchState: vi.fn(async () => undefined),
    readConfigForStrictDecision: vi.fn((teamName) =>
      Promise.resolve({
        name: teamName,
        projectPath: '/test/project',
        members: [{ name: 'Builder' }],
      })
    ),
    readMetaMembers: vi.fn(async () => []),
    readPersistedRuntimeMembers: vi.fn(() => []),
    getTrackedRun: vi.fn(() => null),
    persistTrackedRunLaunchState: vi.fn(async () => undefined),
    invalidateRuntimeSnapshotCaches: vi.fn(),
    emitMemberSpawnChange: vi.fn(),
    emitTeamChange: vi.fn(),
    createOpenCodeRuntimeBootstrapEvidencePorts: vi.fn(() => {
      throw new Error('unused');
    }),
    upsertOpenCodeTaskRecord: vi.fn(async () => ({ created: true }) as never),
    syncMemberTaskActivityForRuntimeTransition: vi.fn(),
    syncMemberLaunchGraceCheck: vi.fn(),
    sentMessagesStore: {
      appendMessage: vi.fn(),
      readMessages: vi.fn(async () => []),
    },
    inboxReader: {
      getMessagesFor: vi.fn(async () => []),
    },
    inboxWriter: {
      sendMessage: vi.fn(),
    },
    getCrossTeamSender: () => null,
    logger: {
      warn: vi.fn(),
    },
    isOpenCodeRuntimeRecipient: vi.fn(async () => true),
    getOpenCodeAgendaSyncRecoveryBypassMessageIds: vi.fn(async () => new Set<string>()),
    resolveOpenCodeMemberDeliveryIdentity: vi.fn(async () => ({
      ok: true as const,
      canonicalMemberName: 'Builder',
      laneId: 'lane-1',
    })),
    tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery: vi.fn(async () => true),
    tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive: vi.fn(async () => true),
    decideOpenCodeRuntimeDeliveryUserFacingAdvisory: vi.fn(async (record) => ({
      record,
      decision: { action: 'defer' as const },
    })),
    isOpenCodePromptDeliveryWatchdogEnabled: () => true,
    scheduleOpenCodePromptDeliveryWatchdog: vi.fn(),
    readLaunchStateForDeliveryRecovery: vi.fn(async () => null),
    nowIso: () => OBSERVED_AT,
    ...overrides,
  };
}
