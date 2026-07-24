import { planTeamRuntimeLanes } from '@features/team-runtime-lanes/core/domain/planTeamRuntimeLanes';
import { detectOpenCodeApiCapabilities } from '@main/services/team/opencode/capabilities/OpenCodeApiCapabilities';
import { REQUIRED_AGENT_TEAMS_APP_TOOL_IDS } from '@main/services/team/opencode/mcp/OpenCodeMcpToolAvailability';
import { extractAuthStatusReadiness } from '@main/services/team/provisioning/TeamProvisioningProviderPreflight';
import {
  recoverStaleMixedSecondaryLaunchSnapshotWithPorts,
  type StaleMixedSecondaryRecoveryPorts,
} from '@main/services/team/provisioning/TeamProvisioningStaleMixedSecondaryRecovery';
import {
  OpenCodeTeamRuntimeAdapter,
  type OpenCodeTeamRuntimeBridgePort,
  type TeamRuntimeLaunchInput,
} from '@main/services/team/runtime';
import { describe, expect, it, vi } from 'vitest';

import type { OpenCodeLaunchTeamCommandData } from '@main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import type { OpenCodeTeamLaunchReadiness } from '@main/services/team/opencode/readiness/OpenCodeTeamLaunchReadiness';
import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchSnapshot,
  TeamMember,
} from '@shared/types';

const NOW = '2026-07-12T00:00:00.000Z';

function planner(
  leadProviderId: 'anthropic' | 'codex' | 'gemini' | 'opencode',
  providers: Array<'anthropic' | 'codex' | 'gemini' | 'opencode'>
) {
  return planTeamRuntimeLanes({
    leadProviderId,
    members: providers.map((providerId, index) => ({ name: `member-${index + 1}`, providerId })),
  });
}

function readiness(
  overrides: Partial<OpenCodeTeamLaunchReadiness> = {}
): OpenCodeTeamLaunchReadiness {
  return {
    state: 'ready',
    launchAllowed: true,
    modelId: 'openai/gpt-5.4-mini',
    availableModels: ['openai/gpt-5.4-mini'],
    opencodeVersion: '1.14.19',
    installMethod: 'brew',
    binaryPath: '/managed/opencode',
    hostHealthy: true,
    appMcpConnected: true,
    requiredToolsPresent: true,
    permissionBridgeReady: true,
    runtimeStoresReady: true,
    supportLevel: 'production_supported',
    missing: [],
    diagnostics: [],
    evidence: {
      capabilitiesReady: true,
      mcpToolProofRoute: '/experimental/tool/ids',
      observedMcpTools: [...REQUIRED_AGENT_TEAMS_APP_TOOL_IDS],
      runtimeStoreReadinessReason: 'runtime_store_manifest_valid',
    },
    ...overrides,
  };
}

function launchInput(
  expectedMembers: TeamRuntimeLaunchInput['expectedMembers'] = [
    { name: 'alice', providerId: 'opencode', model: 'openai/gpt-5.4-mini', cwd: '/repo' },
  ]
): TeamRuntimeLaunchInput {
  return {
    runId: 'run-1',
    teamName: 'team-a',
    cwd: '/repo',
    providerId: 'opencode',
    model: 'openai/gpt-5.4-mini',
    skipPermissions: true,
    expectedMembers,
    previousLaunchState: null,
  };
}

function launchData(memberNames: string[]): OpenCodeLaunchTeamCommandData {
  return {
    runId: 'run-1',
    teamLaunchState: 'ready',
    members: Object.fromEntries(
      memberNames.map((name, index) => [
        name,
        {
          sessionId: `session-${index + 1}`,
          launchState: 'confirmed_alive' as const,
          runtimePid: 100 + index,
          model: 'openai/gpt-5.4-mini',
          evidence: [
            { kind: 'required_tools_proven' as const, observedAt: NOW },
            { kind: 'delivery_ready' as const, observedAt: NOW },
            { kind: 'member_ready' as const, observedAt: NOW },
            { kind: 'run_ready' as const, observedAt: NOW },
          ],
        },
      ])
    ),
    warnings: [],
    diagnostics: [],
  };
}

function adapter(
  readinessResult: OpenCodeTeamLaunchReadiness,
  launchResult: OpenCodeLaunchTeamCommandData = launchData(['alice'])
): OpenCodeTeamRuntimeAdapter {
  const bridge: OpenCodeTeamRuntimeBridgePort = {
    checkOpenCodeTeamLaunchReadiness: vi.fn(async () => readinessResult),
    getLastOpenCodeRuntimeSnapshot: () => ({
      providerId: 'opencode',
      binaryPath: '/managed/opencode',
      binaryFingerprint: 'version:1.14.19',
      version: '1.14.19',
      capabilitySnapshotId: 'cap-1',
    }),
    launchOpenCodeTeam: vi.fn(async () => launchResult),
  };
  return new OpenCodeTeamRuntimeAdapter(bridge);
}

