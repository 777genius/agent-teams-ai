// @vitest-environment node
/**
 * Standalone HTTP integration for the custom-team-templates feature.
 *
 * These tests drive the real supported composition boundary —
 * `createCustomTeamTemplatesFeature` plus `registerCustomTeamTemplatesHttp` on
 * a real Fastify instance — against real isolated SQLite persistence (the same
 * `InternalStorageWorkerCore` + better-sqlite3 storage the worker thread runs,
 * with the Node-ABI driver injected because the Electron-ABI bundle is
 * unavailable under vitest). No in-memory fake stands in for the
 * persistence-across-restart assertion.
 *
 * `src/main/standalone.ts` itself is not imported: it binds ports, installs
 * signal handlers and calls `process.exit` on shutdown, none of which belongs
 * in a test process. What is covered here is the exact composition it performs
 * (internal-storage backend -> feature -> HTTP routes) and the lifecycle it
 * implements (probe, serve, dispose in order).
 */
import {
  type CreateCustomTeamTemplateRecordResult,
  CUSTOM_TEAM_TEMPLATE_ROUTES,
  type CustomTeamTemplateV1,
  type DeleteCustomTeamTemplateRecordResult,
  type ListCustomTeamTemplateRecordsResult,
  type ReadCustomTeamTemplateRecordResult,
  type UpdateCustomTeamTemplateRecordResult,
} from '@features/custom-team-templates/contracts';
import { registerCustomTeamTemplatesHttp } from '@features/custom-team-templates/main/adapters/input/http/registerCustomTeamTemplatesHttp';
import {
  createCustomTeamTemplatesFeature,
  type CustomTeamTemplatesFeature,
} from '@features/custom-team-templates/main/composition/createCustomTeamTemplatesFeature';
import { applyCustomTeamTemplate } from '@features/custom-team-templates/renderer/templateDraft';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { TeamDataService } from '@main/services/team/TeamDataService';
import { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { buildInitialRosterMemberDrafts } from '@renderer/components/team/dialogs/createTeamInitialRoster';
import { buildMembersFromDrafts } from '@renderer/components/team/members/membersEditorUtils';
import Database from 'better-sqlite3-node';
import Fastify from 'fastify';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import type { CustomTeamTemplateStorageGateway } from '@features/custom-team-templates/core/application/ports';
import type { FastifyInstance } from 'fastify';

const TEAM = 'alpha-team';

/** Deterministic snapshot reader: one readable team, everything else absent. */
function reader() {
  return {
    readSnapshot: (sourceTeamName: string) =>
      sourceTeamName === TEAM
        ? Promise.resolve({
            status: 'available',
            snapshot: {
              sourceTeamName: TEAM,
              teamPrompt: 'Deliver the feature.',
              roster: { status: 'readable', members: [{ name: 'alice' }] } as const,
            },
            revision: 'revision-1',
          } as const)
        : Promise.resolve({ status: 'sourceUnavailable', sourceTeamName } as const),
  };
}

/**
 * Gateway over the real SQLite core. In production this exact storage code
 * runs behind the worker thread (`InternalStorageWorkerClient`); the thread is
 * only a transport, so calling the core directly exercises the same
 * persistence without requiring the Electron worker bundle.
 */
function sqliteGateway(core: InternalStorageWorkerCore): CustomTeamTemplateStorageGateway {
  return {
    customTeamTemplateCreate: (request) =>
      Promise.resolve(
        core.handle('customTemplate.create', request) as CreateCustomTeamTemplateRecordResult
      ),
    customTeamTemplateList: () =>
      Promise.resolve(
        core.handle('customTemplate.list', {}) as ListCustomTeamTemplateRecordsResult
      ),
    customTeamTemplateGetById: (request) =>
      Promise.resolve(
        core.handle('customTemplate.getById', request) as ReadCustomTeamTemplateRecordResult
      ),
    customTeamTemplateUpdate: (request) =>
      Promise.resolve(
        core.handle('customTemplate.update', request) as UpdateCustomTeamTemplateRecordResult
      ),
    customTeamTemplateDelete: (request) =>
      Promise.resolve(
        core.handle('customTemplate.delete', request) as DeleteCustomTeamTemplateRecordResult
      ),
  };
}

function sqliteFeature(
  core: InternalStorageWorkerCore,
  seed = 0
): { feature: CustomTeamTemplatesFeature; nextToken: () => string } {
  let issued = seed;
  const feature = createCustomTeamTemplatesFeature({
    backend: { gateway: sqliteGateway(core) },
    snapshotReader: reader(),
    now: () => 0,
    createPreviewToken: () => `token-${++issued}`,
  });
  return { feature, nextToken: () => `token-${issued + 1}` };
}

async function prepareAndSave(
  app: FastifyInstance,
  name: string
): Promise<{ previewToken: string; templateId: string }> {
  const prepared = await app.inject({
    method: 'POST',
    url: CUSTOM_TEAM_TEMPLATE_ROUTES.preparePreview,
    payload: { sourceTeamName: TEAM, name },
  });
  const preparedBody = prepared.json();
  expect(preparedBody.status).toBe('previewReady');
  const previewToken = preparedBody.preview?.previewToken;
  expect(previewToken).toBeTruthy();

  const saved = await app.inject({
    method: 'POST',
    url: CUSTOM_TEAM_TEMPLATE_ROUTES.saveTemplate,
    payload: { previewToken },
  });
  const savedBody = saved.json();
  expect(savedBody.status).toBe('created');
  return { previewToken: previewToken ?? '', templateId: savedBody.template?.templateId ?? '' };
}

describe('standalone custom-team-templates HTTP integration', () => {
  let tmpDir: string | null = null;
  const cores: InternalStorageWorkerCore[] = [];
  const apps: FastifyInstance[] = [];
  const features: CustomTeamTemplatesFeature[] = [];

  function trackCore(databasePath: string): InternalStorageWorkerCore {
    const core = new InternalStorageWorkerCore({
      databasePath,
      createDatabase: (file) => new Database(file),
    });
    core.handle('ping', {});
    cores.push(core);
    return core;
  }

  function serve(feature: CustomTeamTemplatesFeature): FastifyInstance {
    const app = Fastify();
    // A pre-existing standalone route keeps working alongside the four
    // custom-template routes registered by the same composition.
    app.get('/api/standalone-health', () => Promise.resolve({ status: 'ok' }));
    registerCustomTeamTemplatesHttp(app, feature);
    features.push(feature);
    apps.push(app);
    return app;
  }

  afterEach(async () => {
    for (const app of apps.splice(0)) {
      try {
        await app.close();
      } catch {
        // already closed
      }
    }
    for (const feature of features.splice(0)) {
      try {
        feature.dispose();
        // Disposal is idempotent: previews stay forgotten, never resurrected.
        feature.dispose();
      } catch {
        // dispose must never throw
      }
    }
    for (const core of cores.splice(0)) {
      try {
        core.close();
      } catch {
        // already closed
      }
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('registers all four custom-template routes and preserves existing standalone routes', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'standalone-templates-'));
    tmpDir = tmp;
    const core = trackCore(path.join(tmp, 'storage', 'app.db'));
    const { feature } = sqliteFeature(core);
    const app = serve(feature);

    const health = await app.inject({ method: 'GET', url: '/api/standalone-health' });
    expect(health.json()).toEqual({ status: 'ok' });

    // printRoutes renders a tree where each segment is a separate node
    // (`.../custom-team-templates/prepare-preview (POST)` etc.), so assert
    // the leaf segments with their methods rather than full paths.
    const routes = app.printRoutes().replace(/[^A-Za-z0-9/_-]/g, '');
    expect(routes).toContain('custom-team-templates');
    expect(routes).toContain('prepare-previewPOST');
    expect(routes).toContain('savePOST');
    expect(routes).toContain('recheck-savePOST');
    expect(routes).toContain('listGETHEAD');

    // The full prepare -> save -> re-check -> list flow works over HTTP.
    const { previewToken, templateId } = await prepareAndSave(app, 'Release Pipeline');
    expect(templateId).toBeTruthy();

    const rechecked = await app.inject({
      method: 'POST',
      url: CUSTOM_TEAM_TEMPLATE_ROUTES.recheckSave,
      payload: { previewToken },
    });
    expect(rechecked.json()).toMatchObject({ status: 'saved' });

    const listed = await app.inject({
      method: 'GET',
      url: CUSTOM_TEAM_TEMPLATE_ROUTES.listTemplates,
    });
    expect(listed.json()).toMatchObject({
      status: 'ready',
      templates: [{ templateId, name: 'Release Pipeline' }],
    });

    // Existing routes are unaffected by the template flow.
    expect((await app.inject({ method: 'GET', url: '/api/standalone-health' })).json()).toEqual({
      status: 'ok',
    });
  });

  it('persists a valid update larger than 1 MiB and rejects stale edits across reopening', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'standalone-templates-large-update-'));
    const dbPath = path.join(tmpDir, 'storage', 'app.db');
    const core = trackCore(dbPath);
    const first = sqliteFeature(core);
    const app = serve(first.feature);
    const { templateId } = await prepareAndSave(app, 'Release Pipeline');
    const before = await app.inject({ method: 'GET', url: CUSTOM_TEAM_TEMPLATE_ROUTES.listTemplates });
    const original = before.json().templates[0] as CustomTeamTemplateV1;
    expect(original.revision).toBe(1);
    const fields = {
      name: 'Large release pipeline',
      description: 'Six independently bounded workflows',
      teamPrompt: 'Deliver the updated feature.',
      members: Array.from({ length: 6 }, (_, index) => ({
        name: `member-${index}`,
        role: 'Engineer',
        workflow: `${index}:` + 'w'.repeat(190_000),
      })),
    };
    const payload = JSON.stringify({ templateId, expectedRevision: 1, fields });
    expect(Buffer.byteLength(payload, 'utf8')).toBeGreaterThan(1024 * 1024);

    const updated = await app.inject({
      method: 'POST',
      url: CUSTOM_TEAM_TEMPLATE_ROUTES.updateTemplate,
      headers: { 'content-type': 'application/json' },
      payload,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({
      status: 'updated',
      template: {
        templateId,
        ...fields,
        schemaVersion: 1,
        createdAt: original.createdAt,
        revision: 2,
      },
    });
    const persisted = updated.json().template as CustomTeamTemplateV1;
    const listed = await app.inject({ method: 'GET', url: CUSTOM_TEAM_TEMPLATE_ROUTES.listTemplates });
    expect(listed.json()).toEqual({ status: 'ready', templates: [persisted] });

    await app.close();
    first.feature.dispose();
    core.close();
    const reopened = serve(sqliteFeature(trackCore(dbPath), 100).feature);
    const readBack = await reopened.inject({
      method: 'GET',
      url: CUSTOM_TEAM_TEMPLATE_ROUTES.listTemplates,
    });
    expect(readBack.json()).toEqual({ status: 'ready', templates: [persisted] });

    const stale = await reopened.inject({
      method: 'POST',
      url: CUSTOM_TEAM_TEMPLATE_ROUTES.updateTemplate,
      payload: { templateId, expectedRevision: 1, fields: { ...fields, teamPrompt: 'Stale edit' } },
    });
    expect(stale.json()).toEqual({ status: 'revisionConflict', current: persisted });
    const afterStale = await reopened.inject({
      method: 'GET',
      url: CUSTOM_TEAM_TEMPLATE_ROUTES.listTemplates,
    });
    expect(afterStale.json()).toEqual({ status: 'ready', templates: [persisted] });
  });

  it('persists templates across restart without duplicating records', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'standalone-templates-restart-'));
    const dbPath = path.join(tmpDir, 'storage', 'app.db');

    // First standalone instance: create a template through the HTTP endpoints.
    const coreOne = trackCore(dbPath);
    const first = sqliteFeature(coreOne);
    const appOne = serve(first.feature);
    const { templateId } = await prepareAndSave(appOne, 'Release Pipeline');

    const listedBefore = await appOne.inject({
      method: 'GET',
      url: CUSTOM_TEAM_TEMPLATE_ROUTES.listTemplates,
    });
    expect(listedBefore.json()).toMatchObject({ status: 'ready', templates: [{ templateId }] });

    // Normal lifecycle shutdown: HTTP server closed, feature previews dropped,
    // SQLite worker connection closed — in the order standalone.ts uses.
    await appOne.close();
    first.feature.dispose();
    coreOne.close();

    // Fresh instance against the same application data directory.
    const coreTwo = trackCore(dbPath);
    const second = sqliteFeature(coreTwo, 100);
    const appTwo = serve(second.feature);

    const listedAfter = await appTwo.inject({
      method: 'GET',
      url: CUSTOM_TEAM_TEMPLATE_ROUTES.listTemplates,
    });
    const body = listedAfter.json();
    expect(body.status).toBe('ready');
    expect(body.templates).toHaveLength(1);
    expect(body.templates[0]).toMatchObject({ templateId, name: 'Release Pipeline' });

    // The restarted instance still enforces name uniqueness against rows that
    // were persisted before the restart.
    const conflicted = await appTwo.inject({
      method: 'POST',
      url: CUSTOM_TEAM_TEMPLATE_ROUTES.preparePreview,
      payload: { sourceTeamName: TEAM, name: 'Release Pipeline' },
    });
    expect(conflicted.json()).toEqual({ status: 'nameConflict', existingTemplateId: templateId });

    // Retrying a save with the same token is idempotent, not a duplicate row.
    const prepared = await appTwo.inject({
      method: 'POST',
      url: CUSTOM_TEAM_TEMPLATE_ROUTES.preparePreview,
      payload: { sourceTeamName: TEAM, name: 'Release Pipeline copy' },
    });
    expect(prepared.json()).toMatchObject({ status: 'previewReady' });
    const retryToken = prepared.json().preview.previewToken;
    const firstSave = await appTwo.inject({
      method: 'POST',
      url: CUSTOM_TEAM_TEMPLATE_ROUTES.saveTemplate,
      payload: { previewToken: retryToken },
    });
    expect(firstSave.json()).toMatchObject({ status: 'created' });
    const retrySave = await appTwo.inject({
      method: 'POST',
      url: CUSTOM_TEAM_TEMPLATE_ROUTES.saveTemplate,
      payload: { previewToken: retryToken },
    });
    expect(retrySave.json()).toMatchObject({
      status: 'alreadySaved',
      template: { templateId: firstSave.json().template.templateId },
    });
    const listedAgain = await appTwo.inject({
      method: 'GET',
      url: CUSTOM_TEAM_TEMPLATE_ROUTES.listTemplates,
    });
    expect(listedAgain.json().templates).toHaveLength(2);
  });

  // Fails if creation reuses source/runtime identity, shares mutable state, or changes the template.
  it('creates independent config-only teams from a saved template', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-saved-template-creation-'));
    const claudeRoot = path.join(tmpDir, 'claude');
    const project = path.join(tmpDir, 'TEST-project');
    await fs.mkdir(project, { recursive: true });
    setClaudeBasePathOverride(claudeRoot);
    try {
      const service = new TeamDataService();
      await service.createTeamConfig({
        teamName: TEAM,
        cwd: project,
        prompt: 'Deliver the feature.',
        members: [{ name: 'alice', role: 'Engineer', workflow: 'Build the feature.' }],
      });
      const sourceDirectory = path.join(claudeRoot, 'teams', TEAM);
      const sourceMembersPath = path.join(sourceDirectory, 'members.meta.json');
      const membersStore = new TeamMembersMetaStore();
      const sourceRoster = await membersStore.getMembers(TEAM);
      await membersStore.writeMembers(
        TEAM,
        sourceRoster.map((member) => ({ ...member, agentId: `alice@${TEAM}` }))
      );
      const sourceMembersBefore = await fs.readFile(sourceMembersPath, 'utf8');
      await fs.writeFile(
        path.join(claudeRoot, 'tasks', TEAM, 'source-task.json'),
        JSON.stringify({ id: 'source-task', subject: 'Source-only task', status: 'pending' })
      );
      await fs.writeFile(
        path.join(sourceDirectory, 'inboxes', 'alice.json'),
        JSON.stringify([{ from: 'team-lead', text: 'Source-only history' }])
      );
      await fs.writeFile(
        path.join(sourceDirectory, 'launch-state.json'),
        JSON.stringify({ runId: 'source-only-run', leadSessionId: 'source-only-session' })
      );

      const core = trackCore(path.join(tmpDir, 'storage', 'app.db'));
      // Use the real saved-file snapshot reader, not this file's deterministic reader fixture.
      const feature = createCustomTeamTemplatesFeature({
        backend: { gateway: sqliteGateway(core) },
      });
      const app = serve(feature);
      const { templateId } = await prepareAndSave(app, 'Reusable engineering');
      const list = await app.inject({
        method: 'GET',
        url: CUSTOM_TEAM_TEMPLATE_ROUTES.listTemplates,
      });
      const { templates } = list.json<{ templates: CustomTeamTemplateV1[] }>();
      expect(templates).toHaveLength(1);
      const template = templates[0];
      expect(template).toMatchObject({
        templateId,
        teamPrompt: 'Deliver the feature.',
        members: [{ name: 'alice', role: 'Engineer', workflow: 'Build the feature.' }],
      });
      expect(Object.keys(template.members[0]).sort()).toEqual(['name', 'role', 'workflow']);

      const teamNames = ['template-draft-a', 'template-draft-b'];
      const uiMemberIds = new Set<string>();
      for (const teamName of teamNames) {
        const draft = applyCustomTeamTemplate(template);
        const roster = buildInitialRosterMemberDrafts({
          copiedMembers: draft.members,
          multimodelEnabled: true,
        });
        expect(uiMemberIds.has(roster[0].id)).toBe(false);
        uiMemberIds.add(roster[0].id);
        await service.createTeamConfig({
          ...draft,
          teamName,
          cwd: project,
          members: buildMembersFromDrafts(roster, { inheritedProviderId: undefined }),
        });
        expect(await service.getSavedRequest(teamName)).toMatchObject({
          teamName,
          cwd: project,
          prompt: 'Deliver the feature.',
          runtimeSelectionVersion: 1,
          members: [{ name: 'alice', role: 'Engineer', workflow: 'Build the feature.' }],
        });
        const directory = path.join(claudeRoot, 'teams', teamName);
        // A draft has no CLI config, session, launch state or copied inbox/task payload.
        expect((await fs.readdir(directory)).sort()).toEqual([
          'inboxes',
          'members.meta.json',
          'team.meta.json',
        ]);
        expect(await fs.readdir(path.join(directory, 'inboxes'))).toEqual([]);
        expect(await fs.readdir(path.join(claudeRoot, 'tasks', teamName))).toEqual([]);
        const members = await membersStore.getMembers(teamName);
        expect(members).toHaveLength(1);
        expect(members[0].agentId).toBeUndefined();
        const metadata = JSON.parse(
          await fs.readFile(path.join(directory, 'team.meta.json'), 'utf8')
        );
        expect(metadata).not.toHaveProperty('launchIdentity');
        expect(metadata).not.toHaveProperty('leadSessionId');
        expect(metadata).not.toHaveProperty('templateId');
      }

      await service.updateMemberRole(teamNames[0], 'alice', 'Independent editor');
      expect((await service.getSavedRequest(teamNames[0]))?.members[0].role).toBe(
        'Independent editor'
      );
      expect((await service.getSavedRequest(teamNames[1]))?.members[0].role).toBe('Engineer');
      expect(await fs.readFile(sourceMembersPath, 'utf8')).toBe(sourceMembersBefore);
      const after = await app.inject({
        method: 'GET',
        url: CUSTOM_TEAM_TEMPLATE_ROUTES.listTemplates,
      });
      expect(after.json()).toMatchObject({ status: 'ready', templates });
      expect(after.json().templates).toEqual(templates);
    } finally {
      setClaudeBasePathOverride(null);
    }
  });

  it('reports unavailable storage instead of false success when the backend is missing', async () => {
    // Mirrors standalone startup with an unavailable worker bundle: the
    // feature is composed with a null backend and must stay honest.
    const feature = createCustomTeamTemplatesFeature({
      backend: null,
      snapshotReader: reader(),
      now: () => 0,
      createPreviewToken: () => 'token-1',
    });
    const app = serve(feature);

    const prepared = await app.inject({
      method: 'POST',
      url: CUSTOM_TEAM_TEMPLATE_ROUTES.preparePreview,
      payload: { sourceTeamName: TEAM, name: 'Release Pipeline' },
    });
    expect(prepared.json()).toEqual({ status: 'storageUnavailable' });

    const saved = await app.inject({
      method: 'POST',
      url: CUSTOM_TEAM_TEMPLATE_ROUTES.saveTemplate,
      payload: { previewToken: 'token-unknown' },
    });
    // No preview was ever issued, so the token is unknown — never a success.
    expect(saved.json()).toMatchObject({ status: 'validationFailed' });

    const listed = await app.inject({
      method: 'GET',
      url: CUSTOM_TEAM_TEMPLATE_ROUTES.listTemplates,
    });
    expect(listed.json()).toEqual({ status: 'storageUnavailable' });

    // Shutdown on the failure path disposes cleanly without throwing.
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    feature.dispose();
    features.splice(features.indexOf(feature), 1);
  });

  it('stops the HTTP server and drops retained previews on shutdown without leaking', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'standalone-templates-shutdown-'));
    const core = trackCore(path.join(tmpDir, 'storage', 'app.db'));
    const { feature } = sqliteFeature(core);
    const app = serve(feature);

    const prepared = await app.inject({
      method: 'POST',
      url: CUSTOM_TEAM_TEMPLATE_ROUTES.preparePreview,
      payload: { sourceTeamName: TEAM, name: 'Release Pipeline' },
    });
    const token = prepared.json().preview?.previewToken;
    expect(token).toBeTruthy();

    // Shutdown: server first, then feature state, then storage — as in
    // standalone.ts. Disposing the feature forgets the retained preview.
    const recheckRoute = CUSTOM_TEAM_TEMPLATE_ROUTES.recheckSave;
    const beforeDispose = await app.inject({
      method: 'POST',
      url: recheckRoute,
      payload: { previewToken: token },
    });
    // Nothing was saved, but the submitted operation is still known.
    expect(beforeDispose.json()).toMatchObject({ status: 'notSaved' });

    feature.dispose();
    const afterDispose = await app.inject({
      method: 'POST',
      url: recheckRoute,
      payload: { previewToken: token },
    });
    expect(afterDispose.json()).toMatchObject({ status: 'validationFailed' });

    await app.close();
    apps.splice(apps.indexOf(app), 1);
    features.splice(features.indexOf(feature), 1);
    core.close();

    // A fresh feature over the same database has no retained previews: the
    // old token is unknown rather than resurrected.
    const coreTwo = trackCore(path.join(tmpDir, 'storage', 'app.db'));
    const second = sqliteFeature(coreTwo, 50);
    const appTwo = serve(second.feature);
    const rechecked = await appTwo.inject({
      method: 'POST',
      url: CUSTOM_TEAM_TEMPLATE_ROUTES.recheckSave,
      payload: { previewToken: token },
    });
    expect(rechecked.json()).toMatchObject({ status: 'validationFailed' });
  });
});
