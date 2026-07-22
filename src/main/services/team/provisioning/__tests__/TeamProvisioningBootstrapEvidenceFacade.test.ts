import { describe, expect, it, vi } from 'vitest';

import { createPersistedLaunchSnapshot } from '../../TeamLaunchStateEvaluator';
import {
  createTeamProvisioningBootstrapEvidenceFacadeDepsFromService,
  TeamProvisioningBootstrapEvidenceFacade,
  type TeamProvisioningBootstrapEvidenceFacadeServiceHost,
} from '../TeamProvisioningBootstrapEvidenceFacade';

import type { TeamProvisioningBootstrapTranscriptFacade } from '../TeamProvisioningBootstrapTranscriptFacade';
import type { OpenCodeSecondaryEvidenceOverlayPorts } from '../TeamProvisioningLaunchStateReconciliation';
import type { OpenCodeRuntimeBootstrapEvidencePorts } from '../TeamProvisioningOpenCodeBootstrapEvidence';
import type { PersistedTeamLaunchMemberState } from '@shared/types';

const NOW = '2026-01-01T00:00:00.000Z';

function member(
  overrides: Partial<PersistedTeamLaunchMemberState> = {}
): PersistedTeamLaunchMemberState {
  return {
    name: 'Builder',
    launchState: 'starting',
    agentToolAccepted: true,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    firstSpawnAcceptedAt: '2025-12-31T23:59:00.000Z',
    lastEvaluatedAt: '2025-12-31T23:59:00.000Z',
    ...overrides,
  };
}

function transcriptFacade(overrides: Record<string, unknown> = {}) {
  const memberLogsFinder = { findMemberLogs: vi.fn(async () => []) };
  const setMemberLogsFinderForCompatibility = vi.fn();
  const facade = {
    parsedBootstrapTranscriptTailCache: new Map(),
    getMemberLogsFinderForCompatibility: vi.fn(() => memberLogsFinder),
    setMemberLogsFinderForCompatibility,
    findBootstrapTranscriptFailureReason: vi.fn(async () => 'failed from transcript'),
    findBootstrapTranscriptOutcome: vi.fn(async () => ({
      kind: 'success',
      observedAt: NOW,
      source: 'assistant_text',
    })),
    readRecentBootstrapTranscriptOutcome: vi.fn(async () => ({
      kind: 'success',
      observedAt: NOW,
      source: 'assistant_text',
    })),
    readBootstrapTranscriptOutcomesInProjectRoot: vi.fn(async () => []),
    ...overrides,
  } as unknown as TeamProvisioningBootstrapTranscriptFacade;
  return { facade, memberLogsFinder, setMemberLogsFinderForCompatibility };
}

