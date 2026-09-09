import { createHash } from 'node:crypto';
import { promises as directoryFs } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseHostedSessionId, parseUserId } from '@features/hosted-access';
import { normalizeCurrentTeamIdentitySchema } from '@features/internal-storage/main/composition';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import { HOSTED_TEAM_CONFIGURATION_ROUTES as routes } from '@features/team-configuration/contracts';
import {
  WorkspaceMountBinding,
  WorkspaceRegistration,
  WorkspaceRegistrationRegistry,
} from '@features/workspace-registry';
import { createHostedDraftPublicationComposition } from '@main/composition/hosted/hostedDraftPublicationComposition';
import {
  createHostedTeamConfigurationComposition,
  createHostedTeamConfigurationRouteAdmissionBinding,
} from '@main/composition/hosted/hostedTeamConfigurationComposition';
import { resolveHostedTeamWorkspaceId } from '@main/composition/hosted/hostedTeamWorkspaceAttribution';
import {
  createMountBindingScopedTeamLifecycleReadPorts,
  createTeamLifecycleReadAuthority,
  createTeamLifecycleReadComposition,
  createTeamLifecycleReadHost,
} from '@main/composition/hosted/teamLifecycleReadComposition';
import { createTeamLifecycleReadOnlyIdentitySource } from '@main/composition/hosted/teamLifecycleReadOnlyIdentitySource';
import {
  createQueryContext,
  parseActorId,
  parseAuthorizedScope,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import Database from 'better-sqlite3-node';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('better-sqlite3', () => import('better-sqlite3-node'));

import type { HostedAuthenticatedPrincipal } from '@features/hosted-access';
import type {
  HostedTeamConfigurationStorageGateway,
  InternalStorageBackendInfo,
  TeamDraftPublicationStorageGateway,
  TeamIdentityPublicationGateway,
} from '@features/internal-storage/contracts';
import type { InternalStorageHostedAuthFeature } from '@features/internal-storage/main';
import type { HostedDraftPublicationComposition } from '@main/composition/hosted/hostedDraftPublicationComposition';
import type { HostedTeamConfigurationComposition } from '@main/composition/hosted/hostedTeamConfigurationComposition';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
const publicWorkspaceId = parseWorkspaceId(`workspace_${'a'.repeat(32)}`);
const runtimeWorkspaceId = parseWorkspaceId(`workspace_${'b'.repeat(32)}`);
const actorId = parseActorId('actor_publication-fixture');
const userId = parseUserId('user_publication-fixture');
const sessionId = parseHostedSessionId('session_publication-fixture');
const payload = {
  schemaVersion: 1,
  workspaceId: publicWorkspaceId,
  idempotencyKey: 'idempotency_canonical-original',
  name: 'Original draft',
  members: [{ name: 'lead' }],
};

async function setup() {
  const root = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), 'canonical-create-http-')
  );
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const appDataRoot = path.join(root, 'data');
  const claudeRoot = path.join(root, 'claude');
  await fs.mkdir(claudeRoot, { mode: 0o700 });
  await fs.mkdir(path.join(claudeRoot, 'teams'), { mode: 0o700 });
  const databasePath = path.join(appDataRoot, 'storage', 'app.db');
  const core = new InternalStorageWorkerCore({
    databasePath,
    createDatabase: (file, options) => new Database(file, options),
  });
  cleanup.push(async () => {
    core.close();
  });
  core.handle('ping', {});
  const identities: TeamIdentityPublicationGateway = {
    listTeamIdentities: async () => core.handle('teamIdentity.list', {}) as never,
    getTeamIdentity: async (teamId) => core.handle('teamIdentity.get', { teamId }) as never,
    reserveTeamIdentity: async (input) => core.handle('teamIdentity.reserve', input) as never,
    prepareReservedTeamAdoption: async (input) =>
      core.handle('teamIdentity.prepareReserved', input) as never,
    recordTeamIdentityFilePublished: async (input) =>
      core.handle('teamIdentity.recordPublished', input) as never,
    commitTeamAdoption: async (input) => core.handle('teamIdentity.commitAdoption', input) as never,
    tombstoneTeamIdentity: async (input) => core.handle('teamIdentity.tombstone', input) as never,
  };
  const journal: TeamDraftPublicationStorageGateway = {
    readTeamDraftPublication: async (input) => core.handle('draftPublication.read', input) as never,
    lookupTeamDraftPublication: async (input) =>
      core.handle('draftPublication.lookup', input) as never,
    settleTeamDraftPublication: async (input) =>
      core.handle('draftPublication.settle', input) as never,
  };
  const storage: HostedTeamConfigurationStorageGateway = {
    createHostedTeamConfiguration: async (input) =>
      core.handle('hostedTeamConfiguration.create', input) as never,
    readHostedTeamConfiguration: async (input) =>
      core.handle('hostedTeamConfiguration.read', input) as never,
    updateHostedTeamConfiguration: async (input) =>
      core.handle('hostedTeamConfiguration.update', input) as never,
    deleteHostedTeamConfiguration: async (input) =>
      core.handle('hostedTeamConfiguration.delete', input) as never,
  };
  const runtimeInstance = createRuntimeInstanceContext({
    deploymentId: 'deployment_publication-fixture',
    bootId: 'boot_publication-fixture',
    appDataRoot: { kind: 'app-data', reference: appDataRoot },
    claudeRoot: { kind: 'claude', reference: claudeRoot },
    workspaceRoots: [],
    tempRoot: { kind: 'temp', reference: root },
    logsRoot: { kind: 'logs', reference: root },
  });
  const registration = new WorkspaceRegistration({
    schemaVersion: 1,
    registrationKey: 'fixture',
    workspaceId: runtimeWorkspaceId,
    displayName: 'Fixture',
    registrationRevision: 1,
    declaredRootHash: 'c'.repeat(64),
    enabled: true,
  });
  const mountBinding = new WorkspaceMountBinding({
    registration,
    bootId: runtimeInstance.bootId,
    mountGeneration: 1,
    declaredRootHash: registration.declaredRootHash,
    observedAt: Date.now(),
    health: 'healthy',
    allowedOperations: [],
  });
  const authorizedScope = parseAuthorizedScope('scope_publication-fixture');
  let grantRevision = 'd'.repeat(64);
  let authorized = true;
  let authenticatedUserId = userId;
  const authentication = {
    authenticatedPrincipalFor: (): HostedAuthenticatedPrincipal => ({
      principal: {
        userId: authenticatedUserId,
        displayName: 'Fixture',
        role: 'member',
        permissions: ['hosted.query', 'hosted.command'],
        authenticationMethod: 'oidc',
        sessionId,
      },
      authenticatedSessionId: sessionId,
    }),
    isTeamConfigurationScopeAuthorized: async (
      _request: object,
      scope: { workspaceId: unknown }
    ) =>
      authorized && scope.workspaceId === publicWorkspaceId
        ? ('authorized' as const)
        : ('denied' as const),
  };
  const drafts = {
    databasePath,
    initialize: async () =>
      (core.handle('ping', {}) as InternalStorageBackendInfo).connectionFileIdentity!,
    identityPublication: identities,
    captureIdentitySnapshot: async () => core.handle('teamIdentity.snapshot', {}) as Uint8Array,
    draftPublications: journal,
    teamConfigurations: storage,
    gateway: {
      hostedAuthCall: async (op: string, value: unknown) => {
        if (
          op !== 'workspace.grant.list' ||
          (value as { userId: string }).userId !== authenticatedUserId
        )
          throw new Error('unexpected auth call');
        return authorized
          ? [
              {
                userId: authenticatedUserId,
                workspaceId: publicWorkspaceId,
                runtimeWorkspaceId,
                grantGeneration: 0,
                grantRevision,
              },
            ]
          : [];
      },
    },
  } as unknown as InternalStorageHostedAuthFeature;
  const authority = createTeamLifecycleReadAuthority({
    actorId,
    authorizedScope,
    mountBinding,
    runtimeInstance,
  });
  const publication = await createHostedDraftPublicationComposition({
    drafts,
    bootstrap: {
      actorId,
      authorizedScope,
      deploymentId: runtimeInstance.deploymentId,
      bootId: runtimeInstance.bootId,
      workspaceId: runtimeWorkspaceId,
      runtimeInstance,
      mountBinding,
      workspaceRegistrySnapshot: {
        registry: new WorkspaceRegistrationRegistry([registration]),
        bindings: [mountBinding],
      },
      authority,
    },
  });
  cleanup.push(() => publication.dispose());
  // Same sequence as standalone: retain writer, then admit reads, then expose configuration.
  const canonicalReader = await createTeamLifecycleReadOnlyIdentitySource({
    appDataRoot,
    currentWriter: publication.identityReadSource,
  });
  if (!canonicalReader) throw new Error('actual startup canonical read admission failed');
  const mount = (override: HostedDraftPublicationComposition | null = publication) => {
    const composition: HostedTeamConfigurationComposition =
      createHostedTeamConfigurationComposition({
        authentication,
        storage,
        publication: override,
        restoreGeneration: 0,
        runtimeInstance,
        expectedDeploymentId: runtimeInstance.deploymentId,
        routeAdmissionBinding: createHostedTeamConfigurationRouteAdmissionBinding(() =>
          composition.isReady()
        ),
      });
    const app = Fastify();
    composition.register(app);
    cleanup.push(() => app.close());
    return app;
  };
  const reload = () => {
    const reader = new InternalStorageWorkerCore({
      databasePath,
      mode: 'team-identity-read-only',
      createDatabase: (file, options) => new Database(file, options),
    });
    cleanup.push(async () => {
      reader.close();
    });
    const gateway = {
      listTeamIdentities: async () => reader.handle('teamIdentity.list', {}) as never,
      getTeamIdentity: async (teamId: Parameters<typeof identities.getTeamIdentity>[0]) =>
        reader.handle('teamIdentity.get', { teamId }) as never,
    };
    const ports = createMountBindingScopedTeamLifecycleReadPorts({
      authority,
      runtimeInstance,
      mountBinding,
      teamIdentities: gateway,
      nowMs: Date.now,
    });
    const readRuntime = vi.spyOn(ports.legacyRuntime, 'getRuntimeState');
    const composition = createTeamLifecycleReadComposition({
      authority,
      ...ports,
      nowMs: Date.now,
    });
    const host = createTeamLifecycleReadHost(composition, (readAuthority, signal) =>
      createQueryContext({
        actorId: readAuthority.actorId,
        authorizedScope: readAuthority.authorizedScope,
        deploymentId: readAuthority.deploymentId,
        bootId: readAuthority.bootId,
        sessionId: 'session_canonical-read-fixture',
        requestId: 'request_canonical-read-fixture',
        signal,
        deadlineAtMs: Date.now() + 10_000,
      })
    );
    return {
      host,
      gateway,
      readRuntime,
      runtimeProjection: (teamId: Parameters<typeof identities.getTeamIdentity>[0]) =>
        composition.teamLifecycle.getRuntimeStateProjection(
          { schemaVersion: 1, workspaceId: runtimeWorkspaceId, teamId, expectedRevision: null },
          createQueryContext({
            actorId,
            authorizedScope,
            deploymentId: runtimeInstance.deploymentId,
            bootId: runtimeInstance.bootId,
            sessionId: 'session_canonical-runtime-fixture',
            requestId: 'request_canonical-runtime-fixture',
            signal: new AbortController().signal,
            deadlineAtMs: Date.now() + 10_000,
          })
        ),
    };
  };
  return {
    root,
    appDataRoot,
    databasePath,
    claudeRoot,
    core,
    storage,
    identities,
    journal,
    publication,
    canonicalReader,
    mount,
    reload,
    signInOriginalUser: () => {
      authenticatedUserId = userId;
    },
    signInOtherUser: () => {
      authenticatedUserId = parseUserId('user_other-publication-fixture');
    },
    revoke: () => {
      authorized = false;
    },
    regrant: () => {
      authorized = true;
      grantRevision = 'e'.repeat(64);
    },
  };
}

