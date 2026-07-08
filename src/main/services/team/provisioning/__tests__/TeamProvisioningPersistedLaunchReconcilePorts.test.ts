import { describe, expect, it, vi } from 'vitest';

import { createPersistedLaunchSnapshot } from '../../TeamLaunchStateEvaluator';
import {
  createTeamProvisioningPersistedLaunchReconcilePorts,
  createTeamProvisioningPersistedLaunchReconcilePortsFromService,
  type TeamProvisioningPersistedLaunchReconcilePortsInput,
  type TeamProvisioningPersistedLaunchReconcileServiceHost,
} from '../TeamProvisioningPersistedLaunchReconcilePorts';

import type { PersistedTeamLaunchMemberState } from '@shared/types';

const at = '2026-01-01T00:00:00.000Z';

function member(
  overrides: Partial<PersistedTeamLaunchMemberState> = {}
): PersistedTeamLaunchMemberState {
  return {
    name: 'Builder',
    launchState: 'starting',
    agentToolAccepted: false,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    firstSpawnAcceptedAt: at,
    lastEvaluatedAt: at,
    ...overrides,
  };
}

function createInput(
  overrides: Partial<TeamProvisioningPersistedLaunchReconcilePortsInput> = {}
): TeamProvisioningPersistedLaunchReconcilePortsInput {
  return {
    readLaunchState: vi.fn(async () => null),
    readMembersMeta: vi.fn(async () => []),
    recoverStaleMixedSecondaryLaunchSnapshot: vi.fn(async () => null),
    applyOpenCodeSecondaryEvidenceOverlay: vi.fn(async ({ snapshot }) => snapshot),
    applyOpenCodeSecondaryBootstrapStallOverlay: vi.fn((snapshot) => snapshot),
    writeLaunchStateSnapshot: vi.fn(async (_teamName, snapshot) => snapshot),
    clearPersistedLaunchState: vi.fn(async () => undefined),
    getLiveTeamAgentRuntimeMetadata: vi.fn(async () => new Map()),
    readPersistedRuntimeMembers: vi.fn(() => []),
    resolveExpectedLaunchMemberName: vi.fn(
      (expectedMembers: readonly string[] | undefined, candidateName: string) =>
        expectedMembers?.find((memberName) => memberName === candidateName) ?? null
    ),
    findBootstrapRuntimeProofObservedAt: vi.fn(async () => null),
    findBootstrapTranscriptOutcome: vi.fn(async () => null),
    ...overrides,
  };
}

