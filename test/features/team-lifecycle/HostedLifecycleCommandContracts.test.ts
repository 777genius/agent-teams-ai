import {
  ExecuteHostedLifecycleCommand,
  GetHostedLifecycleControlState,
  type HostedLifecycleAuthorizationGeneration,
  type HostedLifecycleCommand,
  type HostedLifecycleCommandAuthorization,
  type HostedLifecycleCommandGatewayPort,
  type HostedLifecycleGrantId,
  parseHostedLifecycleCommand,
  parseHostedLifecycleCommandPublicResult,
  parseHostedLifecycleControlState,
  parseHostedLifecycleControlStateRequest,
} from '@features/team-lifecycle/main/hosted';
import {
  createQueryContext,
  parseBootId,
  parseRevision,
  parseRunId,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

const TEAM_ID = `team_${'a'.repeat(32)}`;
const WORKSPACE_ID = `workspace_${'b'.repeat(32)}`;
const BOOT_ID = parseBootId('boot_lifecycle-command-contract');
const DEPLOYMENT_ID = context().deploymentId;
const RUN_ID = parseRunId(`run_${'c'.repeat(32)}`);
const COMMAND_ID = 'lifecycle-command_command-0001';
const IDEMPOTENCY_KEY = 'idempotency_key-0001';
const BEFORE_REVISION = parseRevision('revision_before');
const AFTER_REVISION = parseRevision('revision_after');

function body(action: HostedLifecycleCommand['action'] = 'launch'): Record<string, unknown> {
  return {
    schemaVersion: 1,
    commandId: COMMAND_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    workspaceId: WORKSPACE_ID,
    teamId: TEAM_ID,
    expectedRevision: BEFORE_REVISION,
    ...(action === 'launch' ? {} : { runId: RUN_ID }),
  };
}

function command(action: HostedLifecycleCommand['action'] = 'launch'): HostedLifecycleCommand {
  const parsed = parseHostedLifecycleCommand(action, body(action));
  if (!parsed.ok) throw new Error('hosted-lifecycle-command-fixture-invalid');
  return parsed.value;
}

function context() {
  return createQueryContext({
    actorId: 'actor_lifecycle-command-contract',
    sessionId: 'session_lifecycle-command-contract',
    deploymentId: 'deployment_lifecycle-command-contract',
    bootId: BOOT_ID,
    requestId: 'request_lifecycle-command-contract',
    authorizedScope: 'scope_lifecycle-command-contract',
    deadlineAtMs: 10_000,
    signal: new AbortController().signal,
  });
}

function authorization(
  resourceRevision = BEFORE_REVISION,
  overrides: Partial<HostedLifecycleCommandAuthorization> = {}
): HostedLifecycleCommandAuthorization {
  return Object.freeze({
    grantId: 'grant_lifecycle-command-0001' as HostedLifecycleGrantId,
    authorizationGeneration:
      'authorization-generation_lifecycle-command-0001' as HostedLifecycleAuthorizationGeneration,
    deploymentId: DEPLOYMENT_ID,
    bootId: BOOT_ID,
    resourceRevision,
    actorId: context().actorId,
    workspaceId: command().workspaceId,
    teamId: command().teamId,
    restoreGeneration: 7,
    mountGeneration: 3,
    ownerEffectFence: Object.freeze({
      grantRevision: 'cd'.repeat(32),
      identityChecksum: 'ef'.repeat(32),
    }),
    ...overrides,
  });
}

function receipt(
  target: HostedLifecycleCommand,
  resourceRevision: ReturnType<typeof parseRevision>,
  kind: 'accepted' | 'idempotent_replay' = 'accepted'
) {
  return Object.freeze({
    schemaVersion: 1 as const,
    kind,
    action: target.action,
    commandId: target.commandId,
    workspaceId: target.workspaceId,
    teamId: target.teamId,
    runId: RUN_ID,
    resourceRevision,
  });
}

describe('hosted lifecycle command contracts', () => {
  it('strictly parses control-state requests and deployment/boot fenced authority responses', async () => {
    const target = command();
    const request = {
      schemaVersion: 1 as const,
      workspaceId: target.workspaceId,
      teamId: target.teamId,
    };
    const state = Object.freeze({
      schemaVersion: 1 as const,
      kind: 'control_state' as const,
      workspaceId: target.workspaceId,
      teamId: target.teamId,
      deploymentId: DEPLOYMENT_ID,
      bootId: BOOT_ID,
      runId: RUN_ID,
      resourceRevision: BEFORE_REVISION,
      availableActions: Object.freeze(['stop', 'recover'] as const),
    });
    expect(parseHostedLifecycleControlStateRequest(request)).toMatchObject({ ok: true });
    expect(parseHostedLifecycleControlStateRequest({ ...request, runId: RUN_ID })).toEqual({
      ok: false,
    });
    expect(
      parseHostedLifecycleControlState(state, {
        ...request,
        deploymentId: DEPLOYMENT_ID,
        bootId: BOOT_ID,
      })
    ).toMatchObject({ ok: true });
    expect(
      parseHostedLifecycleControlState(
        { ...state, deploymentId: 'deployment_lifecycle-command-other' },
        {
          ...request,
          deploymentId: DEPLOYMENT_ID,
          bootId: BOOT_ID,
        }
      )
    ).toEqual({ ok: false });

    const gateway = {
      getControlState: vi.fn(async () => state),
      authorize: vi.fn(),
      revalidate: vi.fn(),
      execute: vi.fn(),
    } satisfies HostedLifecycleCommandGatewayPort;
    await expect(
      new GetHostedLifecycleControlState(gateway, () => 1).execute(request, context())
    ).resolves.toEqual(state);
  });

  it('accepts only the opaque browser command and public-result DTO shapes', () => {
    const parsed = parseHostedLifecycleCommand('launch', body());
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({ ...body(), action: 'launch' });
    expect(Object.keys(parsed.value)).toEqual([
      'schemaVersion',
      'action',
      'commandId',
      'idempotencyKey',
      'workspaceId',
      'teamId',
      'expectedRevision',
    ]);

    expect(
      parseHostedLifecycleCommand('launch', {
        ...body(),
        grantId: 'grant_lifecycle-command-0001',
      })
    ).toEqual({ ok: false });
    expect(parseHostedLifecycleCommand('launch', { ...body(), runId: RUN_ID })).toEqual({
      ok: false,
    });
    expect(parseHostedLifecycleCommand('stop', body('stop'))).toMatchObject({ ok: true });

    expect(
      parseHostedLifecycleCommandPublicResult({
        ...receipt(command(), BEFORE_REVISION),
        authorizationGeneration: 'authorization-generation_lifecycle-command-0001',
      })
    ).toEqual({ ok: false });
    for (const kind of ['started', 'operator_required'] as const) {
      expect(
        parseHostedLifecycleCommandPublicResult({
          schemaVersion: 1,
          kind,
          action: 'launch',
          commandId: COMMAND_ID,
          workspaceId: WORKSPACE_ID,
          teamId: TEAM_ID,
        })
      ).toMatchObject({ ok: true, value: { kind } });
    }
  });

  it('revalidates an accepted command before and after the external atomic commit', async () => {
    const target = command();
    const before = authorization();
    const after = authorization(AFTER_REVISION);
    const gateway = {
      getControlState: vi.fn(),
      authorize: vi.fn(async () => ({ kind: 'authorized' as const, authorization: before })),
      revalidate: vi.fn(async (_command, snapshot: HostedLifecycleCommandAuthorization) => ({
        kind: 'valid' as const,
        authorization: snapshot,
      })),
      execute: vi.fn(async () => ({
        kind: 'result' as const,
        authorization: after,
        result: receipt(target, AFTER_REVISION),
      })),
    } satisfies HostedLifecycleCommandGatewayPort;

    const result = await new ExecuteHostedLifecycleCommand(gateway, () => 1).execute(
      'launch',
      body(),
      context()
    );

    expect(result).toEqual(receipt(target, AFTER_REVISION));
    expect(gateway.authorize).toHaveBeenCalledOnce();
    expect(gateway.revalidate).toHaveBeenCalledTimes(2);
    expect(gateway.execute).toHaveBeenCalledWith(target, before, expect.any(Object));
  });

  it.each([
    ['grantId', 'grant_lifecycle-command-0002'],
    ['authorizationGeneration', 'authorization-generation_lifecycle-command-0002'],
    ['deploymentId', context().deploymentId.replace('contract', 'other')],
    ['bootId', parseBootId('boot_lifecycle-command-other')],
    ['mountGeneration', 4],
    ['resourceRevision', parseRevision('revision_after-other')],
    [
      'ownerEffectFence',
      Object.freeze({ grantRevision: 'ab'.repeat(32), identityChecksum: 'ef'.repeat(32) }),
    ],
    [
      'ownerEffectFence',
      Object.freeze({ grantRevision: 'cd'.repeat(32), identityChecksum: 'ab'.repeat(32) }),
    ],
  ] as const)('fails closed when post-async %s revalidation changes', async (field, value) => {
    const target = command();
    const before = authorization();
    const committed = authorization(AFTER_REVISION);
    const changed = authorization(AFTER_REVISION, { [field]: value } as never);
    const gateway = {
      getControlState: vi.fn(),
      authorize: vi.fn(async () => ({ kind: 'authorized' as const, authorization: before })),
      revalidate: vi
        .fn()
        .mockResolvedValueOnce({ kind: 'valid' as const, authorization: before })
        .mockResolvedValueOnce({ kind: 'valid' as const, authorization: changed }),
      execute: vi.fn(async () => ({
        kind: 'result' as const,
        authorization: committed,
        result: receipt(target, AFTER_REVISION),
      })),
    } satisfies HostedLifecycleCommandGatewayPort;

    await expect(
      new ExecuteHostedLifecycleCommand(gateway, () => 1).execute('launch', body(), context())
    ).resolves.toMatchObject({ kind: 'conflict', reason: 'authorization_changed' });
  });

  it('preserves idempotent replay, returns orchestrator conflicts, and rejects malformed output', async () => {
    const target = command();
    const before = authorization();
    const replayGateway = {
      getControlState: vi.fn(),
      authorize: vi.fn(async () => ({ kind: 'authorized' as const, authorization: before })),
      revalidate: vi.fn(async (_command, snapshot: HostedLifecycleCommandAuthorization) => ({
        kind: 'valid' as const,
        authorization: snapshot,
      })),
      execute: vi.fn(async () => ({
        kind: 'result' as const,
        authorization: before,
        result: receipt(target, BEFORE_REVISION, 'idempotent_replay'),
      })),
    } satisfies HostedLifecycleCommandGatewayPort;
    await expect(
      new ExecuteHostedLifecycleCommand(replayGateway, () => 1).execute('launch', body(), context())
    ).resolves.toMatchObject({ kind: 'idempotent_replay' });

    const conflictGateway = {
      getControlState: vi.fn(),
      authorize: vi.fn(async () => ({
        kind: 'conflict' as const,
        reason: 'idempotency_mismatch' as const,
        currentRevision: BEFORE_REVISION,
      })),
      revalidate: vi.fn(),
      execute: vi.fn(),
    } satisfies HostedLifecycleCommandGatewayPort;
    await expect(
      new ExecuteHostedLifecycleCommand(conflictGateway, () => 1).execute(
        'launch',
        body(),
        context()
      )
    ).resolves.toMatchObject({ kind: 'conflict', reason: 'idempotency_mismatch' });
    expect(conflictGateway.execute).not.toHaveBeenCalled();

    const malformedGateway = {
      getControlState: vi.fn(),
      authorize: vi.fn(async () => ({ kind: 'authorized' as const, authorization: before })),
      revalidate: vi.fn(async (_command, snapshot: HostedLifecycleCommandAuthorization) => ({
        kind: 'valid' as const,
        authorization: snapshot,
      })),
      execute: vi.fn(async () => ({
        kind: 'result' as const,
        authorization: before,
        result: { ...receipt(target, BEFORE_REVISION), privateGrant: 'not-public' },
      })),
    } satisfies HostedLifecycleCommandGatewayPort;
    await expect(
      new ExecuteHostedLifecycleCommand(malformedGateway, () => 1).execute(
        'launch',
        body(),
        context()
      )
    ).resolves.toEqual({ schemaVersion: 1, kind: 'unavailable', retryAfterMs: null });
  });

  it.each(['started', 'operator_required'] as const)(
    'preserves the durable %s outcome instead of collapsing ambiguity to unavailable',
    async (kind) => {
      const before = authorization();
      let now = 1;
      const gateway = {
        getControlState: vi.fn(),
        authorize: vi.fn(async () => ({ kind: 'authorized' as const, authorization: before })),
        revalidate: vi.fn(async (_command, snapshot: HostedLifecycleCommandAuthorization) => ({
          kind: 'valid' as const,
          authorization: snapshot,
        })),
        execute: vi.fn(async () => {
          // Simulate the external owner finishing ambiguity classification exactly as the caller's
          // deadline closes. This durable state must not be downgraded to retryable unavailability.
          now = context().deadlineAtMs;
          return { kind };
        }),
      } satisfies HostedLifecycleCommandGatewayPort;

      await expect(
        new ExecuteHostedLifecycleCommand(gateway, () => now).execute('launch', body(), context())
      ).resolves.toEqual({
        schemaVersion: 1,
        kind,
        action: 'launch',
        commandId: COMMAND_ID,
        workspaceId: WORKSPACE_ID,
        teamId: TEAM_ID,
      });
      expect(gateway.revalidate).toHaveBeenCalledOnce();
    }
  );

  it.each(['authorize', 'revalidate'] as const)(
    'preserves authoritative operator_required from %s even when its response closes the deadline',
    async (phase) => {
      const before = authorization();
      const requestContext = context();
      let now = 1;
      const gateway = {
        getControlState: vi.fn(),
        authorize: vi.fn(async () => {
          if (phase === 'authorize') {
            now = requestContext.deadlineAtMs;
            return { kind: 'operator_required' as const };
          }
          return { kind: 'authorized' as const, authorization: before };
        }),
        revalidate: vi.fn(async () => {
          now = requestContext.deadlineAtMs;
          return { kind: 'operator_required' as const };
        }),
        execute: vi.fn(),
      } satisfies HostedLifecycleCommandGatewayPort;

      await expect(
        new ExecuteHostedLifecycleCommand(gateway, () => now).execute(
          'launch',
          body(),
          requestContext
        )
      ).resolves.toEqual({
        schemaVersion: 1,
        kind: 'operator_required',
        action: 'launch',
        commandId: COMMAND_ID,
        workspaceId: WORKSPACE_ID,
        teamId: TEAM_ID,
      });
      expect(gateway.execute).not.toHaveBeenCalled();
      expect(gateway.revalidate).toHaveBeenCalledTimes(phase === 'revalidate' ? 1 : 0);
    }
  );
});
