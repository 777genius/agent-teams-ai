import {
  parseTeamIdentityRecord,
  type TeamIdentityReadGateway,
  type TeamIdentityRecord,
} from '@features/internal-storage/contracts';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import {
  type CanonicalListTeamLifecycleResult,
  type ListTeamLifecycleRequest,
  TEAM_LIFECYCLE_LIST_ROUTE,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
} from '@features/team-lifecycle/contracts';
import { WorkspaceMountBinding, WorkspaceRegistration } from '@features/workspace-registry';
import {
  createPhase2ReadAuthority,
  createPhase2ReadComposition,
  createPhase2ReadHost,
  type Phase2ReadAuthority,
} from '@main/composition/hosted/phase2ReadComposition';
import { registerTeamRoutes } from '@main/http/teams';
import { handlePhase2ListTeamLifecycle, initializePhase2TeamReadHandler } from '@main/ipc/teams';
import { HttpAPIClient } from '@renderer/api/httpClient';
import {
  createQueryContext,
  parseBootId,
  parseTeamId,
  parseWorkspaceId,
  type QueryContext,
} from '@shared/contracts/hosted';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { HttpServices } from '@main/http';

const NOW_MS = Date.parse('2026-07-18T00:00:30.000Z');
const CREATED_AT = '2026-07-18T00:00:00.000Z';
const ACTIVATED_AT = '2026-07-18T00:00:10.000Z';
const TOMBSTONED_AT = '2026-07-18T00:00:20.000Z';
const WORKSPACE_ID = parseWorkspaceId(`workspace_${'b'.repeat(32)}`);
const FOREIGN_WORKSPACE_ID = parseWorkspaceId(`workspace_${'e'.repeat(32)}`);

const request = (overrides: Partial<ListTeamLifecycleRequest> = {}): ListTeamLifecycleRequest => ({
  schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  cursor: null,
  expectedRevision: null,
  ...overrides,
});

interface ReadAuthorityOverrides {
  readonly actorId?: string;
  readonly authorizedScope?: string;
  readonly workspaceId?: typeof WORKSPACE_ID;
  readonly workspaceGeneration?: number;
  readonly deploymentId?: string;
  readonly bootId?: string;
}

function readAuthority(overrides: ReadAuthorityOverrides = {}): Phase2ReadAuthority {
  const workspaceId = overrides.workspaceId ?? WORKSPACE_ID;
  const workspaceGeneration = overrides.workspaceGeneration ?? 1;
  const bootId = overrides.bootId ?? 'boot_phase2-host';
  const registration = new WorkspaceRegistration({
    schemaVersion: 1,
    registrationKey: `registration-${workspaceId}`,
    workspaceId,
    displayName: 'Phase 2 test workspace',
    registrationRevision: 1,
    declaredRootHash: '9'.repeat(64),
    enabled: true,
  });
  const mountBinding = new WorkspaceMountBinding({
    registration,
    bootId: parseBootId(bootId),
    mountGeneration: workspaceGeneration,
    previousMountGeneration: workspaceGeneration > 1 ? workspaceGeneration - 1 : undefined,
    declaredRootHash: registration.declaredRootHash,
    observedAt: NOW_MS,
    health: 'healthy',
    allowedOperations: [],
  });
  const runtimeInstance = createRuntimeInstanceContext({
    deploymentId: overrides.deploymentId ?? 'deployment_phase2-host',
    bootId,
    claudeRoot: { kind: 'claude', reference: 'runtime://claude' },
    appDataRoot: { kind: 'app-data', reference: 'runtime://app-data' },
    workspaceRoots: [{ kind: 'workspace', reference: 'runtime://workspace' }],
    tempRoot: { kind: 'temp', reference: 'runtime://temp' },
    logsRoot: { kind: 'logs', reference: 'runtime://logs' },
  });
  return createPhase2ReadAuthority({
    actorId: overrides.actorId ?? 'actor_phase2-host',
    authorizedScope: overrides.authorizedScope ?? 'scope_team-lifecycle.read',
    mountBinding,
    runtimeInstance,
  });
}

