import { describe, expect, it, vi } from 'vitest';

import {
  type GetTeamLifecycleSnapshotRequest,
  parseCanonicalListTeamLifecycleResult,
  parseGetRuntimeStateProjectionResult,
  parseGetTeamLifecycleSnapshotRequest,
  parseGetTeamLifecycleSnapshotResult,
  parseListAliveTeamProjectionsResult,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
} from '../../../src/features/team-lifecycle/contracts/team-lifecycle-read';
import { GetRuntimeStateProjection } from '../../../src/features/team-lifecycle/core/application/GetRuntimeStateProjection';
import { GetTeamLifecycleSnapshot } from '../../../src/features/team-lifecycle/core/application/GetTeamLifecycleSnapshot';
import { ListAliveTeamProjections } from '../../../src/features/team-lifecycle/core/application/ListAliveTeamProjections';
import { ListTeamLifecycle } from '../../../src/features/team-lifecycle/core/application/ListTeamLifecycle';
import { TeamLifecycleReadApiAdapter } from '../../../src/features/team-lifecycle/main/adapters/input/TeamLifecycleReadApiAdapter';
import {
  type LegacyTeamIdentityBinding,
  LegacyTeamLifecycleReadSource,
  type LegacyTeamLifecycleReadSourceDependencies,
  type LegacyTeamReadAvailability,
} from '../../../src/features/team-lifecycle/main/infrastructure/LegacyTeamLifecycleReadSource';
import {
  createQueryContext,
  parseRevision,
  parseTeamId,
  parseWorkspaceId,
  type QueryContext,
} from '../../../src/shared/contracts/hosted';
import { findSensitivePayloads } from '../../architecture/hosted-web/phase-1/conformance/semantic-harness';

const WORKSPACE_A = parseWorkspaceId(`workspace_${'1'.repeat(32)}`);
const WORKSPACE_B = parseWorkspaceId(`workspace_${'2'.repeat(32)}`);
const TEAM_A = parseTeamId(`team_${'a'.repeat(32)}`);
const TEAM_B = parseTeamId(`team_${'b'.repeat(32)}`);
const REVISION_LIST = parseRevision('revision_canonical_list');
const REVISION_A = parseRevision('revision_canonical_a');
const REVISION_B = parseRevision('revision_canonical_b');
const FIXED_NOW_MS = 1_704_067_200_000;

function context(
  options: {
    readonly authorizedScope?: string;
    readonly deadlineAtMs?: number;
    readonly signal?: AbortSignal;
  } = {}
): QueryContext {
  return createQueryContext({
    actorId: 'actor_canonical_reader',
    sessionId: 'session_canonical_reader',
    deploymentId: 'deployment_canonical_reader',
    bootId: 'boot_canonical_reader',
    requestId: 'request_canonical_reader',
    authorizedScope: options.authorizedScope ?? 'scope_canonical_team_read',
    deadlineAtMs: options.deadlineAtMs ?? FIXED_NOW_MS + 30_000,
    signal: options.signal ?? new AbortController().signal,
  });
}

function listRequest(expectedRevision: string | null = null): {
  readonly schemaVersion: 1;
  readonly cursor: null;
  readonly expectedRevision: ReturnType<typeof parseRevision> | null;
} {
  return {
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    cursor: null,
    expectedRevision: expectedRevision === null ? null : parseRevision(expectedRevision),
  };
}

function entityRequest(
  teamId = TEAM_A,
  workspaceId = WORKSPACE_A,
  expectedRevision: string | null = null
): GetTeamLifecycleSnapshotRequest {
  return {
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    workspaceId,
    teamId,
    expectedRevision: expectedRevision === null ? null : parseRevision(expectedRevision),
  };
}

