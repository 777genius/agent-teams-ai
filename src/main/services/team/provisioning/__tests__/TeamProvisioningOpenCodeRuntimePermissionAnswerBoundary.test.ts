import { describe, expect, it, vi } from 'vitest';

import { answerOpenCodeRuntimePermission } from '../TeamProvisioningOpenCodeRuntimePermissionAnswerBoundary';

describe('TeamProvisioningOpenCodeRuntimePermissionAnswerBoundary', () => {
  it('routes runtime-control permission answers through the existing runtime approval answer path', async () => {
    const answerRuntimeToolApproval = vi.fn(async () => undefined);

    await expect(
      answerOpenCodeRuntimePermission(
        {
          teamName: 'Team',
          runId: 'run-1',
          laneId: 'lane-1',
          cwd: '/repo',
          memberName: 'Builder',
          requestId: 'opencode:run-1:provider-request-1',
          decision: 'reject',
          expectedMembers: [
            {
              name: ' Builder ',
              role: ' Build ',
              providerId: 'opencode',
              cwd: ' /repo ',
            },
          ],
          runtimeSessionId: 'session-1',
          toolName: 'Bash',
          toolInput: { command: 'pnpm test' },
        },
        {
          answerRuntimeToolApproval,
          nowIso: () => '2026-01-01T00:00:00.000Z',
        }
      )
    ).resolves.toEqual({
      ok: true,
      providerId: 'opencode',
      teamName: 'Team',
      runId: 'run-1',
      state: 'accepted',
      memberName: 'Builder',
      diagnostics: [],
      observedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(answerRuntimeToolApproval).toHaveBeenCalledWith(
      {
        providerId: 'opencode',
        providerRequestId: 'provider-request-1',
        laneId: 'lane-1',
        memberName: 'Builder',
        cwd: '/repo',
        expectedMembers: [
          {
            name: 'Builder',
            role: 'Build',
            providerId: 'opencode',
            cwd: '/repo',
          },
        ],
        approval: {
          requestId: 'opencode:run-1:provider-request-1',
          runId: 'run-1',
          teamName: 'Team',
          providerId: 'opencode',
          source: 'Builder',
          toolName: 'Bash',
          toolInput: {
            provider: 'opencode',
            providerRequestId: 'provider-request-1',
            command: 'pnpm test',
          },
          receivedAt: '2026-01-01T00:00:00.000Z',
          runtimePermission: {
            providerId: 'opencode',
            laneId: 'lane-1',
            memberName: 'Builder',
            providerRequestId: 'provider-request-1',
            sessionId: 'session-1',
          },
        },
      },
      false
    );
  });
});
