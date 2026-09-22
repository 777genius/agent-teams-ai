import { describe, expect, it, type Mock, vi } from 'vitest';

import {
  answerOpenCodeRuntimePermission,
  type TeamProvisioningOpenCodeRuntimePermissionAnswerBoundaryPorts,
} from '../TeamProvisioningOpenCodeRuntimePermissionAnswerBoundary';

type AnswerRuntimeToolApproval =
  TeamProvisioningOpenCodeRuntimePermissionAnswerBoundaryPorts['answerRuntimeToolApproval'];

describe('TeamProvisioningOpenCodeRuntimePermissionAnswerBoundary', () => {
  it('routes runtime-control permission answers through the existing runtime approval answer path', async () => {
    const answerRuntimeToolApproval = vi.fn<AnswerRuntimeToolApproval>(async () => undefined);

    await expect(
      answerOpenCodeRuntimePermission(
        {
          teamName: 'Team',
          runId: 'run-1',
          laneId: 'lane-1',
          cwd: '/repo',
          memberName: 'Builder',
          requestId: 'provider-request-1',
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

  it('does not reinterpret a normalized provider id that resembles an app request id', async () => {
    const answerRuntimeToolApproval = vi.fn<AnswerRuntimeToolApproval>(async () => undefined);

    await answerOpenCodeRuntimePermission(
      runtimePermissionPayload('opencode:run-1:provider-request-1'),
      runtimePermissionPorts(answerRuntimeToolApproval)
    );

    expectRequestIds(
      answerRuntimeToolApproval,
      'opencode:run-1:provider-request-1',
      'opencode:run-1:opencode:run-1:provider-request-1'
    );
  });

  it('preserves an opaque provider request id with a different run-like segment', async () => {
    const answerRuntimeToolApproval = vi.fn<AnswerRuntimeToolApproval>(async () => undefined);

    await answerOpenCodeRuntimePermission(
      runtimePermissionPayload('opencode:run-previous:provider-request-1'),
      runtimePermissionPorts(answerRuntimeToolApproval)
    );

    expectRequestIds(
      answerRuntimeToolApproval,
      'opencode:run-previous:provider-request-1',
      'opencode:run-1:opencode:run-previous:provider-request-1'
    );
  });

  it('preserves repeated app-like segments in an opaque provider request id', async () => {
    const answerRuntimeToolApproval = vi.fn<AnswerRuntimeToolApproval>(async () => undefined);

    await answerOpenCodeRuntimePermission(
      runtimePermissionPayload('opencode:run-1:opencode:run-1:provider-request-1'),
      runtimePermissionPorts(answerRuntimeToolApproval)
    );

    expectRequestIds(
      answerRuntimeToolApproval,
      'opencode:run-1:opencode:run-1:provider-request-1',
      'opencode:run-1:opencode:run-1:opencode:run-1:provider-request-1'
    );
  });

  it('preserves an already-bare provider request id', async () => {
    const answerRuntimeToolApproval = vi.fn<AnswerRuntimeToolApproval>(async () => undefined);

    await answerOpenCodeRuntimePermission(
      runtimePermissionPayload('provider-request-1'),
      runtimePermissionPorts(answerRuntimeToolApproval)
    );

    expectRequestIds(
      answerRuntimeToolApproval,
      'provider-request-1',
      'opencode:run-1:provider-request-1'
    );
  });

  it('preserves an opaque provider request id that starts with opencode', async () => {
    const answerRuntimeToolApproval = vi.fn<AnswerRuntimeToolApproval>(async () => undefined);

    await answerOpenCodeRuntimePermission(
      runtimePermissionPayload('opencode:foo'),
      runtimePermissionPorts(answerRuntimeToolApproval)
    );

    expectRequestIds(answerRuntimeToolApproval, 'opencode:foo', 'opencode:run-1:opencode:foo');
  });

  it.each([null, 42, {}, []])('rejects malformed request id value %j', async (requestId) => {
    const answerRuntimeToolApproval = vi.fn<AnswerRuntimeToolApproval>(async () => undefined);

    await expect(
      answerOpenCodeRuntimePermission(
        runtimePermissionPayload(requestId),
        runtimePermissionPorts(answerRuntimeToolApproval)
      )
    ).rejects.toThrow('OpenCode runtime payload missing requestId');
    expect(answerRuntimeToolApproval).not.toHaveBeenCalled();
  });

  it.each(['opencode:', 'opencode::provider-request-1', 'opencode:run-1:'])(
    'preserves non-empty opaque provider request id %j',
    async (requestId) => {
      const answerRuntimeToolApproval = vi.fn<AnswerRuntimeToolApproval>(async () => undefined);

      await answerOpenCodeRuntimePermission(
        runtimePermissionPayload(requestId),
        runtimePermissionPorts(answerRuntimeToolApproval)
      );

      expectRequestIds(answerRuntimeToolApproval, requestId, `opencode:run-1:${requestId}`);
    }
  );

  it.each(['', '   '])('rejects empty request id value %j', async (requestId) => {
    const answerRuntimeToolApproval = vi.fn<AnswerRuntimeToolApproval>(async () => undefined);

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

function runtimePermissionPorts(
  answerRuntimeToolApproval: Mock<AnswerRuntimeToolApproval>
): TeamProvisioningOpenCodeRuntimePermissionAnswerBoundaryPorts {
  return {
    answerRuntimeToolApproval,
    nowIso: () => '2026-01-01T00:00:00.000Z',
  };
}

function expectRequestIds(
  answerRuntimeToolApproval: Mock<AnswerRuntimeToolApproval>,
  providerRequestId: string,
  appRequestId: string
): void {
  const lastCall = answerRuntimeToolApproval.mock.lastCall;
  expect(lastCall).toBeDefined();
  if (!lastCall) {
    throw new Error('Expected answerRuntimeToolApproval to be called');
  }
  expect(lastCall[0]).toMatchObject({
    providerRequestId,
    approval: {
      requestId: appRequestId,
      toolInput: { providerRequestId },
      runtimePermission: { providerRequestId },
    },
  });
  expect(lastCall[1]).toEqual(expect.any(Boolean));
}
