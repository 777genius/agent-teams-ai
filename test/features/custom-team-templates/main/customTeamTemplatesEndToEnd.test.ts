import { CustomTeamTemplateStorageInterruptedError } from '@features/custom-team-templates/core/application/CustomTeamTemplateStorageInterruptedError';
import { serializeCanonicalTemplateContent } from '@features/custom-team-templates/core/domain/canonicalTemplateSerialization';
import { normalizeTemplateNameKey } from '@features/custom-team-templates/core/domain/templateNamePolicy';
// Imported through the feature's public main entrypoint: this is the exact
// surface the future IPC and HTTP adapters consume.
import { createCustomTeamTemplatesFeature } from '@features/custom-team-templates/main';
import { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ teamsBase: '' }));

vi.mock('@main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => hoisted.teamsBase,
}));

import type {
  CreateCustomTeamTemplateRecordRequest,
  CustomTeamTemplateV1,
} from '@features/custom-team-templates/contracts';
import type { CustomTeamTemplateStorageGateway } from '@features/custom-team-templates/core/application/ports';
import type { TeamMember } from '@shared/types';

const TEAM = 'alpha-team';

/** In-memory stand-in for the Phase 2A store, with the same id/name invariants. */
function fakeLibrary() {
  const rows = new Map<string, CustomTeamTemplateV1>();
  const requests: CreateCustomTeamTemplateRecordRequest[] = [];
  const gateway: CustomTeamTemplateStorageGateway = {
    customTeamTemplateCreate: (request) => {
      requests.push(request);
      const existing = rows.get(request.template.templateId);
      if (existing) {
        return Promise.resolve({ status: 'alreadySaved', template: existing });
      }
      const nameTaken = [...rows.values()].find(
        (row) =>
          normalizeTemplateNameKey(row.name) === normalizeTemplateNameKey(request.template.name)
      );
      if (nameTaken) {
        return Promise.resolve({
          status: 'conflict',
          reason: 'nameTaken',
          existingTemplateId: nameTaken.templateId,
        });
      }
      const template: CustomTeamTemplateV1 = {
        ...request.template,
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      rows.set(template.templateId, template);
      return Promise.resolve({ status: 'created', template });
    },
    customTeamTemplateList: () =>
      Promise.resolve({ templates: [...rows.values()], unreadableRecords: [] }),
    customTeamTemplateGetById: ({ templateId }) => {
      const found = rows.get(templateId);
      return Promise.resolve(found ? { status: 'found', template: found } : { status: 'notFound' });
    },
  };
  return { gateway, requests, rows };
}

describe('custom team templates end to end', () => {
  let tempDir = '';
  let issued = 0;

  const feature = (library: ReturnType<typeof fakeLibrary>) =>
    createCustomTeamTemplatesFeature({
      backend: { gateway: library.gateway },
      now: () => 0,
      createPreviewToken: () => `token-${++issued}`,
    });

  async function writeTeam(
    members: readonly Partial<TeamMember>[],
    prompt = 'Deliver the feature.'
  ): Promise<void> {
    const directory = path.join(hoisted.teamsBase, TEAM);
    await fs.mkdir(directory, { recursive: true });
    await new TeamMetaStore().writeMeta(TEAM, {
      cwd: '/projects/example',
      prompt,
      createdAt: Date.now(),
    });
    await new TeamMembersMetaStore().writeMembers(
      TEAM,
      members.map((member) => ({ name: 'unnamed', ...member }) as TeamMember)
    );
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-template-e2e-'));
    hoisted.teamsBase = path.join(tempDir, 'teams');
    await fs.mkdir(hoisted.teamsBase, { recursive: true });
    issued = 0;
  });

  afterEach(async () => {
    hoisted.teamsBase = '';
    vi.restoreAllMocks();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('previews a real saved team, then saves it idempotently', async () => {
    await writeTeam([
      { name: 'team-lead', agentType: 'team-lead', role: 'Lead' },
      { name: 'alice', role: 'reviewer', workflow: 'Review each change.' },
      { name: 'bob', workflow: 'Build the feature.' },
      { name: 'carol', role: 'writer', removedAt: Date.now() },
    ]);

    const library = fakeLibrary();
    const app = feature(library);

    const prepared = await app.preparePreview.execute({
      sourceTeamName: TEAM,
      name: '  Release Pipeline ',
      description: '  Weekly release  ',
    });
    expect(prepared.status).toBe('previewReady');
    if (prepared.status !== 'previewReady') return;

    expect(prepared.preview.name).toBe('Release Pipeline');
    expect(prepared.preview.description).toBe('Weekly release');
    expect(prepared.preview.teamPrompt).toBe('Deliver the feature.');
    expect(prepared.preview.members).toEqual([
      { name: 'alice', role: 'reviewer', workflow: 'Review each change.' },
      { name: 'bob', workflow: 'Build the feature.' },
    ]);
    expect(prepared.preview.warnings).toEqual([
      { code: 'missingMemberRole', memberName: 'bob' },
      { code: 'removedMembersExcluded', count: 1 },
    ]);
    expect(library.requests).toEqual([]);

    const saved = await app.saveTemplate.execute({ previewToken: prepared.preview.previewToken });
    expect(saved.status).toBe('created');
    if (saved.status !== 'created') return;

    // The persisted record is exactly the allowlisted projection, hashed from
    // the canonical content, under an id derived from the confirmed identity.
    const [request] = library.requests;
    expect(request.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(request.template).toEqual({
      templateId: saved.template.templateId,
      name: 'Release Pipeline',
      description: 'Weekly release',
      schemaVersion: 1,
      teamPrompt: 'Deliver the feature.',
      members: [
        { name: 'alice', role: 'reviewer', workflow: 'Review each change.' },
        { name: 'bob', workflow: 'Build the feature.' },
      ],
    });
    expect(request.template.templateId).toMatch(/^tmpl-[0-9a-f]{32}$/);
    expect(library.rows.size).toBe(1);

    // Confirming the same preview again is idempotent and writes nothing new.
    await expect(
      app.saveTemplate.execute({ previewToken: prepared.preview.previewToken })
    ).resolves.toEqual({ status: 'alreadySaved', template: saved.template });
    expect(library.requests).toHaveLength(2);
    expect(library.requests[1]).toEqual(library.requests[0]);
    expect(library.rows.size).toBe(1);

    await expect(app.listTemplates.execute()).resolves.toEqual({
      status: 'ready',
      templates: [saved.template],
    });
  });

  it('blocks a preview whose name already exists, and a save whose team changed', async () => {
    await writeTeam([{ name: 'alice', role: 'reviewer', workflow: 'Review.' }]);
    const library = fakeLibrary();
    const app = feature(library);

    const first = await app.preparePreview.execute({
      sourceTeamName: TEAM,
      name: 'Release Pipeline',
    });
    expect(first.status).toBe('previewReady');
    if (first.status !== 'previewReady') return;
    await app.saveTemplate.execute({ previewToken: first.preview.previewToken });

    // Case-insensitive uniqueness is enforced against the stored library.
    await expect(
      app.preparePreview.execute({ sourceTeamName: TEAM, name: '  release   PIPELINE ' })
    ).resolves.toEqual({
      status: 'nameConflict',
      existingTemplateId: library.rows.keys().next().value,
    });

    // A team change between preview and confirm must not save the new content
    // under the reviewed preview.
    const second = await app.preparePreview.execute({ sourceTeamName: TEAM, name: 'Pipeline v2' });
    expect(second.status).toBe('previewReady');
    if (second.status !== 'previewReady') return;

    await writeTeam([
      { name: 'alice', role: 'reviewer', workflow: 'Review.' },
      { name: 'dave', workflow: 'Ship it.' },
    ]);

    await expect(
      app.saveTemplate.execute({ previewToken: second.preview.previewToken })
    ).resolves.toEqual({ status: 'stalePreview', sourceTeamName: TEAM });
    expect(library.requests).toHaveLength(1);
    expect(library.rows.size).toBe(1);

    // The refreshed preview carries the new roster.
    const refreshed = await app.preparePreview.execute({
      sourceTeamName: TEAM,
      name: 'Pipeline v2',
    });
    expect(refreshed.status).toBe('previewReady');
    if (refreshed.status !== 'previewReady') return;
    expect(refreshed.preview.members).toEqual([
      { name: 'alice', role: 'reviewer', workflow: 'Review.' },
      { name: 'dave', workflow: 'Ship it.' },
    ]);
    expect(refreshed.preview.canonicalContent).toBe(
      serializeCanonicalTemplateContent({
        schemaVersion: 1,
        teamPrompt: 'Deliver the feature.',
        members: [
          { name: 'alice', role: 'reviewer', workflow: 'Review.' },
          { name: 'dave', workflow: 'Ship it.' },
        ],
      })
    );
  });

  it('refuses to template a trashed team and writes nothing', async () => {
    const directory = path.join(hoisted.teamsBase, TEAM);
    await fs.mkdir(directory, { recursive: true });
    await new TeamMetaStore().writeMeta(TEAM, {
      cwd: '/projects/example',
      prompt: 'Deliver the feature.',
      deletedAt: new Date().toISOString(),
      createdAt: Date.now(),
    });

    const library = fakeLibrary();
    const app = feature(library);

    await expect(
      app.preparePreview.execute({ sourceTeamName: TEAM, name: 'Trashed team' })
    ).resolves.toEqual({ status: 'sourceUnavailable', sourceTeamName: TEAM });
    expect(library.requests).toEqual([]);
    expect(library.rows.size).toBe(0);
  });

  it('re-checks an unresolved save by the same stable operation id', async () => {
    await writeTeam([{ name: 'alice', role: 'reviewer', workflow: 'Review.' }]);
    const library = fakeLibrary();
    let failCreate = true;
    const gateway: CustomTeamTemplateStorageGateway = {
      ...library.gateway,
      customTeamTemplateCreate: (request) => {
        if (failCreate) {
          return Promise.reject(
            new CustomTeamTemplateStorageInterruptedError(
              'worker died',
              'unknown',
              Promise.resolve()
            )
          );
        }
        return library.gateway.customTeamTemplateCreate(request);
      },
    };
    const app = createCustomTeamTemplatesFeature({
      backend: { gateway },
      now: () => 0,
      createPreviewToken: () => 'token-1',
    });

    const prepared = await app.preparePreview.execute({
      sourceTeamName: TEAM,
      name: 'Release Pipeline',
    });
    expect(prepared.status).toBe('previewReady');
    if (prepared.status !== 'previewReady') return;
    const token = prepared.preview.previewToken;

    const saved = await app.saveTemplate.execute({ previewToken: token });
    expect(saved.status).toBe('unresolvedWriteOutcome');
    if (saved.status !== 'unresolvedWriteOutcome') return;
    const { templateId } = saved;
    // Nothing reached the store, and the retained operation keeps the same id.
    expect(library.requests).toEqual([]);

    await expect(app.recheckSave.execute({ previewToken: token })).resolves.toEqual({
      status: 'notSaved',
      templateId,
    });
    // A re-check never writes: the confirmed-absence read is the whole action.
    expect(library.requests).toEqual([]);

    // The write turns out to have been possible after all: it lands once, and the
    // re-check then confirms the very same operation instead of writing again.
    failCreate = false;
    await expect(app.saveTemplate.execute({ previewToken: token })).resolves.toMatchObject({
      status: 'created',
    });
    expect(library.rows.size).toBe(1);
    await expect(app.recheckSave.execute({ previewToken: token })).resolves.toEqual({
      status: 'saved',
      template: library.rows.get(templateId),
    });

    // A different record under the same id is a conflict, never an overwrite.
    const conflicting = { ...library.rows.get(templateId)!, teamPrompt: 'Different.' };
    library.rows.set(templateId, conflicting);
    await expect(app.recheckSave.execute({ previewToken: token })).resolves.toEqual({
      status: 'templateIdConflict',
      templateId,
    });
    expect(library.rows.get(templateId)).toEqual(conflicting);
  });

  it('blocks saving entirely when the roster metadata cannot be read', async () => {
    const directory = path.join(hoisted.teamsBase, TEAM);
    await fs.mkdir(directory, { recursive: true });
    await new TeamMetaStore().writeMeta(TEAM, {
      cwd: '/projects/example',
      prompt: 'P',
      createdAt: Date.now(),
    });
    await fs.writeFile(
      path.join(directory, 'members.meta.json'),
      JSON.stringify({ version: 1, members: [{ name: 'alice' }, { role: 'reviewer' }] })
    );

    const library = fakeLibrary();
    const app = feature(library);

    await expect(
      app.preparePreview.execute({ sourceTeamName: TEAM, name: 'Broken roster' })
    ).resolves.toEqual({ status: 'rosterUnreadable', sourceTeamName: TEAM });
    expect(library.requests).toEqual([]);
  });
});
