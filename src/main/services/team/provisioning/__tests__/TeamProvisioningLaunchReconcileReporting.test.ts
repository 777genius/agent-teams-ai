import { describe, expect, it, vi } from 'vitest';

import {
  createDefaultLaunchReconcileConfigMembers,
  parseLaunchReconcileConfigMembers,
  reconcilePersistedLaunchMember,
  type ReconcilePersistedLaunchMemberPorts,
} from '../TeamProvisioningLaunchReconcileReporting';

import type { LeadInboxLaunchReconcileMessage } from '../TeamProvisioningBootstrapTranscript';
import type { LiveTeamAgentRuntimeMetadata } from '../TeamProvisioningRuntimeMetadataPolicy';
import type { PersistedTeamLaunchMemberState } from '@shared/types';

const at = '2026-01-01T00:00:00.000Z';
const acceptedAt = '2025-12-31T23:59:00.000Z';
const observedAt = '2026-01-01T00:00:01.000Z';

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
    lastEvaluatedAt: at,
    ...overrides,
  };
}

function ports(
  overrides: Partial<ReconcilePersistedLaunchMemberPorts> = {}
): ReconcilePersistedLaunchMemberPorts {
  return {
    selectLatestLeadInboxLaunchReconcileMessage: () => null,
    findBootstrapRuntimeProofObservedAt: vi.fn(async () => null),
    findBootstrapTranscriptOutcome: vi.fn(async () => null),
    readProcessBootstrapTransportSummary: vi.fn(async () => null),
    applyProcessBootstrapTransportOverlay: ({ member }) => member,
    nowMs: () => Date.parse(at),
    ...overrides,
  };
}

describe('launch reconcile reporting helpers', () => {
  it('parses config members, lead name, and bootstrap run ids', () => {
    const parsed = parseLaunchReconcileConfigMembers(
      JSON.stringify({
        members: [
          { name: 'team-lead', agentType: 'lead', bootstrapRunId: 'lead-run' },
          { name: ' Builder ', bootstrapRunId: ' run-1 ' },
          { name: 'Reviewer' },
          { name: '   ', bootstrapRunId: 'ignored' },
        ],
      })
    );

    expect(parsed.leadName).toBe('team-lead');
    expect([...parsed.configMembers]).toEqual(['Builder', 'Reviewer']);
    expect([...parsed.configBootstrapRunIds]).toEqual([['Builder', 'run-1']]);
    expect(createDefaultLaunchReconcileConfigMembers('fallback').leadName).toBe('fallback');
  });

  it('applies runtime proof and metadata when reconciling a persisted member', async () => {
    const findBootstrapRuntimeProofObservedAt = vi.fn(async () => observedAt);
    const runtime = new Map<string, LiveTeamAgentRuntimeMetadata>([
      ['Builder', { alive: true, livenessKind: 'runtime_process', pidSource: 'runtime_bootstrap' }],
    ]);

    const next = await reconcilePersistedLaunchMember({
      teamName: 'demo',
      expected: 'Builder',
      current: member({
        agentToolAccepted: true,
        firstSpawnAcceptedAt: acceptedAt,
        hardFailure: true,
        hardFailureReason: 'Teammate did not join within the launch grace window.',
      }),
      bootstrapMember: undefined,
      persistedMemberNames: ['Builder'],
      configMembers: new Set(['Builder']),
      configBootstrapRunIds: new Map(),
      leadInboxMessages: [],
      liveRuntimeByMember: runtime,
      launchPhase: 'active',
      now: at,
      ports: ports({ findBootstrapRuntimeProofObservedAt }),
    });

    expect(findBootstrapRuntimeProofObservedAt).toHaveBeenCalledWith(
      'demo',
      'Builder',
      expect.objectContaining({ name: 'Builder' })
    );
    expect(next).toMatchObject({
      launchState: 'confirmed_alive',
      runtimeAlive: true,
      bootstrapConfirmed: true,
      hardFailure: false,
      hardFailureReason: undefined,
      lastHeartbeatAt: observedAt,
      lastRuntimeAliveAt: at,
      livenessKind: 'runtime_process',
      pidSource: 'runtime_bootstrap',
      sources: {
        processAlive: true,
        configRegistered: true,
      },
    });
    expect(next.diagnostics).toBeUndefined();
  });

  it('overlays lead inbox bootstrap failure reasons before transcript probing', async () => {
    const heartbeat: LeadInboxLaunchReconcileMessage = {
      from: 'team-lead',
      text: 'Bootstrap failed: member_briefing tool is not available',
      timestamp: observedAt,
      messageId: 'message-1',
    };
    const findBootstrapRuntimeProofObservedAt = vi.fn(async () => observedAt);

    const next = await reconcilePersistedLaunchMember({
      teamName: 'demo',
      expected: 'Builder',
      current: member({
        agentToolAccepted: true,
        firstSpawnAcceptedAt: acceptedAt,
      }),
      bootstrapMember: undefined,
      persistedMemberNames: ['Builder'],
      configMembers: new Set<string>(),
      configBootstrapRunIds: new Map(),
      leadInboxMessages: [heartbeat],
      liveRuntimeByMember: new Map(),
      launchPhase: 'active',
      now: at,
      ports: ports({
        selectLatestLeadInboxLaunchReconcileMessage: () => heartbeat,
        findBootstrapRuntimeProofObservedAt,
      }),
    });

    expect(findBootstrapRuntimeProofObservedAt).not.toHaveBeenCalled();
    expect(next).toMatchObject({
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: heartbeat.text,
      runtimeDiagnostic: heartbeat.text,
      runtimeDiagnosticSeverity: 'error',
      sources: {
        configDrift: true,
        inboxHeartbeat: true,
        hardFailureSignal: true,
      },
    });
  });
});