describe.skipIf(process.platform !== 'linux')('current HTTP canonical draft composition', () => {
  it('keeps the original create response and discovers the same canonical pendingCreate identity after replay', async () => {
    const f = await setup();
    const app = f.mount();
    const created = await app.inject({ method: 'POST', url: routes.createDraft, payload });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    // Existing strict browser transport remains compatible; status is on the operation endpoint.
    expect(Object.keys(body).sort()).toEqual([
      'identity',
      'kind',
      'outcome',
      'revision',
      'schemaVersion',
    ]);
    const identity = await f.identities.getTeamIdentity(body.identity.teamId);
    expect(identity).toMatchObject({
      state: 'active',
      workspaceBinding: { workspaceId: runtimeWorkspaceId, generation: 1 },
    });
    const config = JSON.parse(
      await fs.readFile(
        path.join(f.claudeRoot, 'teams', identity!.legacyKey, 'config.json'),
        'utf8'
      )
    );
    expect(config).toEqual({ name: identity!.legacyKey, pendingCreate: true });
    const saved = await app.inject({
      method: 'POST',
      url: routes.getSavedRequest,
      payload: { schemaVersion: 1, ...body.identity },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().draft).toMatchObject({
      ...body.identity,
      revision: body.revision,
      metadata: { name: payload.name },
      members: payload.members,
    });
    const replay = await app.inject({ method: 'POST', url: routes.createDraft, payload });
    expect(replay.json()).toEqual({ ...body, outcome: 'idempotent_replay' });
    expect(await f.identities.listTeamIdentities()).toHaveLength(1);
    const status = await app.inject({
      method: 'POST',
      url: routes.getPublication,
      payload: {
        schemaVersion: 1,
        workspaceId: publicWorkspaceId,
        idempotencyKey: payload.idempotencyKey,
      },
    });
    expect(status.json()).toMatchObject({
      kind: 'publication',
      teamId: body.identity.teamId,
      publication: { state: 'published' },
    });
    expect(JSON.stringify(status.json())).not.toContain(f.root);
    const assertPublishedDraft = async () => {
      const { host, gateway, runtimeProjection, readRuntime } = f.reload();
      expect(await gateway.getTeamIdentity(body.identity.teamId)).toMatchObject({
        teamId: body.identity.teamId,
        state: 'active',
        identityChecksum: identity!.identityChecksum,
      });
      const listed = await host.listTeamLifecycle({
        schemaVersion: 1,
        cursor: null,
        expectedRevision: null,
      });
      expect(listed.kind).toBe('success');
      if (listed.kind !== 'success') throw new Error('canonical draft list failed');
      const rows = listed.items.filter(
        (item) => item.teamId === body.identity.teamId && item.workspaceId === runtimeWorkspaceId
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        teamId: body.identity.teamId,
        workspaceId: runtimeWorkspaceId,
        lifecycle: 'draft',
        revision: expect.stringMatching(/^revision_/u),
      });
      // Generic workspace attribution is intentionally not executable admission.
      expect(await resolveHostedTeamWorkspaceId(host, body.identity.teamId, gateway)).toEqual({
        kind: 'found',
        runtimeWorkspaceId,
        attributionRevision: expect.stringMatching(/^[0-9a-f]{64}$/u),
        identityChecksum: identity!.identityChecksum,
      });
      expect(await runtimeProjection(body.identity.teamId)).toMatchObject({
        schemaVersion: 1,
        kind: 'failure',
        error: { code: 'unavailable', reason: 'source_unavailable' },
        retryable: true,
      });
      expect(readRuntime).not.toHaveBeenCalled();
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(f.claudeRoot, 'teams', identity!.legacyKey, 'config.json'),
            'utf8'
          )
        )
      ).toEqual({ name: identity!.legacyKey, pendingCreate: true });
    };
    await assertPublishedDraft();
    const updated = await app.inject({
      method: 'POST',
      url: routes.updateDraft,
      payload: {
        schemaVersion: 1,
        ...body.identity,
        expectedRevision: body.revision,
        updates: { description: 'Published draft remains configurable' },
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      kind: 'updated',
      draft: {
        ...body.identity,
        metadata: { name: payload.name, description: 'Published draft remains configurable' },
        members: payload.members,
      },
    });
    const savedAgain = await f.mount().inject({
      method: 'POST',
      url: routes.getSavedRequest,
      payload: { schemaVersion: 1, ...body.identity },
    });
    expect(savedAgain.statusCode).toBe(200);
    expect(savedAgain.json().draft).toEqual(updated.json().draft);
    await assertPublishedDraft();
  });

  it('retains the durable create identity after directory IO returns EROFS and publishes it on replay', async () => {
    const f = await setup();
    const app = f.mount();
    // Inject only the actual descriptor-relative mkdir failure. All publication,
    // journal, identity, and recovery code remains the production composition.
    const mkdir = vi
      .spyOn(directoryFs, 'mkdir')
      .mockRejectedValueOnce(Object.assign(new Error('read-only file system'), { code: 'EROFS' }));
    try {
      expect(
        (await app.inject({ method: 'POST', url: routes.createDraft, payload })).statusCode
      ).toBe(503);
      expect(mkdir).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(/^\/proc\/self\/fd\/\d+\/draft-[a-f0-9]{32}$/),
        { mode: 0o700 }
      );
    } finally {
      mkdir.mockRestore();
    }
    const db = new Database(f.databasePath, { readonly: true });
    try {
      const drafts = db
        .prepare('SELECT team_id, revision_token FROM hosted_team_configuration_drafts')
        .all() as { team_id: string; revision_token: string }[];
      expect(drafts).toHaveLength(1);
      const keys = db.prepare('SELECT * FROM hosted_team_configuration_create_keys').all();
      expect(keys).toHaveLength(1);
      const query = {
        schemaVersion: 1,
        workspaceId: publicWorkspaceId,
        idempotencyKey: payload.idempotencyKey,
      };
      const before = (
        await app.inject({ method: 'POST', url: routes.getPublication, payload: query })
      ).json();
      expect(before).toMatchObject({
        teamId: drafts[0].team_id,
        publication: { state: 'recovery_required' },
      });
      expect(
        db.prepare('SELECT operation_id, state FROM hosted_team_configuration_publications').all()
      ).toEqual([{ operation_id: before.publication.operationId, state: 'recovery_required' }]);
      expect(await f.canonicalReader.listTeamIdentities()).toEqual([]);
      expect(await fs.readdir(path.join(f.claudeRoot, 'teams'))).toEqual([]);

      const replay = await app.inject({ method: 'POST', url: routes.createDraft, payload });
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toMatchObject({
        identity: { teamId: drafts[0].team_id },
        revision: drafts[0].revision_token,
        outcome: 'idempotent_replay',
      });
      const after = (
        await app.inject({ method: 'POST', url: routes.getPublication, payload: query })
      ).json();
      expect(after).toMatchObject({
        teamId: before.teamId,
        publication: { operationId: before.publication.operationId, state: 'published' },
      });
      expect(
        db.prepare('SELECT team_id, revision_token FROM hosted_team_configuration_drafts').all()
      ).toEqual(drafts);
      expect(db.prepare('SELECT * FROM hosted_team_configuration_create_keys').all()).toEqual(keys);
      expect(
        db.prepare('SELECT operation_id, state FROM hosted_team_configuration_publications').all()
      ).toEqual([{ operation_id: before.publication.operationId, state: 'published' }]);
      const identities = await f.canonicalReader.listTeamIdentities();
      expect(identities).toHaveLength(1);
      expect(identities[0]).toMatchObject({ teamId: before.teamId, state: 'active' });
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(f.claudeRoot, 'teams', identities[0].legacyKey, 'config.json'),
            'utf8'
          )
        )
      ).toEqual({ name: identities[0].legacyKey, pendingCreate: true });
    } finally {
      db.close();
    }
  });

  it('reloads a reserved draft for configuration while generic workspace attribution is unavailable', async () => {
    const f = await setup();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let paused = false;
    const app = f.mount({
      ...f.publication,
      publisher: {
        ...f.publication.publisher,
        publishDraft: (request) =>
          f.publication.publisher.publishDraft({
            ...request,
            assertCurrent: async () => {
              await request.assertCurrent();
              if (
                !paused &&
                (await f.identities.getTeamIdentity(request.publication.teamId))?.state ===
                  'reserved'
              ) {
                paused = true;
                entered();
                await gate;
              }
            },
          }),
      },
    });
    const response = app
      .inject({ method: 'POST', url: routes.createDraft, payload })
      .then((value) => value);
    try {
      await started;
      const status = (
        await app.inject({
          method: 'POST',
          url: routes.getPublication,
          payload: {
            schemaVersion: 1,
            workspaceId: publicWorkspaceId,
            idempotencyKey: payload.idempotencyKey,
          },
        })
      ).json();
      const saved = await app.inject({
        method: 'POST',
        url: routes.getSavedRequest,
        payload: { schemaVersion: 1, workspaceId: publicWorkspaceId, teamId: status.teamId },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().draft.metadata.name).toBe(payload.name);
      const { host, gateway } = f.reload();
      expect(
        await host.listTeamLifecycle({ schemaVersion: 1, cursor: null, expectedRevision: null })
      ).toMatchObject({ kind: 'success', items: [{ teamId: status.teamId }] });
      expect(await resolveHostedTeamWorkspaceId(host, status.teamId, gateway)).toEqual({
        kind: 'unavailable',
      });
    } finally {
      release();
      await response;
    }
  });

  it('settles the attempt before responding, and recovers a lost response by the original create key', async () => {
    const f = await setup();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const app = f.mount({
      ...f.publication,
      publisher: {
        ...f.publication.publisher,
        publishDraft: async (request) => {
          entered();
          await gate;
          return f.publication.publisher.publishDraft(request);
        },
      },
    });
    let finished = false;
    const response = app
      .inject({ method: 'POST', url: routes.createDraft, payload })
      .then((value) => {
        finished = true;
        return value;
      });
    try {
      await started;
      expect(finished).toBe(false);
      const pending = await app.inject({
        method: 'POST',
        url: routes.getPublication,
        payload: {
          schemaVersion: 1,
          workspaceId: publicWorkspaceId,
          idempotencyKey: payload.idempotencyKey,
        },
      });
      expect(pending.json()).toMatchObject({ publication: { state: 'pending' } });
      expect(await f.identities.listTeamIdentities()).toEqual([]); // status did not import/repair
      release();
      expect((await response).statusCode).toBe(201);
      const retry = await app.inject({ method: 'POST', url: routes.createDraft, payload });
      expect(retry.json().identity.teamId).toBe(pending.json().teamId);
    } finally {
      release();
      await response;
    }
  });

  it('refuses a changed grant within an attempt and requires fresh authorized recovery', async () => {
    const f = await setup();
    let change = true;
    const app = f.mount({
      ...f.publication,
      publisher: {
        ...f.publication.publisher,
        publishDraft: async (request) => {
          if (change) {
            await request.assertCurrent();
            f.regrant();
            change = false;
          }
          return f.publication.publisher.publishDraft(request);
        },
      },
    });
    expect(
      (await app.inject({ method: 'POST', url: routes.createDraft, payload })).statusCode
    ).toBe(503);
    const query = {
      schemaVersion: 1,
      workspaceId: publicWorkspaceId,
      idempotencyKey: payload.idempotencyKey,
    };
    const status = await app.inject({ method: 'POST', url: routes.getPublication, payload: query });
    expect(status.json().publication.state).toBe('recovery_required');
    expect(await f.identities.listTeamIdentities()).toEqual([]);
    f.revoke();
    expect(
      (await app.inject({ method: 'POST', url: routes.recoverPublication, payload: query }))
        .statusCode
    ).toBe(403);
    f.regrant();
    const recovered = await app.inject({
      method: 'POST',
      url: routes.recoverPublication,
      payload: {
        schemaVersion: 1,
        workspaceId: publicWorkspaceId,
        operationId: status.json().publication.operationId,
      },
    });
    expect(recovered.json()).toMatchObject({
      teamId: status.json().teamId,
      publication: { state: 'published' },
    });
  });

  it('recovers a lost final journal acknowledgement without allocating another canonical identity', async () => {
    const f = await setup();
    let dropped = false;
    const app = f.mount({
      ...f.publication,
      journal: {
        ...f.journal,
        settleTeamDraftPublication: async (input) => {
          const settled = await f.journal.settleTeamDraftPublication(input);
          if (input.state === 'published' && !dropped) {
            dropped = true;
            throw new Error('lost final response');
          }
          return settled;
        },
      },
    });
    expect(
      (await app.inject({ method: 'POST', url: routes.createDraft, payload })).statusCode
    ).toBe(503);
    const query = {
      schemaVersion: 1,
      workspaceId: publicWorkspaceId,
      idempotencyKey: payload.idempotencyKey,
    };
    const status = (
      await app.inject({ method: 'POST', url: routes.getPublication, payload: query })
    ).json();
    expect(status.publication.state).toBe('published');
    expect(
      (await app.inject({ method: 'POST', url: routes.recoverPublication, payload: query })).json()
    ).toEqual(status);
    const replay = (await app.inject({ method: 'POST', url: routes.createDraft, payload })).json();
    expect(replay.identity.teamId).toBe(status.teamId);
    expect(await f.identities.listTeamIdentities()).toHaveLength(1);
  });

  it('retires the canonical identity on discard without reviving it on create replay', async () => {
    const f = await setup();
    const app = f.mount();
    const created = (await app.inject({ method: 'POST', url: routes.createDraft, payload })).json();
    const deleted = await app.inject({
      method: 'POST',
      url: routes.deleteDraft,
      payload: { schemaVersion: 1, ...created.identity, expectedRevision: created.revision },
    });
    expect(deleted.statusCode).toBe(200);
    expect((await f.identities.getTeamIdentity(created.identity.teamId))?.state).toBe('tombstoned');
    const replay = await app.inject({ method: 'POST', url: routes.createDraft, payload });
    expect(replay.json()).toEqual({ ...created, outcome: 'idempotent_replay' });
    expect((await f.identities.getTeamIdentity(created.identity.teamId))?.state).toBe('tombstoned');
  });

  it('scopes known-operation status and recovery to the current actor and rejects forged host fields', async () => {
    const f = await setup();
    const app = f.mount();
    expect(
      (await app.inject({ method: 'POST', url: routes.createDraft, payload })).statusCode
    ).toBe(201);
    const query = {
      schemaVersion: 1,
      workspaceId: publicWorkspaceId,
      idempotencyKey: payload.idempotencyKey,
    };
    const status = (
      await app.inject({ method: 'POST', url: routes.getPublication, payload: query })
    ).json();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: routes.getPublication,
          payload: { ...query, actorId },
        })
      ).statusCode
    ).toBe(400);
    f.signInOtherUser();
    expect(
      (await app.inject({ method: 'POST', url: routes.getPublication, payload: query })).statusCode
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: routes.recoverPublication,
          payload: {
            schemaVersion: 1,
            workspaceId: publicWorkspaceId,
            operationId: status.publication.operationId,
          },
        })
      ).statusCode
    ).toBe(404);
    expect(await f.identities.listTeamIdentities()).toHaveLength(1);
  });

  it('rolls back draft and create key if atomic publication-intent insertion fails', async () => {
    const f = await setup();
    const db = new Database(f.databasePath);
    try {
      db.exec(`CREATE TRIGGER fail_publication BEFORE INSERT ON hosted_team_configuration_publications
        BEGIN SELECT RAISE(ABORT, 'fixture crash'); END`);
      const response = await f.mount().inject({ method: 'POST', url: routes.createDraft, payload });
      expect(response.statusCode).toBe(503);
      expect(
        db.prepare('SELECT count(*) AS n FROM hosted_team_configuration_drafts').get()
      ).toEqual({ n: 0 });
      expect(
        db.prepare('SELECT count(*) AS n FROM hosted_team_configuration_create_keys').get()
      ).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('does not advertise configuration while canonical publication admission is unavailable', async () => {
    const f = await setup();
    const response = await f
      .mount(null)
      .inject({ method: 'POST', url: routes.createDraft, payload });
    expect(response.statusCode).toBe(503);
    expect(await f.identities.listTeamIdentities()).toEqual([]);
  });
  it('admits the current v30 writer with live WAL and observes later commits through read-only snapshots', async () => {
    const f = await setup();
    expect(await fs.stat(`${f.databasePath}-wal`)).toMatchObject({});
    expect(
      await createTeamLifecycleReadOnlyIdentitySource({ appDataRoot: f.appDataRoot })
    ).toBeNull();
    const db = new Database(f.databasePath, { readonly: true, fileMustExist: true });
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(30);
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      const raw = db.serialize();
      expect([...raw.subarray(18, 20)]).toEqual([2, 2]);
      const detached = Buffer.from(await f.publication.identityReadSource.readSnapshot());
      const expectedImage = Buffer.from(raw);
      expectedImage[18] = 1;
      expectedImage[19] = 1;
      expect(detached).toEqual(expectedImage); // Every schema/data page stays intact.
      const snapshot = new Database(detached, { readonly: true });
      try {
        expect(snapshot.readonly).toBe(true);
        expect(snapshot.memory).toBe(true);
        expect(snapshot.pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
        const objects = snapshot
          .prepare(
            `SELECT type, name, tbl_name, sql FROM sqlite_schema
          WHERE tbl_name IN ('legacy_team_key_reservations', 'team_adoption_intents',
            'team_identity_records', 'team_identity_storage_metadata') ORDER BY type, name, tbl_name`
          )
          .all();
        const projection = normalizeCurrentTeamIdentitySchema(
          objects as Parameters<typeof normalizeCurrentTeamIdentitySchema>[0],
          snapshot.pragma('user_version', { simple: true })
        );
        expect(projection).toHaveLength(23);
        expect(createHash('sha256').update(JSON.stringify(projection)).digest('hex')).toBe(
          '570be2f0773d8768848f2bef11c3cd70129199ac86730b055980fc46b90fdf36'
        );
      } finally {
        snapshot.close();
      }
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect([...db.serialize().subarray(18, 20)]).toEqual([2, 2]);
      expect(
        db
          .prepare("SELECT sql FROM sqlite_schema WHERE name = 'trg_team_identity_transition'")
          .get()
      ).toMatchObject({
        sql: expect.stringContaining("OLD.state = 'reserved' AND NEW.state = 'adoption_prepared'"),
      });
      const created = (
        await f.mount().inject({ method: 'POST', url: routes.createDraft, payload })
      ).json();
      expect(await f.canonicalReader.getTeamIdentity(created.identity.teamId)).toMatchObject({
        state: 'active',
      });
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect((await fs.stat(`${f.databasePath}-wal`)).size).toBeGreaterThan(0);
      const reader = new InternalStorageWorkerCore({
        databasePath: f.databasePath,
        mode: 'team-identity-read-only',
        createDatabase: (file, options) => {
          const connection = new Database(file, options);
          expect(connection.readonly).toBe(true);
          return connection;
        },
      });
      try {
        expect(
          reader.handle('teamIdentity.get', { teamId: created.identity.teamId })
        ).toMatchObject({ state: 'active' });
        expect(() => reader.handle('teamIdentity.reserve', {} as never)).toThrow(
          'read-only-operation-rejected'
        );
      } finally {
        reader.close();
      }
    } finally {
      db.close();
    }
  });

  it('refuses a foreign source root, a changed v29 trigger, and replacement of the retained database', async () => {
    const f = await setup();
    expect(
      await createTeamLifecycleReadOnlyIdentitySource({
        appDataRoot: f.root,
        currentWriter: f.publication.identityReadSource,
      })
    ).toBeNull();
    const db = new Database(f.databasePath);
    try {
      db.exec(`DROP TRIGGER trg_team_identity_transition;
        CREATE TRIGGER trg_team_identity_transition BEFORE UPDATE ON team_identity_records BEGIN SELECT 1; END`);
      expect(
        await createTeamLifecycleReadOnlyIdentitySource({
          appDataRoot: f.appDataRoot,
          currentWriter: f.publication.identityReadSource,
        })
      ).toBeNull();
      await expect(f.canonicalReader.listTeamIdentities()).rejects.toThrow('schema-incompatible');
    } finally {
      db.close();
    }
    await fs.rename(f.databasePath, `${f.databasePath}.retained`);
    await fs.writeFile(f.databasePath, 'foreign replacement');
    await expect(f.canonicalReader.listTeamIdentities()).rejects.toThrow(
      'canonical-database-replaced'
    );
  });

  it('keeps the pre-create grant fence when the grant rotates while storage.create is pending', async () => {
    const f = await setup();
    const create = f.storage.createHostedTeamConfiguration;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(f.storage, 'createHostedTeamConfiguration').mockImplementationOnce(async (...args) => {
      const result = await create(...args);
      entered();
      await gate;
      return result;
    });
    const app = f.mount();
    const response = app
      .inject({ method: 'POST', url: routes.createDraft, payload })
      .then((value) => value);
    try {
      await started;
      f.regrant();
      release();
      expect((await response).statusCode).toBe(503);
      expect(await f.identities.listTeamIdentities()).toEqual([]);
      expect(await fs.readdir(path.join(f.claudeRoot, 'teams'))).toEqual([]);
      const retry = await app.inject({ method: 'POST', url: routes.createDraft, payload });
      expect(retry.statusCode).toBe(201);
      expect(retry.json().outcome).toBe('idempotent_replay');
      expect(await f.canonicalReader.getTeamIdentity(retry.json().identity.teamId)).toMatchObject({
        state: 'active',
      });
    } finally {
      release();
      await response;
    }
  });

  it('checks request authority after an awaited identity read before directory allocation', async () => {
    const f = await setup();
    const get = f.identities.getTeamIdentity;
    vi.spyOn(f.identities, 'getTeamIdentity').mockImplementationOnce(async (teamId) => {
      const identity = await get(teamId);
      f.revoke(); // The pending identity read completes after the request lost authority.
      return identity;
    });
    expect(
      (await f.mount().inject({ method: 'POST', url: routes.createDraft, payload })).statusCode
    ).toBe(503);
    expect(await fs.readdir(path.join(f.claudeRoot, 'teams'))).toEqual([]);
    expect(await f.identities.listTeamIdentities()).toEqual([]);
  });

  it.each(['published', 'unfinished'] as const)(
    'rejects actor B delete and original-key replay of actor A %s operation',
    async (state) => {
      const f = await setup();
      const app = f.mount(
        state === 'unfinished'
          ? {
              ...f.publication,
              publisher: {
                ...f.publication.publisher,
                publishDraft: async () => ({ kind: 'recovery_required' }),
              },
            }
          : f.publication
      );
      const first = await app.inject({ method: 'POST', url: routes.createDraft, payload });
      expect(first.statusCode).toBe(state === 'published' ? 201 : 503);
      const db = new Database(f.databasePath, { readonly: true });
      try {
        const draft = db
          .prepare('SELECT team_id, revision_token, state FROM hosted_team_configuration_drafts')
          .get() as { team_id: string; revision_token: string; state: string };
        const before = db.prepare('SELECT * FROM hosted_team_configuration_publications').get();
        f.signInOtherUser();
        const replay = await app.inject({ method: 'POST', url: routes.createDraft, payload });
        expect(replay.statusCode).toBe(503);
        const removed = await app.inject({
          method: 'POST',
          url: routes.deleteDraft,
          payload: {
            schemaVersion: 1,
            workspaceId: publicWorkspaceId,
            teamId: draft.team_id,
            expectedRevision: draft.revision_token,
          },
        });
        expect(removed.statusCode).toBe(503);
        expect(db.prepare('SELECT state FROM hosted_team_configuration_drafts').get()).toEqual({
          state: 'active',
        });
        expect(db.prepare('SELECT * FROM hosted_team_configuration_publications').get()).toEqual(
          before
        );
        expect(
          (await f.canonicalReader.listTeamIdentities()).map((identity) => identity.state)
        ).toEqual(state === 'published' ? ['active'] : []);
        f.signInOriginalUser();
        const ownerApp = f.mount();
        expect(
          (
            await ownerApp.inject({
              method: 'POST',
              url: routes.deleteDraft,
              payload: {
                schemaVersion: 1,
                workspaceId: publicWorkspaceId,
                teamId: draft.team_id,
                expectedRevision: draft.revision_token,
              },
            })
          ).statusCode
        ).toBe(200);
        expect(
          (await f.canonicalReader.listTeamIdentities()).map((identity) => identity.state)
        ).toEqual(state === 'published' ? ['tombstoned'] : []);
      } finally {
        db.close();
      }
    }
  );

  it("preserves another authorized actor's genuine legacy create replay and deletion", async () => {
    const f = await setup();
    const create = f.storage.createHostedTeamConfiguration;
    // Seed the released request path: durable draft and key, no publication intent.
    vi.spyOn(f.storage, 'createHostedTeamConfiguration').mockImplementationOnce(
      (request, options) => {
        const { publicationBinding: _binding, ...legacy } = request;
        return create(legacy, options);
      }
    );
    const app = f.mount();
    const original = (
      await app.inject({ method: 'POST', url: routes.createDraft, payload })
    ).json();
    f.signInOtherUser();
    expect((await app.inject({ method: 'POST', url: routes.createDraft, payload })).json()).toEqual(
      { ...original, outcome: 'idempotent_replay' }
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: routes.deleteDraft,
          payload: { schemaVersion: 1, ...original.identity, expectedRevision: original.revision },
        })
      ).statusCode
    ).toBe(200);
    expect(await f.canonicalReader.listTeamIdentities()).toEqual([]);
  });
});