function identity(
  state: TeamIdentityRecord['state'],
  fill = 'a',
  legacyKey = `team-${fill}`,
  workspaceBinding: TeamIdentityRecord['workspaceBinding'] = {
    workspaceId: WORKSPACE_ID,
    generation: 1,
  }
): TeamIdentityRecord {
  const adopted = state !== 'reserved';
  const published = state === 'file_published' || state === 'active' || state === 'tombstoned';
  return parseTeamIdentityRecord({
    teamId: parseTeamId(`team_${fill.repeat(32)}`),
    state,
    legacyKey,
    directoryFingerprint: fill.repeat(64),
    workspaceBinding,
    adoptionIntentId: adopted ? `adoption_${fill.repeat(32)}` : null,
    identityChecksum: published ? fill.repeat(64) : null,
    createdAt: CREATED_AT,
    activatedAt: state === 'active' || state === 'tombstoned' ? ACTIVATED_AT : null,
    tombstonedAt: state === 'tombstoned' ? TOMBSTONED_AT : null,
  });
}

function context(
  authority: Phase2ReadAuthority,
  sequence: number,
  overrides: Partial<Parameters<typeof createQueryContext>[0] & Record<string, unknown>> = {}
): QueryContext {
  return createQueryContext({
    actorId: authority.actorId,
    sessionId: 'session_phase2-host',
    deploymentId: authority.deploymentId,
    bootId: authority.bootId,
    requestId: `request_phase2-${sequence}`,
    authorizedScope: authority.authorizedScope,
    deadlineAtMs: NOW_MS + 10_000,
    signal: new AbortController().signal,
    ...overrides,
  });
}

interface HarnessOptions {
  readonly identities: readonly TeamIdentityRecord[] | null;
  readonly summaries?: readonly Record<string, unknown>[];
  readonly authority?: Phase2ReadAuthority;
  readonly contextOverrides?: Readonly<Record<string, unknown>>;
  readonly pageSize?: number;
  readonly beforeSummaryRead?: () => void;
}

function createHarness(options: HarnessOptions) {
  let identities = options.identities;
  let summaries =
    options.summaries ??
    (identities ?? [])
      .filter((record) => record.state === 'active')
      .map((record) => ({ teamName: record.legacyKey, pendingCreate: false }));
  let contextSequence = 0;
  const authority = options.authority ?? readAuthority();
  const observedContexts: QueryContext[] = [];
  const listTeamIdentities = vi.fn(() => Promise.resolve(identities ?? []));
  const getTeamIdentity = vi.fn((teamId: TeamIdentityRecord['teamId']) =>
    Promise.resolve((identities ?? []).find((record) => record.teamId === teamId) ?? null)
  );
  const listTeams = vi.fn((value: QueryContext) => {
    observedContexts.push(value);
    options.beforeSummaryRead?.();
    return Promise.resolve(summaries);
  });
  const gateway: TeamIdentityReadGateway | null = identities
    ? { listTeamIdentities, getTeamIdentity }
    : null;
  const composition = createPhase2ReadComposition({
    authority,
    teamIdentities: gateway,
    legacyData: {
      listTeams,
      getTeamData: (legacyTeamName) =>
        Promise.resolve({
          teamName: legacyTeamName,
          config: {},
          warnings: [],
          isAlive: false,
        }),
    },
    legacyRuntime: {
      getRuntimeState: (legacyTeamName) =>
        Promise.resolve({ teamName: legacyTeamName, isAlive: false }),
      getAliveTeams: () => Promise.resolve([]),
    },
    nowMs: () => NOW_MS,
    pageSize: options.pageSize,
  });
  const host = createPhase2ReadHost(composition, (hostAuthority) =>
    context(hostAuthority, ++contextSequence, options.contextOverrides)
  );
  return {
    authority,
    host,
    getTeamIdentity,
    listTeamIdentities,
    listTeams,
    observedContexts,
    replaceIdentities(next: readonly TeamIdentityRecord[]) {
      identities = next;
    },
    replaceSummaries(next: readonly Record<string, unknown>[]) {
      summaries = next;
    },
  };
}

