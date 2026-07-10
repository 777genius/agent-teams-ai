import { describe, expect, it } from 'vitest';

import {
  hasRuntimeProjectionBootstrapConfirmationEvidence,
  hasRuntimeProjectionSnapshotBootstrapConfirmationEvidence,
  isStrongRuntimeEvidence,
  mapRuntimeProjectionMemberEntry,
  mapRuntimeProjectionSnapshot,
  projectRuntimeDiagnostics,
  projectRuntimeLiveness,
  projectRuntimeResource,
  projectRuntimeSnapshotMemberLivenessFields,
  projectRuntimeSnapshotResourceFields,
  readVerifiedRuntimeProcessLivenessEvidence,
} from '../index';

const NOW_MS = Date.parse('2026-01-01T00:05:00.000Z');

describe('runtime projection foundation', () => {
  it('projects missing process evidence without inventing resource usage', () => {
    const liveness = projectRuntimeLiveness({
      process: {
        pid: 4242,
        running: false,
        processTableAvailable: true,
      },
      registration: {
        runtimePid: 4242,
        runtimeSessionId: 'session-1',
      },
    });

    expect(liveness).toMatchObject({
      alive: false,
      livenessKind: 'stale_metadata',
      pid: 4242,
      pidSource: 'persisted_metadata',
      runtimeSessionId: 'session-1',
      runtimeDiagnostic: 'persisted runtime pid is not alive',
      runtimeDiagnosticSeverity: 'warning',
    });

    expect(
      projectRuntimeResource({
        pid: 4242,
        processAlive: false,
        usage: {
          cpuPercent: 31,
          rssBytes: 8192,
        },
      })
    ).toEqual({});
  });

  it('does not treat stale heartbeat evidence as a live runtime', () => {
    const liveness = projectRuntimeLiveness(
      {
        heartbeat: {
          bootstrapConfirmed: true,
          lastHeartbeatAt: '2026-01-01T00:00:00.000Z',
          runtimeSessionId: 'session-stale',
        },
      },
      {
        nowMs: NOW_MS,
        heartbeatStaleAfterMs: 60_000,
      }
    );

    expect(liveness).toMatchObject({
      alive: false,
      livenessKind: 'registered_only',
      pidSource: 'runtime_bootstrap',
      runtimeSessionId: 'session-stale',
      runtimeLastSeenAt: '2026-01-01T00:00:00.000Z',
      runtimeDiagnostic: 'runtime heartbeat is stale',
      runtimeDiagnosticSeverity: 'warning',
    });
    expect(liveness.diagnostics).toContain('bootstrap evidence exists, but the heartbeat is stale');
  });

  it('classifies only verified process and bootstrap liveness as strong evidence', () => {
    expect(isStrongRuntimeEvidence({ livenessKind: 'runtime_process' })).toBe(true);
    expect(isStrongRuntimeEvidence({ livenessKind: 'confirmed_bootstrap' })).toBe(true);
    expect(isStrongRuntimeEvidence({ livenessKind: 'runtime_process_candidate' })).toBe(false);
    expect(isStrongRuntimeEvidence(undefined)).toBe(false);
  });

  it('keeps running process evidence weak until identity is verified', () => {
    const cases = [
      { label: 'missing identity verification', process: {} },
      { label: 'failed identity verification', process: { identityVerified: false } },
    ];

    for (const { label, process } of cases) {
      const liveness = projectRuntimeLiveness({
        process: {
          pid: 4444,
          metricsPid: 4445,
          running: true,
          pidSource: 'agent_process_table',
          command: 'codex --token fixture-token --team-name demo',
          ...process,
        },
      });

      expect(liveness, label).toMatchObject({
        alive: false,
        livenessKind: 'runtime_process_candidate',
        pid: 4444,
        metricsPid: 4445,
        pidSource: 'agent_process_table',
        processCommand: 'codex --token [redacted] --team-name demo',
        runtimeDiagnostic: 'runtime process candidate detected, but identity is unverified',
        runtimeDiagnosticSeverity: 'warning',
      });
    }
  });

  it('lets fresh confirmed bootstrap prove liveness over weak process evidence', () => {
    const liveness = projectRuntimeLiveness(
      {
        process: {
          pid: 5151,
          running: true,
          identityVerified: false,
          pidSource: 'opencode_bridge',
          command: 'opencode run --api-key fixture-value',
        },
        heartbeat: {
          bootstrapConfirmed: true,
          lastHeartbeatAt: '2026-01-01T00:04:30.000Z',
          runtimeSessionId: 'session-fresh',
        },
      },
      {
        nowMs: NOW_MS,
        heartbeatStaleAfterMs: 60_000,
      }
    );

    expect(liveness).toMatchObject({
      alive: true,
      livenessKind: 'confirmed_bootstrap',
      pidSource: 'runtime_bootstrap',
      runtimeSessionId: 'session-fresh',
      runtimeLastSeenAt: '2026-01-01T00:04:30.000Z',
      runtimeDiagnostic: 'bootstrap confirmed; process identity is unverified',
      runtimeDiagnosticSeverity: 'info',
    });
    expect(liveness.pid).toBeUndefined();
    expect(liveness.processCommand).toBeUndefined();
    expect(liveness.diagnostics).toEqual([
      'bootstrap confirmed; process identity is unverified',
      'fresh runtime heartbeat confirmed bootstrap',
      'runtime process is alive without verified runtime identity',
    ]);
  });

  it('keeps persisted-only evidence registered and resource-empty', () => {
    expect(
      projectRuntimeLiveness({
        registration: {
          agentId: 'agent-1',
          backendType: 'process',
          runtimeSessionId: 'session-persisted',
        },
      })
    ).toMatchObject({
      alive: false,
      livenessKind: 'registered_only',
      runtimeSessionId: 'session-persisted',
      runtimeDiagnostic: 'registered runtime metadata without live process',
      runtimeDiagnosticSeverity: 'warning',
    });

    expect(
      projectRuntimeResource({
        source: 'persisted-runtime',
        pid: 5150,
        processAlive: false,
        usage: undefined,
      })
    ).toEqual({});
  });

  it('projects equivalent source-agnostic evidence consistently', () => {
    const processEvidence = {
      process: {
        pid: 777,
        metricsPid: 778,
        running: true,
        identityVerified: true,
        pidSource: 'agent_process_table' as const,
        command: 'codex --api-key fixture-value --team-name demo',
      },
      heartbeat: {
        runtimeSessionId: 'session-live',
      },
    };
    const resourceEvidence = {
      pid: 778,
      processAlive: true,
      usage: {
        cpuPercent: 12.5,
        rssBytes: 64_000,
        processCount: 2,
        runtimeLoadScope: 'process-tree' as const,
      },
    };

    expect(
      projectRuntimeLiveness({
        source: 'runtime-adapter',
        ...processEvidence,
      })
    ).toEqual(
      projectRuntimeLiveness({
        source: 'persisted-launch',
        ...processEvidence,
      })
    );
    expect(
      projectRuntimeResource({
        source: 'runtime-adapter',
        ...resourceEvidence,
      })
    ).toEqual(
      projectRuntimeResource({
        source: 'process-table',
        ...resourceEvidence,
      })
    );
    expect(projectRuntimeLiveness(processEvidence).processCommand).toBe(
      'codex --api-key [redacted] --team-name demo'
    );
  });

  it('keeps process-table identity matching behind a liveness evidence adapter', () => {
    const evidence = readVerifiedRuntimeProcessLivenessEvidence({
      rows: [
        {
          pid: 100,
          command: 'node runtime.js --team-name demo --agent-id older',
        },
        {
          pid: 200,
          command: 'node runtime.js --token fixture-token --team-name demo --agent-id worker@demo',
        },
      ],
      teamName: 'demo',
      agentId: 'worker@demo',
      runtimeSessionId: 'session-process',
      pidSource: 'agent_process_table',
    });

    expect(evidence).not.toBeNull();
    if (!evidence) {
      throw new Error('expected verified process evidence');
    }

    expect(evidence.diagnostics).toEqual(['matched process table by team-name and agent-id']);
    expect(evidence.evidence).toMatchObject({
      process: {
        pid: 200,
        running: true,
        identityVerified: true,
        pidSource: 'agent_process_table',
      },
      registration: {
        runtimeSessionId: 'session-process',
      },
    });
    expect(projectRuntimeLiveness(evidence.evidence)).toMatchObject({
      alive: true,
      livenessKind: 'runtime_process',
      pid: 200,
      pidSource: 'agent_process_table',
      processCommand: 'node runtime.js --token [redacted] --team-name demo --agent-id worker@demo',
      runtimeSessionId: 'session-process',
    });

    expect(
      readVerifiedRuntimeProcessLivenessEvidence({
        rows: [{ pid: 200, command: 'node runtime.js --team-name demo --agent-id worker@demo' }],
        teamName: 'demo',
        pidSource: 'agent_process_table',
      })
    ).toBeNull();
  });

  it('projects runtimePid-only resource usage and history', () => {
    expect(
      projectRuntimeResource({
        source: 'runtime-adapter',
        runtimePid: 6060,
        pidSource: 'runtime_bootstrap',
        processAlive: true,
        usage: {
          cpuPercent: 8.25,
          rssBytes: 128_000,
          primaryCpuPercent: 3.5,
          primaryRssBytes: 64_000,
          childCpuPercent: 4.75,
          childRssBytes: 64_000,
          processCount: 2,
          runtimeLoadScope: 'shared-host',
        },
        history: [
          {
            timestamp: '2026-01-01T00:04:00.000Z',
            runtimePid: 6060,
            pidSource: 'runtime_bootstrap',
            cpuPercent: 7,
            rssBytes: 120_000,
            runtimeLoadScope: 'shared-host',
          },
        ],
      })
    ).toEqual({
      cpuPercent: 8.25,
      rssBytes: 128_000,
      primaryCpuPercent: 3.5,
      primaryRssBytes: 64_000,
      childCpuPercent: 4.75,
      childRssBytes: 64_000,
      processCount: 2,
      runtimeLoadScope: 'shared-host',
      resourceHistory: [
        {
          timestamp: '2026-01-01T00:04:00.000Z',
          cpuPercent: 7,
          rssBytes: 120_000,
          runtimeLoadScope: 'shared-host',
          pidSource: 'runtime_bootstrap',
          runtimePid: 6060,
        },
      ],
    });
  });

  it('maps runtime projection output into the stable team runtime snapshot DTO shape', () => {
    const resourceFields = projectRuntimeSnapshotResourceFields({
      source: 'runtime-adapter',
      runtimePid: 7000,
      pidSource: 'opencode_bridge',
      usageStats: {
        rssBytes: 1000,
        cpuPercent: 0,
        processCount: 1,
        runtimeLoadScope: 'shared-host',
      },
      resourceHistory: [
        {
          timestamp: '2026-01-01T00:04:00.000Z',
          runtimePid: 7000,
          pidSource: 'opencode_bridge',
          rssBytes: 900,
          cpuPercent: 1,
          processCount: 1,
          runtimeLoadScope: 'shared-host',
        },
      ],
    });

    const member = mapRuntimeProjectionMemberEntry({
      memberName: 'worker',
      alive: true,
      restartable: false,
      backendType: 'process',
      providerId: 'opencode',
      runtimeModel: '  gpt-runtime  ',
      ...resourceFields,
      livenessKind: 'confirmed_bootstrap',
      pidSource: 'opencode_bridge',
      runtimePid: 7000,
      runtimeSessionId: 'session-1',
      runtimeDiagnostic: ' ready ',
      runtimeDiagnosticSeverity: 'info',
      diagnostics: ['ready'],
      updatedAt: '2026-01-01T00:05:00.000Z',
    });

    expect(member).toEqual({
      memberName: 'worker',
      alive: true,
      restartable: false,
      backendType: 'process',
      providerId: 'opencode',
      runtimeModel: 'gpt-runtime',
      rssBytes: 1000,
      cpuPercent: 0,
      processCount: 1,
      runtimeLoadScope: 'shared-host',
      resourceHistory: [
        {
          timestamp: '2026-01-01T00:04:00.000Z',
          rssBytes: 900,
          cpuPercent: 1,
          processCount: 1,
          runtimeLoadScope: 'shared-host',
          pidSource: 'opencode_bridge',
          runtimePid: 7000,
        },
      ],
      livenessKind: 'confirmed_bootstrap',
      pidSource: 'opencode_bridge',
      runtimePid: 7000,
      runtimeSessionId: 'session-1',
      runtimeDiagnostic: 'ready',
      runtimeDiagnosticSeverity: 'info',
      diagnostics: ['ready'],
      updatedAt: '2026-01-01T00:05:00.000Z',
    });
    expect(
      mapRuntimeProjectionMemberEntry({
        memberName: 'idle-worker',
        alive: false,
        restartable: true,
        pid: -1,
        runtimeModel: ' ',
        rssBytes: Number.NaN,
        cpuPercent: -0.1,
        processCount: 0,
        runtimeDiagnostic: ' ',
        updatedAt: '2026-01-01T00:05:00.000Z',
      })
    ).toEqual({
      memberName: 'idle-worker',
      alive: false,
      restartable: true,
      updatedAt: '2026-01-01T00:05:00.000Z',
    });

    expect(
      mapRuntimeProjectionSnapshot({
        teamName: 'alpha',
        updatedAt: '2026-01-01T00:05:00.000Z',
        runId: null,
        providerBackendId: 'opencode-cli',
        fastMode: 'on',
        members: { worker: member },
      })
    ).toEqual({
      teamName: 'alpha',
      updatedAt: '2026-01-01T00:05:00.000Z',
      runId: null,
      providerBackendId: 'opencode-cli',
      fastMode: 'on',
      members: { worker: member },
    });
    expect(
      mapRuntimeProjectionSnapshot({
        teamName: 'alpha',
        updatedAt: '2026-01-01T00:05:00.000Z',
        runId: null,
        members: {},
      })
    ).toEqual({
      teamName: 'alpha',
      updatedAt: '2026-01-01T00:05:00.000Z',
      runId: null,
      members: {},
    });
  });

  it('projects runtime snapshot liveness overrides from provider-agnostic bootstrap evidence', () => {
    const genericBootstrapProjection = projectRuntimeSnapshotMemberLivenessFields({
      liveAlive: false,
      liveLivenessKind: 'runtime_process_candidate',
      livePidSource: 'agent_process_table',
      liveRuntimeDiagnostic: 'candidate only',
      liveRuntimeDiagnosticSeverity: 'warning',
      confirmedRuntimeBootstrapAlive: true,
    });

    expect(genericBootstrapProjection).toEqual({
      alive: true,
      livenessKind: 'confirmed_bootstrap',
      pidSource: 'agent_process_table',
      runtimeDiagnostic: 'bootstrap confirmed; runtime host/session evidence present.',
      runtimeDiagnosticSeverity: 'info',
    });
    expect(genericBootstrapProjection.runtimeDiagnostic).not.toContain('OpenCode');

    expect(
      projectRuntimeSnapshotMemberLivenessFields({
        liveAlive: false,
        liveLivenessKind: 'runtime_process_candidate',
        livePidSource: 'agent_process_table',
        liveRuntimeDiagnostic: 'candidate only',
        liveRuntimeDiagnosticSeverity: 'warning',
        confirmedRuntimeBootstrapAlive: true,
        confirmedRuntimeBootstrapDiagnostic: 'provider bootstrap confirmed',
      })
    ).toEqual({
      alive: true,
      livenessKind: 'confirmed_bootstrap',
      pidSource: 'agent_process_table',
      runtimeDiagnostic: 'provider bootstrap confirmed',
      runtimeDiagnosticSeverity: 'info',
    });
    expect(
      projectRuntimeSnapshotMemberLivenessFields({
        liveAlive: true,
        liveLivenessKind: 'runtime_process',
        livePidSource: 'opencode_bridge',
        liveRuntimeDiagnostic: 'runtime process detected',
        liveRuntimeDiagnosticSeverity: 'info',
        confirmedRuntimeBootstrapAlive: true,
      })
    ).toEqual({
      alive: true,
      livenessKind: 'runtime_process',
      pidSource: 'opencode_bridge',
      runtimeDiagnostic: 'runtime process detected',
      runtimeDiagnosticSeverity: 'info',
    });
    expect(
      projectRuntimeSnapshotMemberLivenessFields({
        liveAlive: false,
        liveLivenessKind: 'registered_only',
        confirmedRuntimeBootstrapAlive: true,
        confirmedRuntimeBootstrapDiagnostic: 'runtime adapter confirmed bootstrap',
      })
    ).toEqual({
      alive: true,
      livenessKind: 'confirmed_bootstrap',
      pidSource: 'runtime_bootstrap',
      runtimeDiagnostic: 'runtime adapter confirmed bootstrap',
      runtimeDiagnosticSeverity: 'info',
    });

    expect(
      projectRuntimeSnapshotMemberLivenessFields({
        liveAlive: false,
        liveLivenessKind: 'registered_only',
        livePidSource: 'persisted_metadata',
        liveRuntimeDiagnosticSeverity: 'warning',
        spawnRuntimeDiagnostic: 'bootstrap transport warning',
        spawnRuntimeDiagnosticSeverity: 'warning',
        confirmedSpawnRuntimeFallback: true,
        keepConfirmedSpawnRuntimeDiagnostic: true,
      })
    ).toEqual({
      alive: true,
      livenessKind: 'confirmed_bootstrap',
      pidSource: 'runtime_bootstrap',
      runtimeDiagnostic: 'bootstrap transport warning',
      runtimeDiagnosticSeverity: 'warning',
    });

    expect(
      projectRuntimeSnapshotMemberLivenessFields({
        liveAlive: false,
        liveLivenessKind: 'registered_only',
        livePidSource: 'persisted_metadata',
        liveRuntimeDiagnostic: 'registered runtime metadata without live process',
        liveRuntimeDiagnosticSeverity: 'warning',
        confirmedRuntimeBootstrapAlive: true,
      })
    ).toEqual({
      alive: true,
      livenessKind: 'confirmed_bootstrap',
      pidSource: 'runtime_bootstrap',
      runtimeDiagnostic: 'bootstrap confirmed; runtime host/session evidence present.',
      runtimeDiagnosticSeverity: 'info',
    });

    expect(
      projectRuntimeSnapshotMemberLivenessFields({
        liveAlive: false,
        liveLivenessKind: 'not_found',
        confirmedRuntimeBootstrapAlive: true,
      })
    ).toEqual({
      alive: true,
      livenessKind: 'confirmed_bootstrap',
      pidSource: 'runtime_bootstrap',
      runtimeDiagnostic: 'bootstrap confirmed; runtime host/session evidence present.',
      runtimeDiagnosticSeverity: 'info',
    });
  });

  it('maps runtime snapshot bootstrap confirmation evidence across sources', () => {
    expect(
      hasRuntimeProjectionBootstrapConfirmationEvidence({
        bootstrapConfirmed: false,
        launchState: 'runtime_pending_bootstrap',
      })
    ).toBe(false);
    expect(
      hasRuntimeProjectionBootstrapConfirmationEvidence({
        launchState: 'confirmed_alive',
      })
    ).toBe(true);
    expect(
      hasRuntimeProjectionSnapshotBootstrapConfirmationEvidence({
        launch: { bootstrapConfirmed: false },
        runtimeAdapter: { bootstrapConfirmed: false },
        spawnStatus: { bootstrapConfirmed: true },
      })
    ).toBe(true);
  });

  it('redacts token-shaped diagnostic values before projecting details', () => {
    expect(
      projectRuntimeDiagnostics({
        message: 'provider failed with AUTH_TOKEN=fixture-value',
        severity: 'error',
        diagnostics: ['authorization: bearer fixture-value'],
      })
    ).toEqual({
      runtimeDiagnostic: 'provider failed with AUTH_TOKEN=[redacted]',
      runtimeDiagnosticSeverity: 'error',
      diagnostics: [
        'provider failed with AUTH_TOKEN=[redacted]',
        'authorization: bearer [redacted]',
      ],
    });
  });
});