function binding(
  options: {
    readonly teamId?: typeof TEAM_A | typeof TEAM_B;
    readonly workspaceId?: typeof WORKSPACE_A | typeof WORKSPACE_B;
    readonly legacyTeamName?: string;
    readonly displayName?: string;
    readonly revision?: typeof REVISION_A | typeof REVISION_B;
    readonly availability?: LegacyTeamReadAvailability;
  } = {}
): LegacyTeamIdentityBinding {
  return {
    workspaceId: options.workspaceId ?? WORKSPACE_A,
    teamId: options.teamId ?? TEAM_A,
    legacyTeamName: options.legacyTeamName ?? 'legacy-alpha',
    displayName: options.displayName ?? 'Alpha',
    revision: options.revision ?? REVISION_A,
    ...(options.availability === undefined ? {} : { availability: options.availability }),
  };
}

function dependencies(
  options: { readonly availability?: LegacyTeamReadAvailability } = {}
): LegacyTeamLifecycleReadSourceDependencies {
  const bindings = [
    binding({
      teamId: TEAM_B,
      workspaceId: WORKSPACE_B,
      legacyTeamName: 'legacy-beta',
      displayName: 'Beta',
      revision: REVISION_B,
    }),
    binding({ availability: options.availability }),
  ];
  return {
    identities: {
      listTeamBindings: () => ({
        snapshotRevision: REVISION_LIST,
        bindings,
        nextCursor: null,
      }),
      getTeamBinding: (request) =>
        bindings.find(
          (candidate) =>
            candidate.teamId === request.teamId && candidate.workspaceId === request.workspaceId
        ) ?? null,
      listAliveTeamBindings: () => ({
        snapshotRevision: REVISION_LIST,
        bindings: [bindings[0], bindings[1]],
        nextCursor: null,
      }),
    },
    data: {
      listTeams: () => [
        {
          teamName: 'legacy-alpha',
          displayName: 'Alpha',
          projectPath: 'private-value-that-must-not-escape',
        },
        {
          teamName: 'legacy-beta',
          displayName: 'Beta',
          projectPath: 'another-private-value',
          partialLaunchFailure: true,
        },
      ],
      getTeamData: (legacyTeamName) => ({
        teamName: legacyTeamName,
        config: {
          name: legacyTeamName,
          projectPath: 'private-value-that-must-not-escape',
        },
        warnings: [],
        isAlive: true,
      }),
    },
    runtime: {
      getRuntimeState: (legacyTeamName) => ({
        teamName: legacyTeamName,
        isAlive: true,
        runId: 'legacy-run-value-that-must-not-escape',
      }),
      getAliveTeams: () => ['legacy-alpha', 'legacy-beta'],
    },
    policy: {
      isAuthorized: () => true,
      nowMs: () => FIXED_NOW_MS,
    },
  };
}

function apiFor(source: LegacyTeamLifecycleReadSource): TeamLifecycleReadApiAdapter {
  return new TeamLifecycleReadApiAdapter({
    list: new ListTeamLifecycle(source),
    snapshot: new GetTeamLifecycleSnapshot(source),
    runtime: new GetRuntimeStateProjection(source),
    alive: new ListAliveTeamProjections(source),
  });
}

