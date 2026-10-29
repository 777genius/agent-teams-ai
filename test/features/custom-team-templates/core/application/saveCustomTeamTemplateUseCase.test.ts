import { CustomTeamTemplateStorageInterruptedError } from '@features/custom-team-templates/core/application/CustomTeamTemplateStorageInterruptedError';
import { InMemoryCustomTeamTemplatePreviewStore } from '@features/custom-team-templates/core/application/InMemoryCustomTeamTemplatePreviewStore';
import { PrepareCustomTemplatePreviewUseCase } from '@features/custom-team-templates/core/application/PrepareCustomTemplatePreviewUseCase';
import { RecheckCustomTeamTemplateSaveUseCase } from '@features/custom-team-templates/core/application/RecheckCustomTeamTemplateSaveUseCase';
import { SaveCustomTeamTemplateUseCase } from '@features/custom-team-templates/core/application/SaveCustomTeamTemplateUseCase';
import { UpdateCustomTeamTemplateUseCase } from '@features/custom-team-templates/core/application/UpdateCustomTeamTemplateUseCase';
import { STORAGE_SETTLEMENT_TIMEOUT_MS } from '@features/custom-team-templates/core/application/waitForStorageSettlement';
import { serializeCanonicalTemplateContent } from '@features/custom-team-templates/core/domain/canonicalTemplateSerialization';
import { normalizeTemplateNameKey } from '@features/custom-team-templates/core/domain/templateNamePolicy';
import { NodeCustomTeamTemplateHasher } from '@features/custom-team-templates/main/adapters/output/NodeCustomTeamTemplateHasher';
import { describe, expect, it, vi } from 'vitest';

import type {
  CreateCustomTeamTemplateRecordRequest,
  CreateCustomTeamTemplateRecordResult,
  CustomTeamTemplateV1,
} from '@features/custom-team-templates/contracts';
import type {
  CustomTeamTemplateSnapshotReader,
  CustomTeamTemplateStorageGateway,
} from '@features/custom-team-templates/core/application/ports';
import type { SaveCustomTeamTemplateUseCaseDeps } from '@features/custom-team-templates/core/application/SaveCustomTeamTemplateUseCase';

const hasher = new NodeCustomTeamTemplateHasher();
const TEAM = 'alpha-team';

const CANONICAL = serializeCanonicalTemplateContent({
  schemaVersion: 1,
  teamPrompt: 'Deliver the feature.',
  members: [{ name: 'alice', role: 'reviewer', workflow: 'Review each change.' }],
});
const CONTENT_HASH = hasher.hashCanonicalContent(CANONICAL);
/** The stable id the confirmed save must derive for the prepared preview below. */
const PREVIEW_ID = hasher.deriveTemplateId({
  contentHash: CONTENT_HASH,
  nameKey: 'release pipeline',
  description: null,
});

/** A reader that always answers with the same saved configuration unless told otherwise. */
function reader(snapshot?: {
  teamPrompt?: string;
  roster?: { status: 'absent' } | { status: 'readable'; members: [] } | { status: 'unreadable' };
  outcome?: 'sourceUnavailable' | 'configurationChanged';
}): CustomTeamTemplateSnapshotReader {
  return {
    readSnapshot: () => {
      if (snapshot?.outcome) {
        return Promise.resolve({ status: snapshot.outcome, sourceTeamName: TEAM } as const);
      }
      return Promise.resolve({
        status: 'available',
        snapshot: {
          sourceTeamName: TEAM,
          ...(snapshot?.teamPrompt === undefined
            ? { teamPrompt: 'Deliver the feature.' }
            : { teamPrompt: snapshot.teamPrompt }),
          roster:
            snapshot?.roster ??
            ({
              status: 'readable',
              members: [
                { name: 'team-lead', agentType: 'team-lead', role: 'Lead' },
                { name: 'alice', role: 'reviewer', workflow: 'Review each change.' },
              ],
            } as const),
        },
        revision: 'revision-1',
      } as const);
    },
  };
}