describe('persisted launch reconcile port factory', () => {
  it('builds reconcile ports from service dependencies', async () => {
    const persistedSnapshot = createPersistedLaunchSnapshot({
      teamName: 'demo',
      expectedMembers: ['Builder'],
      launchPhase: 'active',
      members: { Builder: member() },
      updatedAt: at,
    });
    const service: TeamProvisioningPersistedLaunchReconcileServiceHost = {
      launchStateStore: {
        read: vi.fn(async () => persistedSnapshot),
      },
      membersMetaStore: {
        getMembers: vi.fn(async () => []),
      },
      recoverStaleMixedSecondaryLaunchSnapshot: vi.fn(async () => persistedSnapshot),
      applyOpenCodeSecondaryEvidenceOverlay: vi.fn(async ({ snapshot }) => snapshot),
      applyOpenCodeSecondaryBootstrapStallOverlay: vi.fn((snapshot) => snapshot),
      writeLaunchStateSnapshot: vi.fn(async (_teamName, snapshot) => snapshot),
      clearPersistedLaunchState: vi.fn(async () => undefined),
      getLiveTeamAgentRuntimeMetadata: vi.fn(async () => new Map()),
      resolveExpectedLaunchMemberName: vi.fn(() => 'Builder'),
      findBootstrapRuntimeProofObservedAt: vi.fn(async () => null),
      findBootstrapTranscriptOutcome: vi.fn(async () => null),
      readPersistedRuntimeMembers: vi.fn(() => []),
    };

    const ports = createTeamProvisioningPersistedLaunchReconcilePortsFromService(service);

    await expect(ports.readLaunchState('demo')).resolves.toBe(persistedSnapshot);
    await expect(ports.readMembersMeta('demo')).resolves.toEqual([]);
    await expect(
      ports.recoverStaleMixedSecondaryLaunchSnapshot('demo', null, persistedSnapshot)
    ).resolves.toBe(persistedSnapshot);
    await expect(
      ports.applyOpenCodeSecondaryEvidenceOverlay({
        teamName: 'demo',
        snapshot: persistedSnapshot,
      })
    ).resolves.toBe(persistedSnapshot);
    expect(ports.applyOpenCodeSecondaryBootstrapStallOverlay(persistedSnapshot)).toBe(
      persistedSnapshot
    );
    await expect(ports.writeLaunchStateSnapshot('demo', persistedSnapshot)).resolves.toBe(
      persistedSnapshot
    );
    await ports.clearPersistedLaunchState('demo');
    await ports.getLiveTeamAgentRuntimeMetadata('demo');
    expect(
      ports.selectLatestLeadInboxLaunchReconcileMessage({
        messages: [
          {
            from: 'Builder',
            text: 'ready',
            timestamp: at,
            messageId: 'msg-1',
          },
        ],
        expectedMembers: ['Builder'],
        expected: 'Builder',
        firstSpawnAcceptedAt: at,
      })?.messageId
    ).toBe('msg-1');
    await ports.findBootstrapRuntimeProofObservedAt('demo', 'Builder', member());
    await ports.findBootstrapTranscriptOutcome('demo', 'Builder', null);
    expect(ports.readProcessBootstrapTransportSummary).toBeDefined();

    expect(service.launchStateStore.read).toHaveBeenCalledWith('demo');
    expect(service.membersMetaStore.getMembers).toHaveBeenCalledWith('demo');
    expect(service.writeLaunchStateSnapshot).toHaveBeenCalledWith('demo', persistedSnapshot);
    expect(service.clearPersistedLaunchState).toHaveBeenCalledWith('demo');
    expect(service.getLiveTeamAgentRuntimeMetadata).toHaveBeenCalledWith('demo');
    expect(service.resolveExpectedLaunchMemberName).toHaveBeenCalledWith(['Builder'], 'Builder');
    expect(service.findBootstrapRuntimeProofObservedAt).toHaveBeenCalledWith(
      'demo',
      'Builder',
      expect.objectContaining({ name: 'Builder' })
    );
    expect(service.findBootstrapTranscriptOutcome).toHaveBeenCalledWith('demo', 'Builder', null);
  });

  it('wires lead inbox reconcile message ports through the service identity resolver', () => {
    const input = createInput();
    const ports = createTeamProvisioningPersistedLaunchReconcilePorts(input);
    const snapshot = createPersistedLaunchSnapshot({
      teamName: 'demo',
      expectedMembers: ['Builder'],
      launchPhase: 'active',
      members: {
        Builder: member(),
      },
      updatedAt: at,
    });

    expect(
      ports.hasLeadInboxLaunchReconcileHeartbeat(snapshot, [
        {
          from: 'Builder',
          text: 'bootstrap is ready',
          timestamp: at,
          messageId: 'msg-1',
        },
      ])
    ).toBe(true);

    expect(
      ports.selectLatestLeadInboxLaunchReconcileMessage({
        messages: [
          {
            from: 'Builder',
            text: 'older',
            timestamp: at,
            messageId: 'msg-1',
          },
          {
            from: 'Builder',
            text: 'newer',
            timestamp: '2026-01-01T00:00:01.000Z',
            messageId: 'msg-2',
          },
        ],
        expectedMembers: ['Builder'],
        expected: 'Builder',
        firstSpawnAcceptedAt: at,
      })?.messageId
    ).toBe('msg-2');

    expect(input.resolveExpectedLaunchMemberName).toHaveBeenCalledWith(['Builder'], 'Builder');
  });

  it('wires process bootstrap transport reads to persisted runtime members', async () => {
    const input = createInput({
      readPersistedRuntimeMembers: vi.fn(() => [
        {
          name: 'Builder',
          backendType: 'process',
        },
      ]),
    });
    const ports = createTeamProvisioningPersistedLaunchReconcilePorts(input);

    await expect(
      ports.readProcessBootstrapTransportSummary({
        teamName: 'demo',
        memberName: 'Builder',
        member: member(),
      })
    ).resolves.toBeNull();

    expect(input.readPersistedRuntimeMembers).toHaveBeenCalledWith('demo');
  });
});
