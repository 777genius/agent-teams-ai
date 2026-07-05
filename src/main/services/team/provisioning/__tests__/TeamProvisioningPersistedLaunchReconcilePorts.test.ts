import { describe, expect, it, vi } from 'vitest';

import { createPersistedLaunchSnapshot } from '../../TeamLaunchStateEvaluator';
import {
  createTeamProvisioningPersistedLaunchReconcilePorts,
  type TeamProvisioningPersistedLaunchReconcilePortsInput,
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