function storedTemplate(
  templateId = 'tmpl-1',
  overrides: Partial<CustomTeamTemplateV1> = {}
): CustomTeamTemplateV1 {
  return {
    templateId,
    name: 'Release Pipeline',
    schemaVersion: 1,
    teamPrompt: 'Deliver the feature.',
    members: [{ name: 'alice', role: 'reviewer', workflow: 'Review each change.' }],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface GatewayFixture {
  gateway: CustomTeamTemplateStorageGateway;
  create: ReturnType<typeof vi.fn>;
  getById: ReturnType<typeof vi.fn>;
  requests: CreateCustomTeamTemplateRecordRequest[];
}

function gatewayFixture(options: {
  create: (CreateCustomTeamTemplateRecordResult | Error)[];
  getById?: (
    | { status: 'found'; template: CustomTeamTemplateV1 }
    | { status: 'notFound' }
    | { status: 'unreadable'; templateId: string }
    | Error
  )[];
}): GatewayFixture {
  const requests: CreateCustomTeamTemplateRecordRequest[] = [];
  let createIndex = 0;
  let readIndex = 0;
  const create = vi.fn((request: CreateCustomTeamTemplateRecordRequest) => {
    requests.push(request);
    const outcome = options.create[Math.min(createIndex, options.create.length - 1)];
    createIndex += 1;
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  });
  const getById = vi.fn(() => {
    const outcomes = options.getById ?? [{ status: 'notFound' as const }];
    const outcome = outcomes[Math.min(readIndex, outcomes.length - 1)];
    readIndex += 1;
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  });
  return {
    gateway: {
      customTeamTemplateCreate: create,
      customTeamTemplateList: vi.fn().mockResolvedValue({ templates: [], unreadableRecords: [] }),
      customTeamTemplateGetById: getById,
      customTeamTemplateUpdate: vi.fn(),
      customTeamTemplateDelete: vi.fn(),
    },
    create,
    getById,
    requests,
  };
}

/**
 * A library stand-in with the real store's identity invariants: an id is
 * created once and kept for life, an id may only be re-used by an identical
 * write, and a display name belongs to exactly one record.
 */
function libraryFixture(): {
  gateway: CustomTeamTemplateStorageGateway;
  rows: Map<string, CustomTeamTemplateV1>;
} {
  const rows = new Map<string, CustomTeamTemplateV1>();

  const hashOf = (template: CustomTeamTemplateV1): string =>
    hasher.hashCanonicalContent(
      serializeCanonicalTemplateContent({
        schemaVersion: template.schemaVersion,
        teamPrompt: template.teamPrompt,
        members: template.members,
      })
    );
  const sameName = (left: string, right: string): boolean =>
    normalizeTemplateNameKey(left) === normalizeTemplateNameKey(right);

  return {
    rows,
    gateway: {
      customTeamTemplateCreate: (request) => {
        const existing = rows.get(request.template.templateId);
        if (existing) {
          const equivalent =
            sameName(existing.name, request.template.name) &&
            (existing.description ?? null) === (request.template.description ?? null) &&
            hashOf(existing) === request.contentHash;
          return Promise.resolve(
            equivalent
              ? { status: 'alreadySaved', template: existing }
              : {
                  status: 'conflict',
                  reason: 'idReusedWithDifferentContent',
                  existingTemplateId: existing.templateId,
                }
          );
        }
        const nameTaken = [...rows.values()].find((row) =>
          sameName(row.name, request.template.name)
        );
        if (nameTaken) {
          return Promise.resolve({
            status: 'conflict',
            reason: 'nameTaken',
            existingTemplateId: nameTaken.templateId,
          });
        }
        const created: CustomTeamTemplateV1 = {
          ...request.template,
          createdAt: '2026-01-01T00:00:00.000Z',
          revision: 1,
        };
        rows.set(created.templateId, created);
        return Promise.resolve({ status: 'created', template: created });
      },
      customTeamTemplateList: () =>
        Promise.resolve({ templates: [...rows.values()], unreadableRecords: [] }),
      customTeamTemplateGetById: ({ templateId }) => {
        const found = rows.get(templateId);
        return Promise.resolve(
          found ? { status: 'found', template: found } : { status: 'notFound' }
        );
      },
      customTeamTemplateUpdate: (request) => {
        const existing = rows.get(request.templateId);
        if (!existing) {
          return Promise.resolve({ status: 'notFound', templateId: request.templateId });
        }
        if ((existing.revision ?? 1) !== request.expectedRevision) {
          return Promise.resolve({ status: 'revisionConflict', current: existing });
        }
        const clashing = [...rows.values()].find(
          (row) =>
            row.templateId !== request.templateId && sameName(row.name, request.template.name)
        );
        if (clashing) {
          return Promise.resolve({
            status: 'conflict',
            reason: 'nameTaken',
            existingTemplateId: clashing.templateId,
          });
        }
        const updated: CustomTeamTemplateV1 = {
          ...existing,
          name: request.template.name,
          teamPrompt: request.template.teamPrompt,
          members: request.template.members,
          revision: request.expectedRevision + 1,
        };
        if (request.template.description === undefined) {
          delete updated.description;
        } else {
          updated.description = request.template.description;
        }
        rows.set(updated.templateId, updated);
        return Promise.resolve({ status: 'updated', template: updated });
      },
      customTeamTemplateDelete: () =>
        Promise.resolve({ status: 'notFound', templateId: 'tmpl-unused' }),
    },
  };
}

/** Prepares one preview and returns the token plus the store that owns it. */
async function preparedPreview(
  overrides: Partial<SaveCustomTeamTemplateUseCaseDeps> = {}
): Promise<{
  token: string;
  store: InMemoryCustomTeamTemplatePreviewStore;
  stateTemplateId: string;
}> {
  const store =
    overrides.previewStore ??
    new InMemoryCustomTeamTemplatePreviewStore({ now: () => 0, createToken: () => 'token-1' });
  const prepare = new PrepareCustomTemplatePreviewUseCase({
    gateway: overrides.gateway ?? null,
    reader: overrides.reader ?? reader(),
    hasher: overrides.hasher ?? hasher,
    previewStore: store,
  });
  const prepared = await prepare.execute({ sourceTeamName: TEAM, name: 'Release Pipeline' });
  if (prepared.status !== 'previewReady') {
    throw new Error(`preview not ready: ${prepared.status}`);
  }
  const resolved = store.resolve(prepared.preview.previewToken);
  if (resolved.status !== 'found') {
    throw new Error('preview token missing');
  }
  if (resolved.state.templateId !== PREVIEW_ID) {
    throw new Error(`unexpected preview identity: ${resolved.state.templateId}`);
  }
  return {
    token: prepared.preview.previewToken,
    store,
    stateTemplateId: resolved.state.templateId,
  };
}

function useCase(
  deps: Partial<SaveCustomTeamTemplateUseCaseDeps>,
  store: InMemoryCustomTeamTemplatePreviewStore
) {
  return new SaveCustomTeamTemplateUseCase({
    gateway: deps.gateway ?? null,
    reader: deps.reader ?? reader(),
    hasher: deps.hasher ?? hasher,
    previewStore: store,
  });
}

describe('SaveCustomTeamTemplateUseCase', () => {
  it('saves the confirmed projection under the stable preview identity', async () => {
    const fixture = gatewayFixture({ create: [{ status: 'created', template: storedTemplate() }] });
    const preview = await preparedPreview({ gateway: fixture.gateway });
    const save = new SaveCustomTeamTemplateUseCase({
      gateway: fixture.gateway,
      reader: reader(),
      hasher,
      previewStore: preview.store,
    });

    const result = await save.execute({ previewToken: preview.token });

    expect(result).toEqual({ status: 'created', template: storedTemplate() });
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(fixture.requests[0]).toEqual({
      template: {
        templateId: preview.stateTemplateId,
        name: 'Release Pipeline',
        schemaVersion: 1,
        teamPrompt: 'Deliver the feature.',
        members: [{ name: 'alice', role: 'reviewer', workflow: 'Review each change.' }],
      },
      contentHash: CONTENT_HASH,
    });
    // The token survives a confirmed save so a lost response can be retried.
    expect(preview.store.resolve(preview.token).status).toBe('found');
  });

  it('returns alreadySaved for an identical retry with the same identity', async () => {
    const fixture = gatewayFixture({
      create: [
        { status: 'created', template: storedTemplate() },
        { status: 'alreadySaved', template: storedTemplate() },
      ],
    });
    const preview = await preparedPreview({ gateway: fixture.gateway });
    const save = new SaveCustomTeamTemplateUseCase({
      gateway: fixture.gateway,
      reader: reader(),
      hasher,
      previewStore: preview.store,
    });

    await save.execute({ previewToken: preview.token });
    await expect(save.execute({ previewToken: preview.token })).resolves.toEqual({
      status: 'alreadySaved',
      template: storedTemplate(),
    });
    expect(fixture.requests[1]).toEqual(fixture.requests[0]);
  });

  it('rejects a missing, unknown or expired token without writing', async () => {
    const fixture = gatewayFixture({ create: [{ status: 'created', template: storedTemplate() }] });
    let now = 0;
    const store = new InMemoryCustomTeamTemplatePreviewStore({
      now: () => now,
      createToken: () => 'token-1',
      ttlMs: 100,
    });
    const preview = await preparedPreview({ gateway: fixture.gateway, previewStore: store });
    const save = useCase({ gateway: fixture.gateway }, store);

    await expect(save.execute({})).resolves.toEqual({
      status: 'validationFailed',
      issues: [{ code: 'previewTokenRequired', field: 'previewToken' }],
    });
    await expect(save.execute({ previewToken: '  ' })).resolves.toEqual({
      status: 'validationFailed',
      issues: [{ code: 'previewTokenRequired', field: 'previewToken' }],
    });
    await expect(save.execute({ previewToken: 'unknown-token' })).resolves.toEqual({
      status: 'validationFailed',
      issues: [{ code: 'previewTokenUnknown', field: 'previewToken' }],
    });

    now = 100;
    await expect(save.execute({ previewToken: preview.token })).resolves.toEqual({
      status: 'validationFailed',
      issues: [{ code: 'previewTokenExpired', field: 'previewToken' }],
    });
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it('uses the token team and never reinterprets it for another team', async () => {
    const asked: string[] = [];
    const readerSpy: CustomTeamTemplateSnapshotReader = {
      readSnapshot: async (sourceTeamName) => {
        asked.push(sourceTeamName);
        return reader().readSnapshot(sourceTeamName);
      },
    };
    const fixture = gatewayFixture({ create: [{ status: 'created', template: storedTemplate() }] });
    const preview = await preparedPreview({ gateway: fixture.gateway, reader: readerSpy });
    const save = useCase({ gateway: fixture.gateway, reader: readerSpy }, preview.store);

    await save.execute({ previewToken: preview.token, sourceTeamName: 'other-team' } as never);

    expect(asked).toEqual([TEAM, TEAM]);
  });

  it('reports a stale preview and forgets the token when the configuration changed', async () => {
    const fixture = gatewayFixture({ create: [{ status: 'created', template: storedTemplate() }] });
    const preview = await preparedPreview({ gateway: fixture.gateway });
    const save = useCase(
      {
        gateway: fixture.gateway,
        reader: reader({
          teamPrompt: 'Deliver the feature.',
          roster: { status: 'readable', members: [] },
        }),
      },
      preview.store
    );

    await expect(save.execute({ previewToken: preview.token })).resolves.toEqual({
      status: 'stalePreview',
      sourceTeamName: TEAM,
    });
    expect(fixture.create).not.toHaveBeenCalled();
    // The old token must not be able to save the refreshed data.
    expect(preview.store.resolve(preview.token)).toEqual({ status: 'unknown' });
  });

  it('reports a stale preview when the source is unavailable or inconsistent', async () => {
    const fixture = gatewayFixture({ create: [{ status: 'created', template: storedTemplate() }] });

    const unavailable = await preparedPreview({ gateway: fixture.gateway });
    await expect(
      useCase(
        { gateway: fixture.gateway, reader: reader({ outcome: 'sourceUnavailable' }) },
        unavailable.store
      ).execute({ previewToken: unavailable.token })
    ).resolves.toEqual({ status: 'sourceUnavailable', sourceTeamName: TEAM });

    const changed = await preparedPreview({ gateway: fixture.gateway });
    await expect(
      useCase(
        { gateway: fixture.gateway, reader: reader({ outcome: 'configurationChanged' }) },
        changed.store
      ).execute({ previewToken: changed.token })
    ).resolves.toEqual({ status: 'stalePreview', sourceTeamName: TEAM });

    expect(fixture.create).not.toHaveBeenCalled();
  });

  it('never saves from unreadable roster metadata', async () => {
    const fixture = gatewayFixture({ create: [{ status: 'created', template: storedTemplate() }] });
    const preview = await preparedPreview({ gateway: fixture.gateway });
    const save = useCase(
      { gateway: fixture.gateway, reader: reader({ roster: { status: 'unreadable' } }) },
      preview.store
    );

    await expect(save.execute({ previewToken: preview.token })).resolves.toEqual({
      status: 'rosterUnreadable',
      sourceTeamName: TEAM,
    });
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it('never writes when the storage backend is unavailable', async () => {
    const fixture = gatewayFixture({ create: [{ status: 'created', template: storedTemplate() }] });
    const preview = await preparedPreview({ gateway: fixture.gateway });
    const save = useCase({ gateway: null }, preview.store);

    await expect(save.execute({ previewToken: preview.token })).resolves.toEqual({
      status: 'storageUnavailable',
    });
    expect(fixture.create).not.toHaveBeenCalled();
    // Nothing was attempted, so the preview stays confirmable later.
    expect(preview.store.resolve(preview.token).status).toBe('found');
  });

  it('maps names and id conflicts without overwriting', async () => {
    const nameFixture = gatewayFixture({
      create: [{ status: 'conflict', reason: 'nameTaken', existingTemplateId: 'tmpl-other' }],
    });
    const namePreview = await preparedPreview({ gateway: nameFixture.gateway });
    await expect(
      useCase({ gateway: nameFixture.gateway }, namePreview.store).execute({
        previewToken: namePreview.token,
      })
    ).resolves.toEqual({ status: 'nameConflict', existingTemplateId: 'tmpl-other' });
    expect(nameFixture.create).toHaveBeenCalledTimes(1);

    const idFixture = gatewayFixture({
      create: [
        {
          status: 'conflict',
          reason: 'idReusedWithDifferentContent',
          existingTemplateId: 'tmpl-1',
        },
      ],
    });
    const idPreview = await preparedPreview({ gateway: idFixture.gateway });
    await expect(
      useCase({ gateway: idFixture.gateway }, idPreview.store).execute({
        previewToken: idPreview.token,
      })
    ).resolves.toEqual({ status: 'templateIdConflict', templateId: 'tmpl-1' });
    expect(idFixture.create).toHaveBeenCalledTimes(1);
  });

  it('saves the same source under its former name after that record was renamed', async () => {
    const library = libraryFixture();

    // 1. Save As the source under its original name.
    const first = await preparedPreview({ gateway: library.gateway });
    const firstSave = await useCase({ gateway: library.gateway }, first.store).execute({
      previewToken: first.token,
    });
    expect(firstSave.status).toBe('created');
    if (firstSave.status !== 'created') return;
    const originalId = firstSave.template.templateId;
    expect(originalId).toBe(first.stateTemplateId);

    // 2. Rename the saved template. Editing is a compare-and-swap update, so
    // the record keeps the id it was created with.
    const renamed = await new UpdateCustomTeamTemplateUseCase({
      gateway: library.gateway,
      hasher,
    }).execute({
      templateId: originalId,
      expectedRevision: 1,
      fields: {
        name: 'Release Pipeline Renamed',
        teamPrompt: 'Deliver the feature.',
        members: [{ name: 'alice', role: 'reviewer', workflow: 'Review each change.' }],
      },
    });
    expect(renamed.status).toBe('updated');
    if (renamed.status !== 'updated') return;
    expect(renamed.template.templateId).toBe(originalId);

    // 3. Save the same source again under the now-free former name. The former
    // name still derives the renamed record's id, so the new record takes the
    // next free candidate instead of overwriting it or failing.
    const second = await preparedPreview({ gateway: library.gateway });
    const secondSave = await useCase({ gateway: library.gateway }, second.store).execute({
      previewToken: second.token,
    });
    expect(secondSave.status).toBe('created');
    if (secondSave.status !== 'created') return;
    expect(secondSave.template.name).toBe('Release Pipeline');
    expect(secondSave.template.templateId).toBe(`${originalId}-1`);

    // 4. Both records keep their own identity and content.
    expect(library.rows.size).toBe(2);
    const keptRenamed = library.rows.get(originalId);
    expect(keptRenamed?.name).toBe('Release Pipeline Renamed');
    expect(keptRenamed?.revision).toBe(2);
    expect(keptRenamed?.teamPrompt).toBe('Deliver the feature.');
    expect(library.rows.get(`${originalId}-1`)?.name).toBe('Release Pipeline');

    // 5. Repeating the same save stays idempotent: same record, no third row.
    const repeat = await useCase({ gateway: library.gateway }, second.store).execute({
      previewToken: second.token,
    });
    expect(repeat.status).toBe('alreadySaved');
    if (repeat.status !== 'alreadySaved') return;
    expect(repeat.template.templateId).toBe(`${originalId}-1`);
    expect(library.rows.size).toBe(2);
  });

  it('allocates the next free candidate id when the derived id and -1 candidate are occupied', async () => {
    const library = libraryFixture();

    // Pre-populate the store with incompatible records at the derived id and
    // the -1 candidate, so the allocator must advance to -2.
    library.rows.set(
      PREVIEW_ID,
      storedTemplate(PREVIEW_ID, {
        name: 'Occupied Original',
        teamPrompt: 'Different content.',
      })
    );
    library.rows.set(
      `${PREVIEW_ID}-1`,
      storedTemplate(`${PREVIEW_ID}-1`, {
        name: 'Occupied Candidate',
        teamPrompt: 'Different content.',
      })
    );

    const preview = await preparedPreview({ gateway: library.gateway });
    const result = await useCase({ gateway: library.gateway }, preview.store).execute({
      previewToken: preview.token,
    });

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.template.templateId).toBe(`${PREVIEW_ID}-2`);
    expect(result.template.name).toBe('Release Pipeline');

    // Neither existing record is overwritten or changed.
    expect(library.rows.get(PREVIEW_ID)?.name).toBe('Occupied Original');
    expect(library.rows.get(PREVIEW_ID)?.teamPrompt).toBe('Different content.');
    expect(library.rows.get(`${PREVIEW_ID}-1`)?.name).toBe('Occupied Candidate');
    expect(library.rows.get(`${PREVIEW_ID}-1`)?.teamPrompt).toBe('Different content.');

    // Repeating the same save reconciles to alreadySaved for the new record,
    // not a third row.
    const repeat = await useCase({ gateway: library.gateway }, preview.store).execute({
      previewToken: preview.token,
    });
    expect(repeat.status).toBe('alreadySaved');
    if (repeat.status !== 'alreadySaved') return;
    expect(repeat.template.templateId).toBe(`${PREVIEW_ID}-2`);
    expect(library.rows.size).toBe(3);
  });

  it('reports an id conflict instead of writing when every candidate id is occupied', async () => {
    const library = libraryFixture();
    const candidates = Array.from({ length: 8 }, (_, index) =>
      index === 0 ? PREVIEW_ID : `${PREVIEW_ID}-${index}`
    );
    for (const templateId of candidates) {
      library.rows.set(
        templateId,
        storedTemplate(templateId, {
          name: `Occupied ${templateId}`,
          teamPrompt: 'Different content.',
        })
      );
    }

    const preview = await preparedPreview({ gateway: library.gateway });
    await expect(
      useCase({ gateway: library.gateway }, preview.store).execute({ previewToken: preview.token })
    ).resolves.toEqual({ status: 'templateIdConflict', templateId: PREVIEW_ID });

    // The bounded search never writes over an occupied identity.
    expect(library.rows.size).toBe(candidates.length);
    expect(library.rows.has(PREVIEW_ID)).toBe(true);
    for (const templateId of candidates) {
      expect(library.rows.get(templateId)?.teamPrompt).toBe('Different content.');
    }
  });

  it('retries a busy database with the identical request, then reports unavailability', async () => {
    const busy = { status: 'retryable', reason: 'databaseBusy' } as const;
    const recoverFixture = gatewayFixture({
      create: [busy, { status: 'created', template: storedTemplate() }],
    });
    const recovered = await preparedPreview({ gateway: recoverFixture.gateway });
    await expect(
      useCase({ gateway: recoverFixture.gateway }, recovered.store).execute({
        previewToken: recovered.token,
      })
    ).resolves.toEqual({ status: 'created', template: storedTemplate() });
    expect(recoverFixture.create).toHaveBeenCalledTimes(2);
    expect(recoverFixture.requests[1]).toEqual(recoverFixture.requests[0]);

    const exhaustedFixture = gatewayFixture({ create: [busy] });
    const exhausted = await preparedPreview({ gateway: exhaustedFixture.gateway });
    await expect(
      useCase({ gateway: exhaustedFixture.gateway }, exhausted.store).execute({
        previewToken: exhausted.token,
      })
    ).resolves.toEqual({ status: 'storageUnavailable' });
    expect(exhaustedFixture.create).toHaveBeenCalledTimes(2);
    expect(exhaustedFixture.requests[1]).toEqual(exhaustedFixture.requests[0]);
  });

  it('retries an interruption that never started and reports unavailability when it persists', async () => {
    const notStarted = new CustomTeamTemplateStorageInterruptedError(
      'previous worker has not exited',
      'not_started',
      Promise.resolve()
    );
    const fixture = gatewayFixture({
      create: [notStarted, { status: 'created', template: storedTemplate() }],
    });
    const preview = await preparedPreview({ gateway: fixture.gateway });
    await expect(
      useCase({ gateway: fixture.gateway }, preview.store).execute({ previewToken: preview.token })
    ).resolves.toEqual({ status: 'created', template: storedTemplate() });
    expect(fixture.requests[1]).toEqual(fixture.requests[0]);

    const stuckFixture = gatewayFixture({ create: [notStarted] });
    const stuck = await preparedPreview({ gateway: stuckFixture.gateway });
    await expect(
      useCase({ gateway: stuckFixture.gateway }, stuck.store).execute({ previewToken: stuck.token })
    ).resolves.toEqual({ status: 'storageUnavailable' });
    expect(stuckFixture.create).toHaveBeenCalledTimes(2);
  });

  it('reconciles an unknown interruption by the stable id after the writer settles', async () => {
    let settled = false;
    const interruption = new CustomTeamTemplateStorageInterruptedError(
      'worker call timeout',
      'unknown',
      Promise.resolve().then(() => {
        settled = true;
      })
    );
    const equivalent = storedTemplate(PREVIEW_ID);
    const fixture = gatewayFixture({
      create: [interruption],
      getById: [{ status: 'found', template: equivalent }],
    });
    const preview = await preparedPreview({ gateway: fixture.gateway });
    const save = useCase({ gateway: fixture.gateway }, preview.store);

    await expect(save.execute({ previewToken: preview.token })).resolves.toEqual({
      status: 'alreadySaved',
      template: equivalent,
    });
    expect(settled).toBe(true);
    expect(fixture.getById).toHaveBeenCalledWith({ templateId: preview.stateTemplateId });
    expect(fixture.create).toHaveBeenCalledTimes(1);
  });

  it('reconciles an unknown interruption that committed different content as an id conflict', async () => {
    const fixture = gatewayFixture({
      create: [
        new CustomTeamTemplateStorageInterruptedError('worker died', 'unknown', Promise.resolve()),
      ],
      getById: [
        // The pre-write identity probe sees a free id, so the write uses it.
        { status: 'notFound' },
        {
          status: 'found',
          template: storedTemplate(PREVIEW_ID, { teamPrompt: 'Something else.' }),
        },
      ],
    });
    const preview = await preparedPreview({ gateway: fixture.gateway });

    await expect(
      useCase({ gateway: fixture.gateway }, preview.store).execute({ previewToken: preview.token })
    ).resolves.toEqual({ status: 'templateIdConflict', templateId: preview.stateTemplateId });
    expect(fixture.create).toHaveBeenCalledTimes(1);
  });

  it('treats a differing display capitalization as already saved', async () => {
    const fixture = gatewayFixture({
      create: [
        new CustomTeamTemplateStorageInterruptedError('worker died', 'unknown', Promise.resolve()),
      ],
      getById: [
        { status: 'found', template: storedTemplate(PREVIEW_ID, { name: 'RELEASE PIPELINE' }) },
      ],
    });
    const preview = await preparedPreview({ gateway: fixture.gateway });
    const recased = storedTemplate(PREVIEW_ID, { name: 'RELEASE PIPELINE' });

    await expect(
      useCase({ gateway: fixture.gateway }, preview.store).execute({ previewToken: preview.token })
    ).resolves.toEqual({ status: 'alreadySaved', template: recased });
  });

  it('retries once when a reconciled absence proves the write did not persist', async () => {
    const fixture = gatewayFixture({
      create: [
        new CustomTeamTemplateStorageInterruptedError('worker died', 'unknown', Promise.resolve()),
        { status: 'created', template: storedTemplate() },
      ],
      getById: [{ status: 'notFound' }],
    });
    const preview = await preparedPreview({ gateway: fixture.gateway });

    await expect(
      useCase({ gateway: fixture.gateway }, preview.store).execute({ previewToken: preview.token })
    ).resolves.toEqual({ status: 'created', template: storedTemplate() });
    expect(fixture.create).toHaveBeenCalledTimes(2);
    expect(fixture.requests[1]).toEqual(fixture.requests[0]);
  });

  it('reports refused storage when a reconciled absence cannot be followed by a successful retry', async () => {
    const fixture = gatewayFixture({
      create: [
        new CustomTeamTemplateStorageInterruptedError('worker died', 'unknown', Promise.resolve()),
        new CustomTeamTemplateStorageInterruptedError(
          'worker died again',
          'unknown',
          Promise.resolve()
        ),
      ],
      getById: [{ status: 'notFound' }],
    });
    const preview = await preparedPreview({ gateway: fixture.gateway });

    // Every attempt settled and the authoritative read proved the id absent,
    // so the outcome is confirmed-not-saved, not an unknown one.
    await expect(
      useCase({ gateway: fixture.gateway }, preview.store).execute({ previewToken: preview.token })
    ).resolves.toEqual({ status: 'storageUnavailable' });
    // One pre-write identity probe plus one reconciliation read per attempt.
    expect(fixture.getById).toHaveBeenCalledTimes(3);
  });

  it('never claims success when the stored record cannot be read back or verified', async () => {
    const unreadableFixture = gatewayFixture({
      create: [{ status: 'existingRecordUnreadable', templateId: 'tmpl-1' }],
    });
    const unreadable = await preparedPreview({ gateway: unreadableFixture.gateway });
    await expect(
      useCase({ gateway: unreadableFixture.gateway }, unreadable.store).execute({
        previewToken: unreadable.token,
      })
    ).resolves.toEqual({ status: 'unresolvedWriteOutcome', templateId: 'tmpl-1' });

    const reconcileUnreadable = gatewayFixture({
      create: [
        new CustomTeamTemplateStorageInterruptedError('worker died', 'unknown', Promise.resolve()),
      ],
      getById: [{ status: 'unreadable', templateId: 'tmpl-1' }],
    });
    const second = await preparedPreview({ gateway: reconcileUnreadable.gateway });
    await expect(
      useCase({ gateway: reconcileUnreadable.gateway }, second.store).execute({
        previewToken: second.token,
      })
    ).resolves.toEqual({ status: 'unresolvedWriteOutcome', templateId: second.stateTemplateId });

    const plainFailure = gatewayFixture({
      create: [new Error('SQLITE_CONSTRAINT')],
      getById: [new Error('worker is not available in this environment')],
    });
    const third = await preparedPreview({ gateway: plainFailure.gateway });
    await expect(
      useCase({ gateway: plainFailure.gateway }, third.store).execute({
        previewToken: third.token,
      })
    ).resolves.toEqual({ status: 'unresolvedWriteOutcome', templateId: third.stateTemplateId });
  });

  it('keeps the preview saveable when a confirmed save only fails on unrelated input', async () => {
    const fixture = gatewayFixture({ create: [{ status: 'created', template: storedTemplate() }] });
    const preview = await preparedPreview({ gateway: fixture.gateway });
    const save = useCase({ gateway: fixture.gateway }, preview.store);

    await expect(save.execute('token-1')).resolves.toEqual({
      status: 'validationFailed',
      issues: [{ code: 'previewTokenRequired', field: 'previewToken' }],
    });
    expect(fixture.create).not.toHaveBeenCalled();
    expect(preview.store.resolve(preview.token).status).toBe('found');
  });

  it('applies a display name and description the user edited before confirming', async () => {
    const fixture = gatewayFixture({ create: [{ status: 'created', template: storedTemplate() }] });
    const preview = await preparedPreview({ gateway: fixture.gateway });

    await expect(
      useCase({ gateway: fixture.gateway }, preview.store).execute({
        previewToken: preview.token,
        name: '  Release Train ',
        description: '  Weekly train  ',
      })
    ).resolves.toEqual({ status: 'created', template: storedTemplate() });

    // The stable id follows the confirmed identity, while the reviewed team
    // content and its digest are untouched by a display edit.
    const editedId = hasher.deriveTemplateId({
      contentHash: CONTENT_HASH,
      nameKey: 'release train',
      description: 'Weekly train',
    });
    expect(editedId).not.toBe(preview.stateTemplateId);
    expect(fixture.requests[0]).toEqual({
      template: {
        templateId: editedId,
        name: 'Release Train',
        description: 'Weekly train',
        schemaVersion: 1,
        teamPrompt: 'Deliver the feature.',
        members: [{ name: 'alice', role: 'reviewer', workflow: 'Review each change.' }],
      },
      contentHash: CONTENT_HASH,
    });
    // The retained operation now describes the identity that was attempted, so a
    // later re-check reconciles this exact write.
    const retained = preview.store.resolve(preview.token);
    expect(retained.status).toBe('found');
    if (retained.status !== 'found') return;
    expect(retained.state.templateId).toBe(editedId);
    expect(retained.state.name).toBe('Release Train');
    expect(retained.state.nameKey).toBe('release train');
    expect(retained.state.canonicalContent).toBe(CANONICAL);
  });

  it('clears the description when the user empties it before confirming', async () => {
    const fixture = gatewayFixture({ create: [{ status: 'created', template: storedTemplate() }] });
    const store = new InMemoryCustomTeamTemplatePreviewStore({
      now: () => 0,
      createToken: () => 'token-1',
    });
    const prepare = new PrepareCustomTemplatePreviewUseCase({
      gateway: fixture.gateway,
      reader: reader(),
      hasher,
      previewStore: store,
    });
    const prepared = await prepare.execute({
      sourceTeamName: TEAM,
      name: 'Release Pipeline',
      description: 'Weekly release',
    });
    expect(prepared.status).toBe('previewReady');
    if (prepared.status !== 'previewReady') return;

    await useCase({ gateway: fixture.gateway }, store).execute({
      previewToken: prepared.preview.previewToken,
      description: '   ',
    });

    expect(fixture.requests[0].template).not.toHaveProperty('description');
    expect(fixture.requests[0].template.templateId).toBe(
      hasher.deriveTemplateId({
        contentHash: CONTENT_HASH,
        nameKey: 'release pipeline',
        description: null,
      })
    );
  });

  it('ignores renderer-supplied identity, content, digest and timestamp fields', async () => {
    const fixture = gatewayFixture({ create: [{ status: 'created', template: storedTemplate() }] });
    const preview = await preparedPreview({ gateway: fixture.gateway });

    await useCase({ gateway: fixture.gateway }, preview.store).execute({
      previewToken: preview.token,
      templateId: 'tmpl-attacker',
      sourceTeamName: 'other-team',
      contentHash: 'sha256:forged',
      createdAt: '1999-01-01T00:00:00.000Z',
      teamPrompt: 'Forged prompt.',
      members: [{ name: 'mallory' }],
      canonicalContent: 'forged',
    } as never);

    expect(fixture.requests[0].template.templateId).toBe(preview.stateTemplateId);
    expect(fixture.requests[0].contentHash).toBe(CONTENT_HASH);
    expect(fixture.requests[0].template.teamPrompt).toBe('Deliver the feature.');
    expect(fixture.requests[0].template.members).toEqual([
      { name: 'alice', role: 'reviewer', workflow: 'Review each change.' },
    ]);
    expect(fixture.requests[0].template).not.toHaveProperty('createdAt');
  });

  it('rejects an invalid edited name or description without writing', async () => {
    const fixture = gatewayFixture({ create: [{ status: 'created', template: storedTemplate() }] });
    const preview = await preparedPreview({ gateway: fixture.gateway });
    const save = useCase({ gateway: fixture.gateway }, preview.store);

    await expect(save.execute({ previewToken: preview.token, name: '   ' })).resolves.toEqual({
      status: 'validationFailed',
      issues: [{ code: 'templateNameRequired', field: 'name' }],
    });
    await expect(
      save.execute({ previewToken: preview.token, name: 'x'.repeat(129) })
    ).resolves.toEqual({
      status: 'validationFailed',
      issues: [{ code: 'templateNameTooLong', field: 'name' }],
    });
    await expect(save.execute({ previewToken: preview.token, name: 42 } as never)).resolves.toEqual(
      {
        status: 'validationFailed',
        issues: [{ code: 'templateNameRequired', field: 'name' }],
      }
    );
    await expect(
      save.execute({ previewToken: preview.token, description: 'x'.repeat(2_001) })
    ).resolves.toEqual({
      status: 'validationFailed',
      issues: [{ code: 'templateDescriptionTooLong', field: 'description' }],
    });

    expect(fixture.create).not.toHaveBeenCalled();
    // Only display input was wrong, so the reviewed preview stays confirmable.
    expect(preview.store.resolve(preview.token).status).toBe('found');
  });

  it('rejects the save when the preview is evicted before its identity is confirmed', async () => {
    const fixture = gatewayFixture({ create: [{ status: 'created', template: storedTemplate() }] });
    // The preview store evicts the oldest entry when a newer preview fills the
    // bounded capacity; the eviction happens while the snapshot is being read,
    // i.e. after the token resolved but before confirmation.
    let issuedTokens = 0;
    const boundedStore = new InMemoryCustomTeamTemplatePreviewStore({
      now: () => 0,
      createToken: () => `token-${++issuedTokens}`,
      capacity: 1,
    });
    const prepare = new PrepareCustomTemplatePreviewUseCase({
      gateway: fixture.gateway,
      reader: reader(),
      hasher,
      previewStore: boundedStore,
    });
    const prepared = await prepare.execute({ sourceTeamName: TEAM, name: 'Release Pipeline' });
    expect(prepared.status).toBe('previewReady');

    const evictingReader: CustomTeamTemplateSnapshotReader = {
      readSnapshot: async () => {
        boundedStore.issue({
          sourceTeamName: TEAM,
          templateId: 'tmpl-newer',
          name: 'Newer',
          nameKey: 'newer',
          canonicalContent: '{}',
          contentHash: 'sha256:newer',
        });
        return reader().readSnapshot(TEAM);
      },
    };

    await expect(
      useCase({ gateway: fixture.gateway, reader: evictingReader }, boundedStore).execute({
        previewToken: 'token-1',
      })
    ).resolves.toEqual({ status: 'stalePreview', sourceTeamName: TEAM });
    // No create was issued for a preview the store no longer retains.
    expect(fixture.create).not.toHaveBeenCalled();
    expect(boundedStore.resolve('token-1')).toEqual({ status: 'unknown' });
  });

  it('rejects the save when the preview expires before its identity is confirmed', async () => {
    const fixture = gatewayFixture({ create: [{ status: 'created', template: storedTemplate() }] });
    let now = 0;
    const store = new InMemoryCustomTeamTemplatePreviewStore({
      now: () => now,
      createToken: () => 'token-1',
      ttlMs: 100,
    });
    const prepare = new PrepareCustomTemplatePreviewUseCase({
      gateway: fixture.gateway,
      reader: reader(),
      hasher,
      previewStore: store,
    });
    const prepared = await prepare.execute({ sourceTeamName: TEAM, name: 'Release Pipeline' });
    expect(prepared.status).toBe('previewReady');

    // The TTL runs out while the authoritative snapshot is being read.
    const expiringReader: CustomTeamTemplateSnapshotReader = {
      readSnapshot: async () => {
        now = 100;
        return reader().readSnapshot(TEAM);
      },
    };
    await expect(
      useCase({ gateway: fixture.gateway, reader: expiringReader }, store).execute({
        previewToken: 'token-1',
      })
    ).resolves.toEqual({ status: 'stalePreview', sourceTeamName: TEAM });
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it('freezes the confirmed identity so a later request cannot rebind the token', async () => {
    const fixture = gatewayFixture({
      create: [
        new CustomTeamTemplateStorageInterruptedError('worker died', 'unknown', Promise.resolve()),
      ],
      getById: [{ status: 'unreadable', templateId: 'tmpl-1' }],
    });
    const preview = await preparedPreview({ gateway: fixture.gateway });
    const save = useCase({ gateway: fixture.gateway }, preview.store);

    const unresolved = await save.execute({ previewToken: preview.token });
    expect(unresolved).toEqual({
      status: 'unresolvedWriteOutcome',
      templateId: preview.stateTemplateId,
    });

    // The same token with a different name must not create another template.
    await expect(
      save.execute({ previewToken: preview.token, name: 'Different Name' })
    ).resolves.toEqual({
      status: 'validationFailed',
      issues: [{ code: 'previewTokenUnknown', field: 'previewToken' }],
    });
    // …and neither may the same token with a different description.
    await expect(
      save.execute({ previewToken: preview.token, description: 'Other notes' })
    ).resolves.toEqual({
      status: 'validationFailed',
      issues: [{ code: 'previewTokenUnknown', field: 'previewToken' }],
    });

    // Exactly one write was ever dispatched, under the original stable id.
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(
      fixture.requests.every((request) => request.template.templateId === preview.stateTemplateId)
    ).toBe(true);

    // Re-check keeps reconciling the original operation, not a fresh one.
    const read = vi.fn().mockResolvedValue({ status: 'notFound' as const });
    fixture.getById.mockImplementation(read);
    await expect(
      new RecheckCustomTeamTemplateSaveUseCase({
        gateway: fixture.gateway,
        hasher,
        previewStore: preview.store,
      }).execute({ previewToken: preview.token })
    ).resolves.toEqual({ status: 'notSaved', templateId: preview.stateTemplateId });
    expect(read).toHaveBeenCalledWith({ templateId: preview.stateTemplateId });
  });

  it('allows only the identical request on an exact-identity retry after an uncertain write', async () => {
    const fixture = gatewayFixture({
      create: [
        new CustomTeamTemplateStorageInterruptedError('worker died', 'unknown', Promise.resolve()),
        { status: 'alreadySaved', template: storedTemplate(PREVIEW_ID) },
      ],
      getById: [{ status: 'notFound' }],
    });
    const preview = await preparedPreview({ gateway: fixture.gateway });
    const save = useCase({ gateway: fixture.gateway }, preview.store);

    // First confirm: reconciled absence proves the write did not persist, so
    // the identical request is retried once inside the same confirm.
    await expect(save.execute({ previewToken: preview.token })).resolves.toEqual({
      status: 'alreadySaved',
      template: storedTemplate(PREVIEW_ID),
    });
    expect(fixture.create).toHaveBeenCalledTimes(2);

    // A later confirm with the exact same identity stays the same idempotent
    // create; it can never introduce a second id.
    await expect(save.execute({ previewToken: preview.token })).resolves.toEqual({
      status: 'alreadySaved',
      template: storedTemplate(PREVIEW_ID),
    });
    expect(fixture.create).toHaveBeenCalledTimes(3);
    expect(
      fixture.requests.every((request) => request.template.templateId === preview.stateTemplateId)
    ).toBe(true);
  });

  it('rejects concurrent conflicting identities for one token without a second create', async () => {
    const fixture = gatewayFixture({ create: [{ status: 'created', template: storedTemplate() }] });
    const preview = await preparedPreview({ gateway: fixture.gateway });
    const save = useCase({ gateway: fixture.gateway }, preview.store);

    const [first, second] = await Promise.all([
      save.execute({ previewToken: preview.token }),
      save.execute({ previewToken: preview.token, name: 'Conflicting Name' }),
    ]);

    // One request wins the frozen identity; the other is rejected outright.
    expect(first).toEqual({ status: 'created', template: storedTemplate() });
    expect(second).toEqual({
      status: 'validationFailed',
      issues: [{ code: 'previewTokenUnknown', field: 'previewToken' }],
    });
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(fixture.requests[0].template.templateId).toBe(preview.stateTemplateId);
  });

  it('never issues a second write when an unknown outcome cannot be settled', async () => {
    vi.useFakeTimers();
    try {
      const neverSettled = new CustomTeamTemplateStorageInterruptedError(
        'worker termination unconfirmed',
        'unknown',
        new Promise<void>(() => undefined)
      );
      const fixture = gatewayFixture({ create: [neverSettled] });
      const preview = await preparedPreview({ gateway: fixture.gateway });

      const pending = useCase({ gateway: fixture.gateway }, preview.store).execute({
        previewToken: preview.token,
      });
      await vi.advanceTimersByTimeAsync(STORAGE_SETTLEMENT_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(STORAGE_SETTLEMENT_TIMEOUT_MS);

      // The uncertainty is preserved; neither a retry nor a reconciliation
      // read is issued on a writer that never confirmed it stopped.
      await expect(pending).resolves.toEqual({
        status: 'unresolvedWriteOutcome',
        templateId: preview.stateTemplateId,
      });
      expect(fixture.create).toHaveBeenCalledTimes(1);
      // The only read is the pre-write identity probe: no reconciliation read
      // is issued on a writer that never confirmed it stopped.
      expect(fixture.getById).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports unavailable storage when a not-started interruption never settles', async () => {
    vi.useFakeTimers();
    try {
      const neverSettled = new CustomTeamTemplateStorageInterruptedError(
        'previous worker has not exited',
        'not_started',
        new Promise<void>(() => undefined)
      );
      const fixture = gatewayFixture({ create: [neverSettled] });
      const preview = await preparedPreview({ gateway: fixture.gateway });

      const pending = useCase({ gateway: fixture.gateway }, preview.store).execute({
        previewToken: preview.token,
      });
      await vi.advanceTimersByTimeAsync(STORAGE_SETTLEMENT_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(STORAGE_SETTLEMENT_TIMEOUT_MS);

      // A settlement timeout alone never triggers a retry.
      await expect(pending).resolves.toEqual({ status: 'storageUnavailable' });
      expect(fixture.create).toHaveBeenCalledTimes(1);
      // Only the pre-write identity probe read; nothing reconciled the refusal.
      expect(fixture.getById).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a final-attempt lookup failure or unreadable record unresolved', async () => {
    vi.useFakeTimers();
    try {
      // A lookup that rejects with its own never-settling interruption keeps
      // the outcome unresolved instead of proving absence.
      const lookupStuck = gatewayFixture({
        create: [
          new CustomTeamTemplateStorageInterruptedError(
            'worker died',
            'unknown',
            Promise.resolve()
          ),
        ],
        getById: [
          new CustomTeamTemplateStorageInterruptedError(
            'read interrupted',
            'unknown',
            new Promise<void>(() => undefined)
          ),
        ],
      });
      const stuckPreview = await preparedPreview({ gateway: lookupStuck.gateway });
      const stuckPending = useCase({ gateway: lookupStuck.gateway }, stuckPreview.store).execute({
        previewToken: stuckPreview.token,
      });
      await vi.advanceTimersByTimeAsync(STORAGE_SETTLEMENT_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(STORAGE_SETTLEMENT_TIMEOUT_MS);
      await expect(stuckPending).resolves.toEqual({
        status: 'unresolvedWriteOutcome',
        templateId: stuckPreview.stateTemplateId,
      });
      expect(lookupStuck.create).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }

    // A record that exists but cannot be reconstructed is equally inconclusive.
    const unreadable = gatewayFixture({
      create: [
        new CustomTeamTemplateStorageInterruptedError('worker died', 'unknown', Promise.resolve()),
      ],
      getById: [{ status: 'unreadable', templateId: 'tmpl-1' }],
    });
    const unreadablePreview = await preparedPreview({ gateway: unreadable.gateway });
    await expect(
      useCase({ gateway: unreadable.gateway }, unreadablePreview.store).execute({
        previewToken: unreadablePreview.token,
      })
    ).resolves.toEqual({
      status: 'unresolvedWriteOutcome',
      templateId: unreadablePreview.stateTemplateId,
    });
    expect(unreadable.create).toHaveBeenCalledTimes(1);
  });

  it('reports confirmed absence on the final attempt only when the lookup proves it', async () => {
    const fixture = gatewayFixture({
      create: [
        new CustomTeamTemplateStorageInterruptedError('worker died', 'unknown', Promise.resolve()),
        new CustomTeamTemplateStorageInterruptedError(
          'worker died again',
          'unknown',
          Promise.resolve()
        ),
      ],
      getById: [{ status: 'notFound' }],
    });
    const preview = await preparedPreview({ gateway: fixture.gateway });

    // Both attempts settled and the authoritative lookup proved absence, so
    // the exhausted final attempt reports refused storage — never an unknown
    // outcome.
    await expect(
      useCase({ gateway: fixture.gateway }, preview.store).execute({ previewToken: preview.token })
    ).resolves.toEqual({ status: 'storageUnavailable' });
    // One pre-write identity probe plus one reconciliation read per attempt.
    expect(fixture.getById).toHaveBeenCalledTimes(3);
  });

  it('preserves uncertainty when an unknown write is followed by a not-started retry', async () => {
    vi.useFakeTimers();
    try {
      // First write may still commit (settlement never confirms); the exact
      // retry is rejected as not_started, and its settlement does not prove
      // the first write absent. The operation must stay unresolved under the
      // original stable id.
      const firstUnknown = new CustomTeamTemplateStorageInterruptedError(
        'worker call timeout',
        'unknown',
        new Promise<void>(() => undefined)
      );
      const retryNotStarted = new CustomTeamTemplateStorageInterruptedError(
        'previous worker has not exited',
        'not_started',
        Promise.resolve()
      );
      const fixture = gatewayFixture({
        create: [firstUnknown, retryNotStarted],
      });
      const preview = await preparedPreview({ gateway: fixture.gateway });

      const pending = useCase({ gateway: fixture.gateway }, preview.store).execute({
        previewToken: preview.token,
      });
      await vi.advanceTimersByTimeAsync(STORAGE_SETTLEMENT_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(STORAGE_SETTLEMENT_TIMEOUT_MS);

      await expect(pending).resolves.toEqual({
        status: 'unresolvedWriteOutcome',
        templateId: preview.stateTemplateId,
      });
      // No second write is issued on an unsettled unknown, and no
      // reconciliation read can prove absence while the writer may run.
      expect(fixture.create).toHaveBeenCalledTimes(1);
      expect(fixture.getById).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves uncertainty across executes when a retry never starts after an unknown write', async () => {
    vi.useFakeTimers();
    try {
      const firstUnknown = new CustomTeamTemplateStorageInterruptedError(
        'worker call timeout',
        'unknown',
        new Promise<void>(() => undefined)
      );
      const retryNotStarted = new CustomTeamTemplateStorageInterruptedError(
        'worker restarting',
        'not_started',
        Promise.resolve()
      );
      const fixture = gatewayFixture({
        create: [firstUnknown, retryNotStarted, retryNotStarted],
      });
      const preview = await preparedPreview({ gateway: fixture.gateway });
      const save = useCase({ gateway: fixture.gateway }, preview.store);

      const first = save.execute({ previewToken: preview.token });
      await vi.advanceTimersByTimeAsync(STORAGE_SETTLEMENT_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(STORAGE_SETTLEMENT_TIMEOUT_MS);
      await expect(first).resolves.toEqual({
        status: 'unresolvedWriteOutcome',
        templateId: preview.stateTemplateId,
      });

      // An exact retry (same token, same identity) whose write never starts
      // must not clear the earlier uncertainty: the first writer never
      // confirmed it stopped, so absence cannot be proven.
      await expect(save.execute({ previewToken: preview.token })).resolves.toEqual({
        status: 'unresolvedWriteOutcome',
        templateId: preview.stateTemplateId,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