function snapshot(): PersistedTeamLaunchSnapshot {
  return {
    version: 2,
    teamName: 'team-a',
    updatedAt: NOW,
    launchPhase: 'active',
    expectedMembers: ['Bob'],
    members: {
      Bob: {
        name: 'Bob',
        providerId: 'opencode',
        laneId: 'secondary:opencode:Bob',
        laneKind: 'secondary',
        laneOwnerProviderId: 'opencode',
        launchState: 'runtime_pending_bootstrap',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: false,
        hardFailure: false,
        lastEvaluatedAt: NOW,
        diagnostics: [],
      },
    },
    summary: {
      confirmedCount: 0,
      pendingCount: 1,
      failedCount: 0,
      runtimeAlivePendingCount: 1,
      shellOnlyPendingCount: 0,
      runtimeProcessPendingCount: 1,
      runtimeCandidatePendingCount: 0,
      noRuntimePendingCount: 0,
      permissionPendingCount: 0,
    },
    teamLaunchState: 'partial_pending',
  };
}

function recoveryPorts(
  overrides: Partial<StaleMixedSecondaryRecoveryPorts> = {}
): StaleMixedSecondaryRecoveryPorts {
  const member: TeamMember = { name: 'Bob', providerId: 'opencode', cwd: '/repo-bob' };
  return {
    hasMixedSecondaryLaunchMetadata: () => false,
    shouldRecoverStalePersistedMixedLaunchSnapshot: () => true,
    readTeamMeta: async () => ({ providerId: 'codex' }),
    readMembersMeta: async () => ({ members: [{ name: 'Lead' }, member] }),
    readPersistedTeamProjectPath: () => '/repo',
    readOpenCodeRuntimeLaneIndex: async () => ({
      version: 1,
      updatedAt: NOW,
      lanes: {
        'secondary:opencode:Bob': {
          laneId: 'secondary:opencode:Bob',
          state: 'active',
          updatedAt: NOW,
        },
      },
    }),
    buildPlannedMemberLaneIdentity: ({ member: planned }) =>
      planned.providerId === 'opencode'
        ? {
            laneId: `secondary:opencode:${planned.name}`,
            laneKind: 'secondary',
            laneOwnerProviderId: 'opencode',
          }
        : { laneId: 'primary', laneKind: 'primary', laneOwnerProviderId: 'codex' },
    buildOpenCodeSecondaryLaneId: (planned) => `secondary:opencode:${planned.name}`,
    snapshotToMemberSpawnStatuses: () => ({}),
    createInitialMemberSpawnStatusEntry: (): MemberSpawnStatusEntry => ({
      status: 'waiting',
      launchState: 'starting',
      updatedAt: NOW,
    }),
    isLeadMember: (planned) => planned.name === 'Lead',
    tryRecoverMissingOpenCodeSecondaryLaneFromRuntime: async () => null,
    tryRecoverActiveOpenCodeSecondaryLaneFromRuntime: async () => ({
      memberName: 'Bob',
      providerId: 'opencode',
      launchState: 'runtime_pending_bootstrap',
      agentToolAccepted: true,
      runtimeAlive: true,
      bootstrapConfirmed: false,
      hardFailure: false,
      runtimePid: 123,
      sessionId: 'runtime-session-1',
      livenessKind: 'runtime_process',
      pidSource: 'opencode_bridge',
      diagnostics: ['runtime recovered'],
    }),
    resolveCurrentOpenCodeRuntimeRunId: async () => 'runtime-run-1',
    recoverStaleOpenCodeRuntimeLaneIndexEntry: async () => ({
      stale: false,
      degraded: false,
      diagnostics: [],
    }),
    nowIso: () => NOW,
    getTeamsBasePath: () => '/teams',
    buildAggregateLaunchSnapshot: ({ teamName }) => ({ ...snapshot(), teamName }),
    writeLaunchStateSnapshot: async (_teamName, value) => value,
    ...overrides,
  };
}