describe('TeamLifecycleReadApi', () => {
  it('returns deterministic canonical list, snapshot, runtime, and alive projections', async () => {
    const api = apiFor(new LegacyTeamLifecycleReadSource(dependencies()));

    const list = await api.listTeamLifecycle(listRequest(), context());
    const snapshot = await api.getTeamLifecycleSnapshot(entityRequest(), context());
    const runtime = await api.getRuntimeStateProjection(entityRequest(), context());
    const alive = await api.listAliveTeamProjections(listRequest(), context());

    expect(list.kind).toBe('success');
    if (list.kind === 'success') {
      expect(list.items.map((item) => item.teamId)).toEqual([TEAM_A, TEAM_B]);
      expect(list.items.map((item) => item.workspaceId)).toEqual([WORKSPACE_A, WORKSPACE_B]);
      expect(list.items.map((item) => item.lifecycle)).toEqual(['ready', 'degraded']);
    }
    expect(snapshot).toMatchObject({
      kind: 'success',
      snapshot: {
        workspaceId: WORKSPACE_A,
        teamId: TEAM_A,
        displayName: 'Alpha',
        lifecycle: 'running',
      },
    });
    expect(runtime).toMatchObject({
      kind: 'success',
      projection: { workspaceId: WORKSPACE_A, teamId: TEAM_A, isAlive: true },
    });
    expect(alive).toMatchObject({
      kind: 'success',
      items: [
        { workspaceId: WORKSPACE_A, teamId: TEAM_A, isAlive: true },
        { workspaceId: WORKSPACE_B, teamId: TEAM_B, isAlive: true },
      ],
    });

    for (const result of [list, snapshot, runtime, alive]) {
      expect(findSensitivePayloads(result)).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('legacy-alpha');
      expect(JSON.stringify(result)).not.toContain('private-value');
      expect(JSON.stringify(result)).not.toContain('legacy-run-value');
    }
  });

  it('validates every input before invoking a use case', async () => {
    const execute = vi.fn();
    const api = new TeamLifecycleReadApiAdapter({
      list: { execute },
      snapshot: { execute },
      runtime: { execute },
      alive: { execute },
    });

    const invalidEntity = {
      ...entityRequest(),
      teamId: 'team_alpha',
      injected: true,
    };
    const invalidList = { ...listRequest(), schemaVersion: 2 };

    await expect(
      api.getTeamLifecycleSnapshot(invalidEntity as never, context())
    ).resolves.toMatchObject({ kind: 'failure', error: { code: 'invalid_request' } });
    await expect(
      api.getRuntimeStateProjection(invalidEntity as never, context())
    ).resolves.toMatchObject({ kind: 'failure', error: { code: 'invalid_request' } });
    await expect(api.listTeamLifecycle(invalidList as never, context())).resolves.toMatchObject({
      kind: 'failure',
      error: { code: 'unsupported', reason: 'schema_version_unsupported' },
    });
    await expect(
      api.listAliveTeamProjections(invalidList as never, context())
    ).resolves.toMatchObject({ kind: 'failure', error: { code: 'unsupported' } });
    expect(execute).not.toHaveBeenCalled();

    execute.mockRejectedValueOnce(new Error('private application failure'));
    const normalized = await api.listTeamLifecycle(listRequest(), context());
    expect(normalized).toMatchObject({
      kind: 'failure',
      error: { code: 'internal', reason: 'unexpected' },
    });
    expect(JSON.stringify(normalized)).not.toContain('private application failure');
  });

  it('runs admission before each legacy read and propagates the exact QueryContext object', async () => {
    const calls: string[] = [];
    const exactContext = context();
    const ports = dependencies();
    const originalListBindings = ports.identities.listTeamBindings;
    const originalGetBinding = ports.identities.getTeamBinding;
    const originalListAliveBindings = ports.identities.listAliveTeamBindings;
    const originalListTeams = ports.data.listTeams;
    const originalGetTeamData = ports.data.getTeamData;
    const originalGetRuntimeState = ports.runtime.getRuntimeState;
    const originalGetAliveTeams = ports.runtime.getAliveTeams;

    ports.policy.isAuthorized = (receivedContext) => {
      expect(receivedContext).toBe(exactContext);
      calls.push('authorize');
      return true;
    };
    ports.policy.nowMs = () => {
      calls.push('deadline');
      return FIXED_NOW_MS;
    };
    ports.identities.listTeamBindings = (request, receivedContext) => {
      expect(receivedContext).toBe(exactContext);
      calls.push('identity:list');
      return originalListBindings(request, receivedContext);
    };
    ports.identities.getTeamBinding = (request, receivedContext) => {
      expect(receivedContext).toBe(exactContext);
      calls.push('identity:get');
      return originalGetBinding(request, receivedContext);
    };
    ports.identities.listAliveTeamBindings = (names, request, receivedContext) => {
      expect(receivedContext).toBe(exactContext);
      calls.push('identity:alive');
      return originalListAliveBindings(names, request, receivedContext);
    };
    ports.data.listTeams = (receivedContext) => {
      expect(receivedContext).toBe(exactContext);
      calls.push('data:list');
      return originalListTeams(receivedContext);
    };
    ports.data.getTeamData = (teamName, receivedContext) => {
      expect(receivedContext).toBe(exactContext);
      calls.push('data:get');
      return originalGetTeamData(teamName, receivedContext);
    };
    ports.runtime.getRuntimeState = (teamName, receivedContext) => {
      expect(receivedContext).toBe(exactContext);
      calls.push('runtime:get');
      return originalGetRuntimeState(teamName, receivedContext);
    };
    ports.runtime.getAliveTeams = (receivedContext) => {
      expect(receivedContext).toBe(exactContext);
      calls.push('runtime:alive');
      return originalGetAliveTeams(receivedContext);
    };

    const api = apiFor(new LegacyTeamLifecycleReadSource(ports));
    await api.listTeamLifecycle(listRequest(), exactContext);
    expect(calls.splice(0)).toEqual([
      'authorize',
      'deadline',
      'identity:list',
      'authorize',
      'deadline',
      'data:list',
    ]);

    await api.getTeamLifecycleSnapshot(entityRequest(), exactContext);
    expect(calls.splice(0)).toEqual([
      'authorize',
      'deadline',
      'identity:get',
      'authorize',
      'deadline',
      'data:get',
    ]);

    await api.getRuntimeStateProjection(entityRequest(), exactContext);
    expect(calls.splice(0)).toEqual([
      'authorize',
      'deadline',
      'identity:get',
      'authorize',
      'deadline',
      'runtime:get',
    ]);

    await api.listAliveTeamProjections(listRequest(), exactContext);
    expect(calls.splice(0)).toEqual([
      'authorize',
      'deadline',
      'runtime:alive',
      'authorize',
      'deadline',
      'identity:alive',
    ]);
  });

  it('rejects unauthorized, cancelled, and expired contexts before any legacy I/O', async () => {
    const ports = dependencies();
    const io = vi.fn(() => {
      throw new Error('legacy I/O must not run');
    });
    ports.identities.listTeamBindings = io;
    ports.identities.getTeamBinding = io;
    ports.identities.listAliveTeamBindings = io;
    ports.data.listTeams = io;
    ports.data.getTeamData = io;
    ports.runtime.getRuntimeState = io;
    ports.runtime.getAliveTeams = io;

    const api = apiFor(new LegacyTeamLifecycleReadSource(ports));
    const invokeAll = async (queryContext: QueryContext) =>
      Promise.all([
        api.listTeamLifecycle(listRequest(), queryContext),
        api.getTeamLifecycleSnapshot(entityRequest(), queryContext),
        api.getRuntimeStateProjection(entityRequest(), queryContext),
        api.listAliveTeamProjections(listRequest(), queryContext),
      ]);

    ports.policy.isAuthorized = (receivedContext) =>
      receivedContext.authorizedScope === 'scope_canonical_team_read';
    const unauthorized = await invokeAll(context({ authorizedScope: 'scope_forbidden_team_read' }));
    expect(unauthorized).toHaveLength(4);
    expect(unauthorized.every((result) => result.kind === 'failure')).toBe(true);
    for (const result of unauthorized) {
      expect(result).toMatchObject({
        kind: 'failure',
        error: { code: 'forbidden', reason: 'scope_not_authorized' },
      });
    }
    expect(io).not.toHaveBeenCalled();

    ports.policy.isAuthorized = () => true;
    const abortController = new AbortController();
    abortController.abort();
    const cancelled = await invokeAll(context({ signal: abortController.signal }));
    for (const result of cancelled) {
      expect(result).toMatchObject({
        kind: 'failure',
        error: { code: 'cancelled', reason: 'request_cancelled' },
      });
    }
    expect(io).not.toHaveBeenCalled();

    const expired = await invokeAll(context({ deadlineAtMs: FIXED_NOW_MS }));
    for (const result of expired) {
      expect(result).toMatchObject({
        kind: 'failure',
        error: { code: 'cancelled', reason: 'deadline_exceeded' },
      });
    }
    expect(io).not.toHaveBeenCalled();
  });

  it('rechecks cancellation and deadline before follow-up legacy reads', async () => {
    const cancellationPorts = dependencies();
    const abortController = new AbortController();
    const aliveIdentityRead = vi.fn(cancellationPorts.identities.listAliveTeamBindings);
    cancellationPorts.identities.listAliveTeamBindings = aliveIdentityRead;
    cancellationPorts.runtime.getAliveTeams = (receivedContext) => {
      expect(receivedContext.signal).toBe(abortController.signal);
      abortController.abort();
      return ['legacy-alpha', 'legacy-beta'];
    };
    const cancelled = await apiFor(
      new LegacyTeamLifecycleReadSource(cancellationPorts)
    ).listAliveTeamProjections(listRequest(), context({ signal: abortController.signal }));
    expect(cancelled).toMatchObject({
      kind: 'failure',
      error: { code: 'cancelled', reason: 'request_cancelled' },
    });
    expect(aliveIdentityRead).not.toHaveBeenCalled();

    const deadlinePorts = dependencies();
    const dataRead = vi.fn(deadlinePorts.data.getTeamData);
    deadlinePorts.data.getTeamData = dataRead;
    let clockReads = 0;
    deadlinePorts.policy.nowMs = () => {
      clockReads += 1;
      return clockReads === 1 ? FIXED_NOW_MS : FIXED_NOW_MS + 1;
    };
    const expired = await apiFor(
      new LegacyTeamLifecycleReadSource(deadlinePorts)
    ).getTeamLifecycleSnapshot(entityRequest(), context({ deadlineAtMs: FIXED_NOW_MS + 1 }));
    expect(expired).toMatchObject({
      kind: 'failure',
      error: { code: 'cancelled', reason: 'deadline_exceeded' },
    });
    expect(dataRead).not.toHaveBeenCalled();
    expect(clockReads).toBe(2);
  });

  it('rejects legacy detail and runtime responses returned for the wrong team', async () => {
    const detailPorts = dependencies();
    detailPorts.data.getTeamData = (_legacyTeamName, receivedContext) => {
      expect(receivedContext).toBeDefined();
      return {
        teamName: 'legacy-beta',
        config: {},
        warnings: [],
        isAlive: true,
      };
    };
    const detail = await apiFor(
      new LegacyTeamLifecycleReadSource(detailPorts)
    ).getTeamLifecycleSnapshot(entityRequest(), context());
    expect(detail).toMatchObject({
      kind: 'failure',
      error: { code: 'internal', reason: 'corrupt_source' },
    });

    const runtimePorts = dependencies();
    runtimePorts.runtime.getRuntimeState = (_legacyTeamName, receivedContext) => {
      expect(receivedContext).toBeDefined();
      return { teamName: 'legacy-beta', isAlive: true };
    };
    const runtime = await apiFor(
      new LegacyTeamLifecycleReadSource(runtimePorts)
    ).getRuntimeStateProjection(entityRequest(), context());
    expect(runtime).toMatchObject({
      kind: 'failure',
      error: { code: 'internal', reason: 'corrupt_source' },
    });

    const alivePorts = dependencies();
    alivePorts.identities.listAliveTeamBindings = () => ({
      snapshotRevision: REVISION_LIST,
      bindings: [binding({ legacyTeamName: 'legacy-foreign' })],
      nextCursor: null,
    });
    const alive = await apiFor(
      new LegacyTeamLifecycleReadSource(alivePorts)
    ).listAliveTeamProjections(listRequest(), context());
    expect(alive).toMatchObject({
      kind: 'failure',
      error: { code: 'internal', reason: 'corrupt_source' },
    });
  });

  it('requires canonical identities at the Phase 2 facet while retaining Phase 1 parsing separately', () => {
    const canonical = parseCanonicalListTeamLifecycleResult({
      schemaVersion: 1,
      kind: 'success',
      snapshotRevision: REVISION_LIST,
      items: [
        {
          workspaceId: WORKSPACE_A,
          teamId: TEAM_A,
          displayName: 'Alpha',
          lifecycle: 'ready',
          revision: REVISION_A,
          additive: 'discarded',
        },
      ],
      nextCursor: null,
      additive: 'discarded',
    });
    expect(canonical).toMatchObject({ ok: true, value: { kind: 'success' } });
    if (canonical.ok && canonical.value.kind === 'success') {
      expect(Reflect.ownKeys(canonical.value.items[0])).toEqual([
        'workspaceId',
        'teamId',
        'displayName',
        'lifecycle',
        'revision',
      ]);
    }

    const sameDisplayName = parseCanonicalListTeamLifecycleResult({
      schemaVersion: 1,
      kind: 'success',
      snapshotRevision: REVISION_LIST,
      items: [
        {
          workspaceId: WORKSPACE_A,
          teamId: TEAM_B,
          displayName: 'Same',
          lifecycle: 'ready',
          revision: REVISION_B,
        },
        {
          workspaceId: WORKSPACE_B,
          teamId: TEAM_A,
          displayName: 'Same',
          lifecycle: 'ready',
          revision: REVISION_A,
        },
      ],
      nextCursor: null,
    });
    expect(sameDisplayName.ok).toBe(true);
    if (sameDisplayName.ok && sameDisplayName.value.kind === 'success') {
      expect(sameDisplayName.value.items.map((item) => item.teamId)).toEqual([TEAM_A, TEAM_B]);
    }

    expect(
      parseCanonicalListTeamLifecycleResult({
        schemaVersion: 1,
        kind: 'success',
        snapshotRevision: REVISION_LIST,
        items: [
          {
            teamId: 'team_alpha',
            displayName: 'Alpha',
            lifecycle: 'ready',
            revision: REVISION_A,
          },
        ],
        nextCursor: null,
      })
    ).toMatchObject({ ok: false, error: { reason: 'source_response_invalid' } });

    expect(
      parseGetTeamLifecycleSnapshotRequest({ ...entityRequest(), workspaceId: TEAM_A })
    ).toMatchObject({ ok: false, error: { reason: 'request_invalid' } });

    expect(
      parseGetTeamLifecycleSnapshotResult({
        schemaVersion: 1,
        kind: 'success',
        snapshotRevision: REVISION_A,
        snapshot: {
          workspaceId: WORKSPACE_A,
          teamId: TEAM_A,
          displayName: '/srv/private-workspace',
          lifecycle: 'ready',
          revision: REVISION_A,
        },
      })
    ).toMatchObject({ ok: false, error: { reason: 'source_response_invalid' } });
  });

  it('preserves draft, provisioning, corrupt, partial, unavailable, stale, and unexpected outcomes', async () => {
    const expected = {
      draft: { kind: 'success', snapshot: { lifecycle: 'draft' } },
      provisioning: {
        kind: 'inapplicable',
        code: 'unsupported',
        reason: 'unknown_lifecycle_provisioning',
      },
      corrupt: { kind: 'failure', error: { code: 'internal', reason: 'corrupt_source' } },
      partial: { kind: 'failure', error: { code: 'unavailable', reason: 'partial_source' } },
      unavailable: {
        kind: 'failure',
        error: { code: 'unavailable', reason: 'source_unavailable' },
      },
    } as const;

    for (const availability of Object.keys(expected) as LegacyTeamReadAvailability[]) {
      const result = await new GetTeamLifecycleSnapshot(
        new LegacyTeamLifecycleReadSource(dependencies({ availability }))
      ).execute(entityRequest(), context());
      expect(result).toMatchObject(expected[availability as keyof typeof expected]);
    }

    const stale = await new GetTeamLifecycleSnapshot(
      new LegacyTeamLifecycleReadSource(dependencies())
    ).execute(entityRequest(TEAM_A, WORKSPACE_A, 'revision_stale_client'), context());
    expect(stale).toMatchObject({
      kind: 'failure',
      error: { code: 'conflict', reason: 'snapshot_changed' },
    });

    const throwingDependencies = dependencies();
    throwingDependencies.identities.getTeamBinding = () => {
      throw new Error('private source failure');
    };
    const unexpected = await new GetTeamLifecycleSnapshot(
      new LegacyTeamLifecycleReadSource(throwingDependencies)
    ).execute(entityRequest(), context());
    expect(unexpected).toMatchObject({
      kind: 'failure',
      error: { code: 'internal', reason: 'unexpected' },
    });
    expect(JSON.stringify(unexpected)).not.toContain('private source failure');
  });

  it('rejects invalid cursors without reaching the source and rejects identity cross-attachment', async () => {
    const source = new LegacyTeamLifecycleReadSource(dependencies());
    const alivePort = vi.spyOn(source, 'listAliveTeamProjections');
    const alive = await new ListAliveTeamProjections(source).execute(
      { ...listRequest(), cursor: 'not-a-cursor' },
      context()
    );
    expect(alive).toMatchObject({
      kind: 'failure',
      error: { code: 'invalid_request', reason: 'request_invalid' },
    });
    expect(alivePort).not.toHaveBeenCalled();

    const crossed = parseGetTeamLifecycleSnapshotResult({
      schemaVersion: 1,
      kind: 'success',
      snapshotRevision: REVISION_A,
      snapshot: {
        workspaceId: WORKSPACE_B,
        teamId: TEAM_A,
        displayName: 'Alpha',
        lifecycle: 'ready',
        revision: REVISION_A,
      },
    });
    expect(crossed.ok).toBe(true);

    const useCase = new GetTeamLifecycleSnapshot({
      getTeamLifecycleSnapshot: () =>
        crossed.ok
          ? crossed.value
          : (() => {
              throw new Error('unreachable');
            })(),
    });
    await expect(useCase.execute(entityRequest(), context())).resolves.toMatchObject({
      kind: 'failure',
      error: { code: 'internal', reason: 'source_response_invalid' },
    });
  });

  it('projects additive response values into bounded known-field-only objects', () => {
    const snapshot = parseGetTeamLifecycleSnapshotResult({
      schemaVersion: 1,
      kind: 'success',
      snapshotRevision: REVISION_A,
      snapshot: {
        workspaceId: WORKSPACE_A,
        teamId: TEAM_A,
        displayName: 'Alpha',
        lifecycle: 'ready',
        revision: REVISION_A,
        projectPath: 'discarded',
      },
      teamName: 'discarded',
    });
    const runtime = parseGetRuntimeStateProjectionResult({
      schemaVersion: 1,
      kind: 'success',
      snapshotRevision: REVISION_A,
      projection: {
        workspaceId: WORKSPACE_A,
        teamId: TEAM_A,
        isAlive: true,
        revision: REVISION_A,
        runId: 'discarded',
      },
    });
    const alive = parseListAliveTeamProjectionsResult({
      schemaVersion: 1,
      kind: 'success',
      snapshotRevision: REVISION_LIST,
      items: [
        {
          workspaceId: WORKSPACE_A,
          teamId: TEAM_A,
          isAlive: true,
          revision: REVISION_A,
          teamName: 'discarded',
        },
      ],
      nextCursor: null,
    });

    for (const result of [snapshot, runtime, alive]) {
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(findSensitivePayloads(result.value)).toEqual([]);
        expect(JSON.stringify(result.value)).not.toContain('discarded');
      }
    }
  });
});