describe('TeamProvisioningBootstrapEvidenceFacade', () => {
  it('builds facade deps from service-shaped dependencies', () => {
    const { facade: bootstrapTranscriptFacade } = transcriptFacade();
    const readPersistedRuntimeMembers = vi.fn(() => []);
    const service = {
      bootstrapTranscriptFacade,
      readPersistedRuntimeMembers,
    } satisfies TeamProvisioningBootstrapEvidenceFacadeServiceHost;

    const deps = createTeamProvisioningBootstrapEvidenceFacadeDepsFromService(service, {
      getTeamsBasePath: () => '/teams',
      nowIso: () => NOW,
      warn: vi.fn(),
    });

    expect(deps.bootstrapTranscriptFacade).toBe(bootstrapTranscriptFacade);
    expect(deps.readPersistedRuntimeMembers('demo')).toEqual([]);
    expect(readPersistedRuntimeMembers).toHaveBeenCalledWith('demo');
    expect(deps.getTeamsBasePath?.()).toBe('/teams');
    expect(deps.nowIso()).toBe(NOW);
  });

  it('owns transcript, runtime proof, evidence port, and member log compatibility wrappers', async () => {
    const {
      facade: bootstrapTranscriptFacade,
      memberLogsFinder,
      setMemberLogsFinderForCompatibility,
    } = transcriptFacade();
    const createOpenCodeRuntimeBootstrapEvidencePorts = vi.fn(
      (input: { teamsBasePath: string; warn(message: string): void }) =>
        input as unknown as OpenCodeRuntimeBootstrapEvidencePorts
    );
    const facade = new TeamProvisioningBootstrapEvidenceFacade({
      bootstrapTranscriptFacade,
      readPersistedRuntimeMembers: vi.fn(() => []),
      getTeamsBasePath: () => '/teams',
      nowIso: () => NOW,
      warn: vi.fn(),
      createOpenCodeRuntimeBootstrapEvidencePorts,
    });

    expect(facade.memberLogsFinder).toBe(memberLogsFinder);
    const nextMemberLogsFinder = { findMemberLogs: vi.fn(async () => []) };
    facade.memberLogsFinder = nextMemberLogsFinder;

    await expect(facade.findBootstrapTranscriptFailureReason('demo', 'Builder', 123)).resolves.toBe(
      'failed from transcript'
    );
    await expect(facade.findBootstrapTranscriptOutcome('demo', 'Builder', 123)).resolves.toEqual({
      kind: 'success',
      observedAt: NOW,
      source: 'assistant_text',
    });
    await expect(
      facade.findBootstrapRuntimeProofObservedAt('demo', 'Builder', member())
    ).resolves.toBe(null);

    const ports = facade.createOpenCodeRuntimeBootstrapEvidencePorts();
    expect(ports).toEqual({ teamsBasePath: '/teams', warn: expect.any(Function) });
    expect(setMemberLogsFinderForCompatibility).toHaveBeenCalledWith(nextMemberLogsFinder);
    expect(createOpenCodeRuntimeBootstrapEvidencePorts).toHaveBeenCalledWith({
      teamsBasePath: '/teams',
      warn: expect.any(Function),
    });
  });

  it('applies bootstrap transcript and process transport overlays through the bounded facade', async () => {
    const { facade: bootstrapTranscriptFacade } = transcriptFacade();
    const facade = new TeamProvisioningBootstrapEvidenceFacade({
      bootstrapTranscriptFacade,
      readPersistedRuntimeMembers: vi.fn(() => []),
      getTeamsBasePath: () => '/teams',
      nowIso: () => NOW,
      warn: vi.fn(),
    });
    const snapshot = createPersistedLaunchSnapshot({
      teamName: 'demo',
      expectedMembers: ['Builder'],
      launchPhase: 'active',
      members: { Builder: member() },
      updatedAt: NOW,
    });

    const overlaid = await facade.applyBootstrapTranscriptEvidenceOverlay(snapshot);
    expect(overlaid?.members.Builder).toMatchObject({
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
      hardFailure: false,
    });

    const transport = facade.applyProcessBootstrapTransportOverlay({
      member: member(),
      summary: {
        submitted: false,
        hasProgress: true,
        lastStage: 'bootstrap prompt observed',
      },
      launchPhase: 'active',
    });
    expect(transport).toMatchObject({
      launchState: 'runtime_pending_bootstrap',
      bootstrapConfirmed: false,
      runtimeDiagnosticSeverity: 'warning',
    });
  });

  it('delegates OpenCode secondary evidence overlay through injected overlay ports', async () => {
    const { facade: bootstrapTranscriptFacade } = transcriptFacade();
    const readLaneIndex = vi.fn(async () => null);
    const readCommittedBootstrapSessionEvidence = vi.fn(async () => ({
      committed: false,
      activeRunId: null,
      sessions: [],
      diagnostics: [],
    }));
    const overlayPorts: OpenCodeSecondaryEvidenceOverlayPorts = {
      readLaneIndex,
      readCommittedBootstrapSessionEvidence,
      hasBootstrapCheckinTombstone: vi.fn(async () => false),
      nowIso: () => NOW,
    };
    const facade = new TeamProvisioningBootstrapEvidenceFacade({
      bootstrapTranscriptFacade,
      readPersistedRuntimeMembers: vi.fn(() => []),
      getTeamsBasePath: () => '/teams',
      nowIso: () => NOW,
      warn: vi.fn(),
      openCodeSecondaryEvidenceOverlayPorts: overlayPorts,
    });
    const snapshot = createPersistedLaunchSnapshot({
      teamName: 'demo',
      expectedMembers: ['Builder'],
      launchPhase: 'active',
      members: {
        Builder: member({
          providerId: 'opencode',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          laneId: 'lane-1',
          runtimeRunId: 'run-1',
        }),
      },
      updatedAt: NOW,
    });

    await expect(
      facade.applyOpenCodeSecondaryEvidenceOverlay({ teamName: 'demo', snapshot })
    ).resolves.toBe(snapshot);

    expect(readLaneIndex).toHaveBeenCalledWith('demo');
    expect(readCommittedBootstrapSessionEvidence).toHaveBeenCalledWith({
      teamName: 'demo',
      laneId: 'lane-1',
    });
  });
});