async function readOverHttp(
  host: ReturnType<typeof createHarness>['host'],
  payload: unknown
): Promise<CanonicalListTeamLifecycleResult> {
  const app = Fastify();
  registerTeamRoutes(app, { phase2ReadHost: host } as HttpServices);
  await app.ready();
  try {
    const response = await app.inject({
      method: 'POST',
      url: TEAM_LIFECYCLE_LIST_ROUTE,
      payload: payload as Record<string, unknown>,
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  } finally {
    await app.close();
  }
}

describe('Phase 2 IPC/HTTP team lifecycle read conformance', () => {
  it('returns deeply equal canonical envelopes over IPC and HTTP with host-owned contexts', async () => {
    const harness = createHarness({ identities: [identity('active')] });
    initializePhase2TeamReadHandler(harness.host);

    const ipc = await handlePhase2ListTeamLifecycle(request());
    const http = await readOverHttp(harness.host, request());

    expect(ipc).toEqual(http);
    expect(ipc).toMatchObject({
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      kind: 'success',
      items: [
        {
          workspaceId: WORKSPACE_ID,
          teamId: parseTeamId(`team_${'a'.repeat(32)}`),
          lifecycle: 'ready',
        },
      ],
    });
    expect(harness.observedContexts).toHaveLength(2);
    expect(new Set(harness.observedContexts.map((value) => value.requestId)).size).toBe(2);
    expect(harness.observedContexts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorId: harness.authority.actorId,
          authorizedScope: harness.authority.authorizedScope,
          deploymentId: harness.authority.deploymentId,
          bootId: harness.authority.bootId,
        }),
      ])
    );
  });

  it('uses the canonical parser in the renderer client and contains transport errors', async () => {
    const harness = createHarness({ identities: [identity('active')] });
    const canonical = await harness.host.listTeamLifecycle(request());
    if (canonical.kind !== 'success') throw new Error('expected canonical success');
    const additiveResponse = {
      ...canonical,
      items: canonical.items.map((item) => ({ ...item, additiveItemField: 'accepted' })),
      additiveEnvelopeField: 'accepted',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(additiveResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockRejectedValueOnce(new Error('private network diagnostic'));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal(
      'EventSource',
      class {
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        addEventListener(): void {}
        close(): void {}
      }
    );

    try {
      const client = new HttpAPIClient('http://phase2.test');
      await expect(client.listTeamLifecycle(request())).resolves.toEqual(canonical);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        `http://phase2.test${TEAM_LIFECYCLE_LIST_ROUTE}`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(request()),
        })
      );

      const contained = await client.listTeamLifecycle(request());
      expect(contained).toEqual({
        schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
        kind: 'failure',
        error: { code: 'unavailable', reason: 'transport_unavailable' },
        retryable: true,
      });
      expect(JSON.stringify(contained)).not.toContain('private network diagnostic');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects wire-supplied context identically without exposing it to legacy reads', async () => {
    const harness = createHarness({ identities: [identity('active')] });
    initializePhase2TeamReadHandler(harness.host);
    const tamperedRequest = { ...request(), actorId: 'actor_attacker' };

    const ipc = await handlePhase2ListTeamLifecycle(tamperedRequest);
    const http = await readOverHttp(harness.host, tamperedRequest);

    expect(ipc).toEqual(http);
    expect(ipc).toMatchObject({
      kind: 'failure',
      error: { code: 'invalid_request', reason: 'request_invalid' },
      retryable: false,
    });
    expect(harness.listTeamIdentities).not.toHaveBeenCalled();
    expect(harness.listTeams).not.toHaveBeenCalled();
  });

  it.each([
    ['reserved', 'draft'],
    ['active', 'ready'],
    ['tombstoned', 'deleted'],
  ] as const)('projects the %s identity state as %s', async (state, lifecycle) => {
    const result = await createHarness({ identities: [identity(state)] }).host.listTeamLifecycle(
      request()
    );

    expect(result).toMatchObject({ kind: 'success', items: [{ lifecycle }] });
  });

  it.each(['adoption_prepared', 'file_published'] as const)(
    'reports the %s identity state as explicitly inapplicable',
    async (state) => {
      const harness = createHarness({ identities: [identity(state)] });
      const result = await harness.host.listTeamLifecycle(request());

      expect(result).toEqual({
        schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
        kind: 'inapplicable',
        code: 'unsupported',
        reason: 'unknown_lifecycle_provisioning',
      });
      expect(harness.listTeams).toHaveBeenCalledTimes(1);
    }
  );

  it('excludes only well-formed foreign workspace identities', async () => {
    const local = identity('active', 'a');
    const foreign = identity('active', 'c', 'team-c', {
      workspaceId: FOREIGN_WORKSPACE_ID,
      generation: 1,
    });
    const harness = createHarness({
      identities: [local, foreign],
      summaries: [{ teamName: 'team-a' }, { teamName: 'team-c' }],
    });

    const result = await harness.host.listTeamLifecycle(request());

    expect(result).toMatchObject({ kind: 'success', items: [{ teamId: local.teamId }] });
    if (result.kind !== 'success') throw new Error('expected success');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].workspaceId).toBe(WORKSPACE_ID);
    expect(harness.listTeamIdentities).toHaveBeenCalledTimes(1);
    expect(harness.getTeamIdentity).not.toHaveBeenCalled();
  });

  it.each([
    [
      'an unbound identity',
      identity('active', 'f', 'team-f', null),
      { code: 'internal', reason: 'corrupt_source' },
    ],
    [
      'a local stale-generation identity',
      identity('active', 'd', 'team-d', { workspaceId: WORKSPACE_ID, generation: 2 }),
      { code: 'conflict', reason: 'snapshot_changed' },
    ],
  ] as const)('fails closed for %s', async (_name, invalidIdentity, error) => {
    const harness = createHarness({ identities: [identity('active'), invalidIdentity] });

    const result = await harness.host.listTeamLifecycle(request());

    expect(result).toMatchObject({ kind: 'failure', error });
    expect(harness.listTeams).not.toHaveBeenCalled();
  });

  it('fails before identity, data, or runtime IO when the host context mismatches authority', async () => {
    const harness = createHarness({
      identities: [identity('active')],
      contextOverrides: { actorId: 'actor_other-host' },
    });

    const result = await harness.host.listTeamLifecycle(request());

    expect(result).toMatchObject({
      kind: 'failure',
      error: { code: 'forbidden', reason: 'scope_not_authorized' },
    });
    expect(harness.listTeamIdentities).not.toHaveBeenCalled();
    expect(harness.listTeams).not.toHaveBeenCalled();
  });

  it('produces deterministic revisions and conflicts after identity changes', async () => {
    const harness = createHarness({
      identities: [identity('active', 'a'), identity('active', 'c')],
      pageSize: 1,
    });
    const first = await harness.host.listTeamLifecycle(request());
    const repeated = await harness.host.listTeamLifecycle(request());
    expect(first).toEqual(repeated);
    expect(first.kind).toBe('success');
    if (first.kind !== 'success') throw new Error('expected success');
    expect(first.nextCursor).not.toBeNull();

    const second = await harness.host.listTeamLifecycle(request({ cursor: first.nextCursor }));
    expect(second).toMatchObject({ kind: 'success', nextCursor: null });

    harness.replaceIdentities([identity('active', 'a'), identity('tombstoned', 'c')]);
    const staleRevision = await harness.host.listTeamLifecycle(
      request({ expectedRevision: first.snapshotRevision })
    );
    const staleCursor = await harness.host.listTeamLifecycle(request({ cursor: first.nextCursor }));
    for (const result of [staleRevision, staleCursor]) {
      expect(result).toMatchObject({
        kind: 'failure',
        error: { code: 'conflict', reason: 'snapshot_changed' },
        retryable: false,
      });
    }
  });

  it('includes lifecycle-only summary changes in the snapshot revision and cursor validity', async () => {
    const harness = createHarness({
      identities: [identity('active', 'a'), identity('active', 'c')],
      summaries: [{ teamName: 'team-a' }, { teamName: 'team-c' }],
      pageSize: 1,
    });
    const first = await harness.host.listTeamLifecycle(request());
    if (first.kind !== 'success' || first.nextCursor === null) {
      throw new Error('expected paged success');
    }

    harness.replaceSummaries([
      { teamName: 'team-a' },
      { teamName: 'team-c', partialLaunchFailure: true },
    ]);
    const changed = await harness.host.listTeamLifecycle(request());
    if (changed.kind !== 'success') throw new Error('expected changed success');
    expect(changed.snapshotRevision).not.toBe(first.snapshotRevision);
    await expect(
      harness.host.listTeamLifecycle(request({ expectedRevision: first.snapshotRevision }))
    ).resolves.toMatchObject({
      kind: 'failure',
      error: { code: 'conflict', reason: 'snapshot_changed' },
    });
    await expect(
      harness.host.listTeamLifecycle(request({ cursor: first.nextCursor }))
    ).resolves.toMatchObject({
      kind: 'failure',
      error: { code: 'conflict', reason: 'snapshot_changed' },
    });
  });

  it('freezes tombstones from the identity read even when storage mutates mid-request', async () => {
    let mutated = false;
    const harness = createHarness({
      identities: [identity('active')],
      summaries: [{ teamName: 'team-a' }],
      beforeSummaryRead: () => {
        if (mutated) return;
        mutated = true;
        harness.replaceIdentities([identity('tombstoned')]);
      },
    });

    const frozen = await harness.host.listTeamLifecycle(request());
    expect(frozen).toMatchObject({ kind: 'success', items: [{ lifecycle: 'ready' }] });
    expect(harness.listTeamIdentities).toHaveBeenCalledTimes(1);

    const nextRequest = await harness.host.listTeamLifecycle(request());
    expect(nextRequest).toMatchObject({ kind: 'success', items: [{ lifecycle: 'deleted' }] });
    expect(harness.listTeamIdentities).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['actor', { actorId: 'actor_other-host' }],
    ['scope', { authorizedScope: 'scope_other.read' }],
    ['workspace', { workspaceId: FOREIGN_WORKSPACE_ID }],
    ['generation', { workspaceGeneration: 2 }],
    ['deployment', { deploymentId: 'deployment_other-host' }],
    ['boot', { bootId: 'boot_other-host' }],
  ] as const)('rejects a cursor replay across %s authority', async (_field, authorityOverride) => {
    const source = createHarness({
      identities: [identity('active', 'a'), identity('active', 'c')],
      pageSize: 1,
    });
    const first = await source.host.listTeamLifecycle(request());
    if (first.kind !== 'success' || first.nextCursor === null) {
      throw new Error('expected paged success');
    }

    const targetAuthority = readAuthority(authorityOverride);
    const targetBinding = {
      workspaceId: targetAuthority.workspaceId,
      generation: targetAuthority.workspaceGeneration,
    };
    const target = createHarness({
      authority: targetAuthority,
      identities: [
        identity('active', 'a', 'team-a', targetBinding),
        identity('active', 'c', 'team-c', targetBinding),
      ],
      pageSize: 1,
    });

    const replay = await target.host.listTeamLifecycle(request({ cursor: first.nextCursor }));
    expect(replay).toMatchObject({
      kind: 'failure',
      error: { code: 'conflict', reason: 'snapshot_changed' },
    });
  });

  it('fails closed for unavailable, unknown, or tampered identity state without legacy fallback', async () => {
    const unavailable = createHarness({ identities: null });
    const unavailableResult = await unavailable.host.listTeamLifecycle(request());
    expect(unavailableResult).toMatchObject({
      kind: 'failure',
      error: { code: 'unavailable', reason: 'identity_storage_unavailable' },
      retryable: true,
    });
    expect(unavailable.listTeams).not.toHaveBeenCalled();

    const unknownState = createHarness({
      identities: [
        { ...identity('active'), state: 'future_identity_state' } as unknown as TeamIdentityRecord,
      ],
    });
    const unknownResult = await unknownState.host.listTeamLifecycle(request());
    expect(unknownResult).toMatchObject({
      kind: 'failure',
      error: { code: 'internal', reason: 'corrupt_source' },
      retryable: false,
    });
    expect(JSON.stringify(unknownResult)).not.toContain('future_identity_state');
    expect(unknownState.listTeams).not.toHaveBeenCalled();
  });
});
