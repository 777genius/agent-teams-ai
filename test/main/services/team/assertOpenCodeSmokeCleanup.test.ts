// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { OpenCodeReadinessBridge } from '../../../../src/main/services/team/opencode/bridge/OpenCodeReadinessBridge';

import { assertOpenCodeSmokeCleanup } from './assertOpenCodeSmokeCleanup';

import type { OpenCodeCleanupHostsCommandData } from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';

const project = '/owned/project';
const result = (): OpenCodeCleanupHostsCommandData => ({
  cleaned: 0,
  remaining: 0,
  hosts: [],
  diagnostics: [],
});

describe('owned smoke cleanup evidence', () => {
  it('rejects the readiness bridge fallback even when remaining is zero', async () => {
    const adapter = new OpenCodeReadinessBridge({
      execute: async () => ({
        ok: false,
        schemaVersion: 1,
        requestId: 'mock',
        command: 'opencode.cleanupHosts',
        completedAt: '',
        durationMs: 0,
        error: { kind: 'timeout', message: 'mock timeout', retryable: false },
        diagnostics: [],
      }),
    });
    const awaited = await adapter.cleanupOpenCodeHosts({
      reason: 'test',
      projectPath: project,
      mode: 'force',
    });
    expect(awaited.remaining).toBe(0);
    expect(() => assertOpenCodeSmokeCleanup(awaited, project)).toThrow(/not confirmed/);
  });
  it('rejects remaining hosts and failed/kept owned-host actions', () => {
    expect(() => assertOpenCodeSmokeCleanup({ ...result(), remaining: 1 }, project)).toThrow();
    for (const action of [
      'failed',
      'kept_active',
      'kept_leased',
      'kept_recent',
      'kept_filtered',
    ] as const) {
      expect(() =>
        assertOpenCodeSmokeCleanup(
          {
            ...result(),
            hosts: [
              {
                hostKey: 'owned',
                projectPath: project,
                pid: 123,
                port: 42,
                action,
                reason: '',
                leaseCount: 0,
              },
            ],
          },
          project
        )
      ).toThrow();
    }
  });
  it('accepts positive stopped evidence and leaves filtered unrelated hosts alone', () => {
    assertOpenCodeSmokeCleanup(result(), project);
    for (const action of ['disposed', 'removed_dead'] as const) {
      assertOpenCodeSmokeCleanup(
        {
          ...result(),
          hosts: [
            {
              hostKey: 'owned',
              projectPath: project,
              pid: 123,
              port: 42,
              action,
              reason: '',
              leaseCount: 0,
            },
          ],
        },
        project
      );
    }
    assertOpenCodeSmokeCleanup(
      {
        ...result(),
        hosts: [
          {
            hostKey: 'other',
            projectPath: '/other',
            pid: 123,
            port: 42,
            action: 'kept_filtered',
            reason: '',
            leaseCount: 0,
          },
        ],
      },
      project
    );
  });
});
