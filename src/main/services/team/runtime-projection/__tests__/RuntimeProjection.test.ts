import { describe, expect, it } from 'vitest';

import {
  projectRuntimeDiagnostics,
  projectRuntimeLiveness,
  projectRuntimeResource,
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