describe('Phase 0 W2 canonical fake-runtime seam proofs', () => {
  it('w2.fake-runtime.homogeneous_anthropic.positive', () => {
    expect(planner('anthropic', ['anthropic', 'anthropic'])).toMatchObject({
      ok: true,
      plan: { mode: 'primary_only' },
    });
  });
  it('w2.fake-runtime.homogeneous_anthropic.failing-negative', () => {
    expect(planner('anthropic', ['anthropic', 'opencode'])).toMatchObject({
      ok: true,
      plan: { mode: 'mixed_opencode_side_lanes' },
    });
  });
  it('w2.fake-runtime.homogeneous_codex.positive', () => {
    expect(planner('codex', ['codex', 'codex'])).toMatchObject({
      ok: true,
      plan: { mode: 'primary_only' },
    });
  });
  it('w2.fake-runtime.homogeneous_codex.failing-negative', () => {
    expect(planner('codex', ['codex', 'opencode'])).toMatchObject({
      ok: true,
      plan: { mode: 'mixed_opencode_side_lanes' },
    });
  });
  it('w2.fake-runtime.homogeneous_gemini.positive', () => {
    expect(planner('gemini', ['gemini', 'gemini'])).toMatchObject({
      ok: true,
      plan: { mode: 'primary_only' },
    });
  });
  it('w2.fake-runtime.homogeneous_gemini.failing-negative', () => {
    expect(planner('gemini', ['gemini', 'opencode'])).toMatchObject({
      ok: true,
      plan: { mode: 'mixed_opencode_side_lanes' },
    });
  });
  it('w2.fake-runtime.homogeneous_opencode.positive', () => {
    expect(planner('opencode', ['opencode', 'opencode'])).toMatchObject({
      ok: true,
      plan: { mode: 'pure_opencode' },
    });
  });
  it('w2.fake-runtime.homogeneous_opencode.failing-negative', () => {
    expect(planner('opencode', ['opencode', 'codex'])).toMatchObject({
      ok: false,
      reason: 'unsupported_opencode_led_mixed_team',
    });
  });
  it('w2.fake-runtime.mixed_provider_team.positive', () => {
    expect(planner('codex', ['codex', 'gemini', 'opencode'])).toMatchObject({
      ok: true,
      plan: { mode: 'mixed_opencode_side_lanes' },
    });
  });
  it('w2.fake-runtime.mixed_provider_team.failing-negative', () => {
    expect(planner('opencode', ['opencode', 'gemini'])).toMatchObject({
      ok: false,
      reason: 'unsupported_opencode_led_mixed_team',
    });
  });
  it('w2.fake-runtime.missing_runtime.positive', async () => {
    await expect(
      adapter(readiness({ state: 'not_installed', launchAllowed: false })).prepare(launchInput())
    ).resolves.toMatchObject({ ok: false, reason: 'not_installed' });
  });
  it('w2.fake-runtime.missing_runtime.failing-negative', async () => {
    await expect(adapter(readiness()).prepare(launchInput())).resolves.toMatchObject({
      ok: true,
      providerId: 'opencode',
    });
  });
  it('w2.fake-runtime.missing_auth.positive', () => {
    expect(
      extractAuthStatusReadiness('codex', {
        loggedIn: true,
        providers: { codex: { authenticated: false } },
      })
    ).toEqual({ authenticated: false, providerStatus: { authenticated: false } });
  });
  it('w2.fake-runtime.missing_auth.failing-negative', () => {
    expect(
      extractAuthStatusReadiness('codex', {
        loggedIn: false,
        providers: { codex: { authenticated: true } },
      })
    ).toEqual({ authenticated: true, providerStatus: { authenticated: true } });
  });
  it('w2.fake-runtime.unsupported_backend.positive', () => {
    expect(planner('opencode', ['opencode', 'anthropic'])).toMatchObject({
      ok: false,
      reason: 'unsupported_opencode_led_mixed_team',
    });
  });
  it('w2.fake-runtime.unsupported_backend.failing-negative', () => {
    expect(planner('anthropic', ['anthropic', 'opencode'])).toMatchObject({
      ok: true,
      plan: { mode: 'mixed_opencode_side_lanes' },
    });
  });
  it('w2.fake-runtime.malformed_capability_response.positive', async () => {
    const malformedFetch = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      return path === '/doc' || path === '/doc.json' || path === '/openapi.json'
        ? new Response('{"openapi":', { status: 200 })
        : new Response('{}', { status: 404 });
    }) as typeof fetch;
    const capabilities = await detectOpenCodeApiCapabilities({
      baseUrl: 'http://fixture.invalid',
      fetchImpl: malformedFetch,
    });

    expect(capabilities.requiredForTeamLaunch.ready).toBe(false);
    expect(capabilities.requiredForTeamLaunch.missing).toContain('GET /global/health');
    expect(capabilities.diagnostics).toEqual(
      expect.arrayContaining([expect.stringContaining('OpenCode /doc probe failed')])
    );
  });
  it('w2.fake-runtime.malformed_capability_response.failing-negative', async () => {
    const validDocument = {
      openapi: '3.1.0',
      info: { version: '1.14.19' },
      paths: {
        '/global/health': { get: {} },
        '/session': { post: {} },
        '/session/{sessionID}': { get: {} },
        '/session/{sessionID}/message': { get: {} },
        '/session/{sessionID}/prompt_async': { post: {} },
        '/session/{sessionID}/abort': { post: {} },
        '/session/status': { get: {} },
        '/permission': { get: {} },
        '/permission/{requestID}/reply': { post: {} },
        '/event': { get: {} },
        '/global/event': { get: {} },
        '/mcp': { get: {}, post: {} },
        '/experimental/tool/ids': { get: {} },
      },
    };
    const validFetch = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      return path === '/doc'
        ? new Response(JSON.stringify(validDocument), { status: 200 })
        : new Response('{}', { status: 404 });
    }) as typeof fetch;
    const capabilities = await detectOpenCodeApiCapabilities({
      baseUrl: 'http://fixture.invalid',
      fetchImpl: validFetch,
    });

    expect(capabilities.requiredForTeamLaunch).toEqual({ ready: true, missing: [] });
    expect(capabilities.source).toBe('openapi_doc');
  });
  it('w2.fake-runtime.process_timeout.positive', async () => {
    await expect(
      adapter(
        readiness({
          state: 'unknown_error',
          launchAllowed: false,
          diagnostics: ['OpenCode bridge command timed out'],
        })
      ).launch(launchInput())
    ).resolves.toMatchObject({
      teamLaunchState: 'partial_failure',
      members: { alice: { launchState: 'failed_to_start' } },
    });
  });
  it('w2.fake-runtime.process_timeout.failing-negative', async () => {
    await expect(adapter(readiness()).launch(launchInput())).resolves.toMatchObject({
      teamLaunchState: 'clean_success',
      members: { alice: { launchState: 'confirmed_alive' } },
    });
  });
  it('w2.fake-runtime.partial_launch.positive', async () => {
    const members = [
      {
        name: 'alice',
        providerId: 'opencode' as const,
        model: 'openai/gpt-5.4-mini',
        cwd: '/repo',
      },
      { name: 'bob', providerId: 'opencode' as const, model: 'openai/gpt-5.4-mini', cwd: '/repo' },
    ];
    await expect(
      adapter(readiness(), launchData(['alice'])).launch(launchInput(members))
    ).resolves.toMatchObject({
      teamLaunchState: 'partial_pending',
      members: {
        alice: { launchState: 'confirmed_alive' },
        bob: { launchState: 'runtime_pending_bootstrap' },
      },
    });
  });
  it('w2.fake-runtime.partial_launch.failing-negative', async () => {
    const members = [
      {
        name: 'alice',
        providerId: 'opencode' as const,
        model: 'openai/gpt-5.4-mini',
        cwd: '/repo',
      },
      { name: 'bob', providerId: 'opencode' as const, model: 'openai/gpt-5.4-mini', cwd: '/repo' },
    ];
    await expect(
      adapter(readiness(), launchData(['alice', 'bob'])).launch(launchInput(members))
    ).resolves.toMatchObject({
      teamLaunchState: 'clean_success',
      members: {
        alice: { launchState: 'confirmed_alive' },
        bob: { launchState: 'confirmed_alive' },
      },
    });
  });
  it('w2.fake-runtime.restart_adoption.positive', async () => {
    const persisted = snapshot();
    await expect(
      recoverStaleMixedSecondaryLaunchSnapshotWithPorts(
        'team-a',
        null,
        persisted,
        recoveryPorts({
          hasMixedSecondaryLaunchMetadata: () => true,
          shouldRecoverStalePersistedMixedLaunchSnapshot: () => false,
        })
      )
    ).resolves.toBe(persisted);
  });
  it('w2.fake-runtime.restart_adoption.failing-negative', async () => {
    await expect(
      recoverStaleMixedSecondaryLaunchSnapshotWithPorts(
        'team-a',
        null,
        snapshot(),
        recoveryPorts({ readTeamMeta: async () => null })
      )
    ).resolves.toBeNull();
  });
  it('w2.fake-runtime.opencode_secondary_lane_recovery.positive', async () => {
    await expect(
      recoverStaleMixedSecondaryLaunchSnapshotWithPorts('team-a', null, snapshot(), recoveryPorts())
    ).resolves.toMatchObject({ teamName: 'team-a' });
  });
  it('w2.fake-runtime.opencode_secondary_lane_recovery.failing-negative', async () => {
    await expect(
      recoverStaleMixedSecondaryLaunchSnapshotWithPorts(
        'team-a',
        null,
        snapshot(),
        recoveryPorts({ tryRecoverActiveOpenCodeSecondaryLaneFromRuntime: async () => null })
      )
    ).resolves.toBeNull();
  });
});
