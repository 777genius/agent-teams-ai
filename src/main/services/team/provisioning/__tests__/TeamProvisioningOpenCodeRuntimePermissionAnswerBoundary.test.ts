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

  it('normalizes a request prefix from another run before sending or persisting it', async () => {
    const answerRuntimeToolApproval = vi.fn(async () => undefined);

    await answerOpenCodeRuntimePermission(
      runtimePermissionPayload('opencode:run-previous:provider-request-1'),
      runtimePermissionPorts(answerRuntimeToolApproval)
    );

    expectNormalizedRequestIds(
      answerRuntimeToolApproval,
      'provider-request-1',
      'opencode:run-1:provider-request-1'
    );
  });

  it('removes repeated request prefixes without double-prefixing the persisted id', async () => {
    const answerRuntimeToolApproval = vi.fn(async () => undefined);

    await answerOpenCodeRuntimePermission(
      runtimePermissionPayload('opencode:run-previous:opencode:run-older:provider-request-1'),
      runtimePermissionPorts(answerRuntimeToolApproval)
    );

    expectNormalizedRequestIds(
      answerRuntimeToolApproval,
      'provider-request-1',
      'opencode:run-1:provider-request-1'
    );
  });

  it('keeps normalization idempotent when the normalized app id is processed again', async () => {
    const answerRuntimeToolApproval = vi.fn(async () => undefined);
    const ports = runtimePermissionPorts(answerRuntimeToolApproval);

    await answerOpenCodeRuntimePermission(
      runtimePermissionPayload('opencode:run-previous:provider-request-1'),
      ports
    );
    await answerOpenCodeRuntimePermission(
      runtimePermissionPayload('opencode:run-1:provider-request-1'),
      ports
    );

    expect(answerRuntimeToolApproval).toHaveBeenCalledTimes(2);
    expectNormalizedRequestIds(
      answerRuntimeToolApproval,
      'provider-request-1',
      'opencode:run-1:provider-request-1'
    );
  });

  it('preserves an already-bare provider request id', async () => {
    const answerRuntimeToolApproval = vi.fn(async () => undefined);

    await answerOpenCodeRuntimePermission(
      runtimePermissionPayload('provider-request-1'),
      runtimePermissionPorts(answerRuntimeToolApproval)
    );

    expectNormalizedRequestIds(
      answerRuntimeToolApproval,
      'provider-request-1',
      'opencode:run-1:provider-request-1'
    );
  });

  it.each([null, 42, {}, []])('rejects malformed request id value %j', async (requestId) => {
    const answerRuntimeToolApproval = vi.fn(async () => undefined);

    await expect(
      answerOpenCodeRuntimePermission(
        runtimePermissionPayload(requestId),
        runtimePermissionPorts(answerRuntimeToolApproval)
      )
    ).rejects.toThrow('OpenCode runtime payload missing requestId');
    expect(answerRuntimeToolApproval).not.toHaveBeenCalled();
  });

  it.each(['opencode:', 'opencode::provider-request-1', 'opencode:run-previous:'])(
    'rejects malformed request id prefix %j',
    async (requestId) => {
      const answerRuntimeToolApproval = vi.fn(async () => undefined);

      await expect(
        answerOpenCodeRuntimePermission(
          runtimePermissionPayload(requestId),
          runtimePermissionPorts(answerRuntimeToolApproval)
        )
      ).rejects.toThrow(/OpenCode runtime payload (malformed|missing) requestId/);
      expect(answerRuntimeToolApproval).not.toHaveBeenCalled();
    }
  );

  it.each(['', '   '])('rejects empty request id value %j', async (requestId) => {
    const answerRuntimeToolApproval = vi.fn(async () => undefined);

    await expect(
      answerOpenCodeRuntimePermission(
        runtimePermissionPayload(requestId),
        runtimePermissionPorts(answerRuntimeToolApproval)
      )
    ).rejects.toThrow('OpenCode runtime payload missing requestId');
    expect(answerRuntimeToolApproval).not.toHaveBeenCalled();
  });
});

function runtimePermissionPayload(requestId: unknown): Record<string, unknown> {
  return {
    teamName: 'Team',
    runId: 'run-1',
    laneId: 'lane-1',
    cwd: '/repo',
    memberName: 'Builder',
    requestId,
    decision: 'allow',
  };
}

function runtimePermissionPorts(answerRuntimeToolApproval: ReturnType<typeof vi.fn>) {
  return {
    answerRuntimeToolApproval,
    nowIso: () => '2026-01-01T00:00:00.000Z',
  };
}

function expectNormalizedRequestIds(
  answerRuntimeToolApproval: ReturnType<typeof vi.fn>,
  providerRequestId: string,
  appRequestId: string
): void {
  expect(answerRuntimeToolApproval).toHaveBeenLastCalledWith(
    expect.objectContaining({
      providerRequestId,
      approval: expect.objectContaining({
        requestId: appRequestId,
        toolInput: expect.objectContaining({ providerRequestId }),
        runtimePermission: expect.objectContaining({ providerRequestId }),
      }),
    }),
    expect.any(Boolean)
  );
}
