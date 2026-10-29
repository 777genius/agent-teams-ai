import { CustomTeamTemplateStorageInterruptedError } from '@features/custom-team-templates/core/application/CustomTeamTemplateStorageInterruptedError';
import { UpdateCustomTeamTemplateUseCase } from '@features/custom-team-templates/core/application/UpdateCustomTeamTemplateUseCase';
import { serializeCanonicalTemplateContent } from '@features/custom-team-templates/core/domain/canonicalTemplateSerialization';
import { NodeCustomTeamTemplateHasher } from '@features/custom-team-templates/main/adapters/output/NodeCustomTeamTemplateHasher';
import { describe, expect, it, vi } from 'vitest';

import type {
  CustomTeamTemplateMemberV1,
  CustomTeamTemplateV1,
  ReadCustomTeamTemplateRecordResult,
  UpdateCustomTeamTemplateRecordRequest,
  UpdateCustomTeamTemplateRecordResult,
} from '@features/custom-team-templates/contracts';
import type { CustomTeamTemplateStorageGateway } from '@features/custom-team-templates/core/application/ports';

const hasher = new NodeCustomTeamTemplateHasher();

function storedTemplate(overrides: Partial<CustomTeamTemplateV1> = {}): CustomTeamTemplateV1 {
  return {
    templateId: 'tmpl-1',
    name: 'Release Pipeline',
    schemaVersion: 1,
    teamPrompt: 'Deliver the feature.',
    members: [{ name: 'alice', role: 'reviewer', workflow: 'Review each change.' }],
    createdAt: '2026-01-01T00:00:00.000Z',
    revision: 1,
    ...overrides,
  };
}

function contentHashFor(
  teamPrompt: string,
  members: readonly CustomTeamTemplateMemberV1[]
): string {
  return hasher.hashCanonicalContent(
    serializeCanonicalTemplateContent({ schemaVersion: 1, teamPrompt, members })
  );
}

interface GatewayFixture {
  gateway: CustomTeamTemplateStorageGateway;
  update: ReturnType<typeof vi.fn>;
  getById: ReturnType<typeof vi.fn>;
  requests: UpdateCustomTeamTemplateRecordRequest[];
}

function gatewayFixture(options: {
  update: (UpdateCustomTeamTemplateRecordResult | Error)[];
  getById?: (ReadCustomTeamTemplateRecordResult | Error)[];
}): GatewayFixture {
  const requests: UpdateCustomTeamTemplateRecordRequest[] = [];
  let updateIndex = 0;
  let readIndex = 0;
  const update = vi.fn((request: UpdateCustomTeamTemplateRecordRequest) => {
    requests.push(request);
    const outcome = options.update[Math.min(updateIndex, options.update.length - 1)];
    updateIndex += 1;
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
      customTeamTemplateCreate: vi.fn(),
      customTeamTemplateList: vi.fn(),
      customTeamTemplateGetById: getById,
      customTeamTemplateUpdate: update,
      customTeamTemplateDelete: vi.fn(),
    },
    update,
    getById,
    requests,
  };
}

function updateRequest(overrides: {
  name?: string;
  description?: string;
  teamPrompt?: string;
  members?: unknown;
  expectedRevision?: number;
}): unknown {
  return {
    templateId: 'tmpl-1',
    expectedRevision: overrides.expectedRevision ?? 1,
    fields: {
      name: overrides.name ?? 'Release Pipeline',
      ...(overrides.description === undefined ? {} : { description: overrides.description }),
      teamPrompt: overrides.teamPrompt ?? 'Deliver the feature.',
      members: overrides.members ?? [
        { name: 'alice', role: 'reviewer', workflow: 'Review each change.' },
      ],
    },
  };
}

function interrupted(
  execution: 'unknown' | 'not_started'
): CustomTeamTemplateStorageInterruptedError {
  return new CustomTeamTemplateStorageInterruptedError(
    'worker interrupted',
    execution,
    Promise.resolve()
  );
}

describe('UpdateCustomTeamTemplateUseCase', () => {
  it('persists the validated fields and hashes exactly the persisted content', async () => {
    const updated = storedTemplate({ revision: 2 });
    const fixture = gatewayFixture({ update: [{ status: 'updated', template: updated }] });
    const useCase = new UpdateCustomTeamTemplateUseCase({ gateway: fixture.gateway, hasher });

    const result = await useCase.execute(updateRequest({}));

    expect(result).toEqual({ status: 'updated', template: updated });
    expect(fixture.requests).toHaveLength(1);
    const request = fixture.requests[0];
    expect(request.templateId).toBe('tmpl-1');
    expect(request.expectedRevision).toBe(1);
    expect(request.template.name).toBe('Release Pipeline');
    expect(request.template.members).toEqual([
      { name: 'alice', role: 'reviewer', workflow: 'Review each change.' },
    ]);
    expect(request.contentHash).toBe(
      contentHashFor('Deliver the feature.', [
        { name: 'alice', role: 'reviewer', workflow: 'Review each change.' },
      ])
    );
  });

  it('drops empty-string role and workflow before hashing and before the write payload', async () => {
    const fixture = gatewayFixture({
      update: [{ status: 'updated', template: storedTemplate({ revision: 2 }) }],
    });
    const useCase = new UpdateCustomTeamTemplateUseCase({ gateway: fixture.gateway, hasher });

    await useCase.execute(updateRequest({ members: [{ name: 'alice', role: '', workflow: '' }] }));

    const members = fixture.requests[0].template.members;
    expect(members).toEqual([{ name: 'alice' }]);
    expect(Object.keys(members[0])).toEqual(['name']);
    expect(fixture.requests[0].contentHash).toBe(
      contentHashFor('Deliver the feature.', [{ name: 'alice' }])
    );
  });

  it('hashes omitted and empty optional metadata identically', async () => {
    const omitted = gatewayFixture({
      update: [{ status: 'updated', template: storedTemplate({ revision: 2 }) }],
    });
    const empty = gatewayFixture({
      update: [{ status: 'updated', template: storedTemplate({ revision: 2 }) }],
    });

    await new UpdateCustomTeamTemplateUseCase({ gateway: omitted.gateway, hasher }).execute(
      updateRequest({ members: [{ name: 'alice' }] })
    );
    await new UpdateCustomTeamTemplateUseCase({ gateway: empty.gateway, hasher }).execute(
      updateRequest({ members: [{ name: 'alice', role: '', workflow: '' }] })
    );

    expect(empty.requests[0].contentHash).toBe(omitted.requests[0].contentHash);
    expect(empty.requests[0].template.members).toEqual(omitted.requests[0].template.members);
  });

  it('preserves non-empty optional member metadata', async () => {
    const fixture = gatewayFixture({
      update: [{ status: 'updated', template: storedTemplate({ revision: 2 }) }],
    });
    const useCase = new UpdateCustomTeamTemplateUseCase({ gateway: fixture.gateway, hasher });

    await useCase.execute(
      updateRequest({ members: [{ name: 'alice', role: 'Reviewer', workflow: 'Review.' }] })
    );

    expect(fixture.requests[0].template.members).toEqual([
      { name: 'alice', role: 'Reviewer', workflow: 'Review.' },
    ]);
  });

  it('rejects invalid names, invalid member shapes and invalid content before dispatching', async () => {
    const fixture = gatewayFixture({
      update: [{ status: 'updated', template: storedTemplate({ revision: 2 }) }],
    });
    const useCase = new UpdateCustomTeamTemplateUseCase({ gateway: fixture.gateway, hasher });

    await expect(useCase.execute(updateRequest({ name: '   ' }))).resolves.toMatchObject({
      status: 'validationFailed',
    });
    await expect(
      useCase.execute(updateRequest({ members: [{ name: 'alice', role: 7 }] }))
    ).resolves.toMatchObject({ status: 'validationFailed' });
    await expect(
      useCase.execute(updateRequest({ members: [{ name: 'alice' }, { name: 'ALICE' }] }))
    ).resolves.toMatchObject({ status: 'validationFailed' });
    expect(fixture.update).not.toHaveBeenCalled();
  });

  it('reports storageUnavailable when the worker gateway is unavailable', async () => {
    const useCase = new UpdateCustomTeamTemplateUseCase({ gateway: null, hasher });
    await expect(useCase.execute(updateRequest({}))).resolves.toEqual({
      status: 'storageUnavailable',
    });
  });

  it('reports storageUnavailable for a worker error that never dispatched', async () => {
    const fixture = gatewayFixture({ update: [new Error('worker unavailable')] });
    const useCase = new UpdateCustomTeamTemplateUseCase({ gateway: fixture.gateway, hasher });

    await expect(useCase.execute(updateRequest({}))).resolves.toEqual({
      status: 'storageUnavailable',
    });
    expect(fixture.getById).not.toHaveBeenCalled();
  });

  it('retries an interruption that provably never started', async () => {
    const fixture = gatewayFixture({
      update: [
        interrupted('not_started'),
        { status: 'updated', template: storedTemplate({ revision: 2 }) },
      ],
    });
    const useCase = new UpdateCustomTeamTemplateUseCase({ gateway: fixture.gateway, hasher });

    await expect(useCase.execute(updateRequest({}))).resolves.toMatchObject({ status: 'updated' });
    expect(fixture.update).toHaveBeenCalledTimes(2);
  });

  it('recognises a committed update whose empty metadata was normalized before persistence', async () => {
    // The worker stored the row without role/workflow, exactly as the mapper
    // writes it, and the reply was lost.
    const committed = storedTemplate({ revision: 2, members: [{ name: 'alice' }] });
    const fixture = gatewayFixture({
      update: [interrupted('unknown')],
      getById: [{ status: 'found', template: committed }],
    });
    const useCase = new UpdateCustomTeamTemplateUseCase({ gateway: fixture.gateway, hasher });

    const result = await useCase.execute(
      updateRequest({ members: [{ name: 'alice', role: '', workflow: '' }] })
    );

    expect(result).toEqual({ status: 'updated', template: committed });
    expect(fixture.update).toHaveBeenCalledTimes(1);
  });

  it('trims surrounding whitespace from member names before validation, hashing and persistence', async () => {
    const updated = storedTemplate({ revision: 2 });
    const fixture = gatewayFixture({ update: [{ status: 'updated', template: updated }] });
    const useCase = new UpdateCustomTeamTemplateUseCase({ gateway: fixture.gateway, hasher });

    const result = await useCase.execute(
      updateRequest({
        members: [{ name: '  alice  ', role: 'reviewer', workflow: 'Review each change.' }],
      })
    );

    expect(result).toEqual({ status: 'updated', template: updated });
    const members = fixture.requests[0].template.members;
    expect(members).toEqual([{ name: 'alice', role: 'reviewer', workflow: 'Review each change.' }]);
    expect(fixture.requests[0].contentHash).toBe(
      contentHashFor('Deliver the feature.', [
        { name: 'alice', role: 'reviewer', workflow: 'Review each change.' },
      ])
    );
  });

  it('trims surrounding whitespace from the team prompt before validation, hashing and persistence', async () => {
    const updated = storedTemplate({ revision: 2 });
    const fixture = gatewayFixture({ update: [{ status: 'updated', template: updated }] });
    const useCase = new UpdateCustomTeamTemplateUseCase({ gateway: fixture.gateway, hasher });

    const result = await useCase.execute(updateRequest({ teamPrompt: '  Deliver the feature.  ' }));

    expect(result).toEqual({ status: 'updated', template: updated });
    expect(fixture.requests[0].template.teamPrompt).toBe('Deliver the feature.');
    expect(fixture.requests[0].contentHash).toBe(
      contentHashFor('Deliver the feature.', [
        { name: 'alice', role: 'reviewer', workflow: 'Review each change.' },
      ])
    );
  });

  it('allows an empty or whitespace-only team prompt following the domain contract', async () => {
    const updated = storedTemplate({ revision: 2, teamPrompt: '' });
    const fixture = gatewayFixture({ update: [{ status: 'updated', template: updated }] });
    const useCase = new UpdateCustomTeamTemplateUseCase({ gateway: fixture.gateway, hasher });

    const result = await useCase.execute(updateRequest({ teamPrompt: '   ' }));

    expect(result).toEqual({ status: 'updated', template: updated });
    expect(fixture.requests[0].template.teamPrompt).toBe('');
  });

  it('rejects a non-string team prompt', async () => {
    const fixture = gatewayFixture({
      update: [{ status: 'updated', template: storedTemplate({ revision: 2 }) }],
    });
    const useCase = new UpdateCustomTeamTemplateUseCase({ gateway: fixture.gateway, hasher });

    const result = await useCase.execute(updateRequest({ teamPrompt: 42 as unknown as string }));

    expect(result).toMatchObject({ status: 'validationFailed' });
    expect(fixture.update).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only member name through validation', async () => {
    const fixture = gatewayFixture({
      update: [{ status: 'updated', template: storedTemplate({ revision: 2 }) }],
    });
    const useCase = new UpdateCustomTeamTemplateUseCase({ gateway: fixture.gateway, hasher });

    const result = await useCase.execute(updateRequest({ members: [{ name: '   ' }] }));

    expect(result).toMatchObject({ status: 'validationFailed' });
    expect(fixture.update).not.toHaveBeenCalled();
  });

  it('trims surrounding whitespace from member role and workflow before hashing and persistence', async () => {
    const updated = storedTemplate({ revision: 2 });
    const fixture = gatewayFixture({ update: [{ status: 'updated', template: updated }] });
    const useCase = new UpdateCustomTeamTemplateUseCase({ gateway: fixture.gateway, hasher });

    const result = await useCase.execute(
      updateRequest({
        members: [{ name: 'alice', role: '  reviewer  ', workflow: '  Review each change.  ' }],
      })
    );

    expect(result).toEqual({ status: 'updated', template: updated });
    expect(fixture.requests[0].template.members).toEqual([
      { name: 'alice', role: 'reviewer', workflow: 'Review each change.' },
    ]);
    expect(fixture.requests[0].contentHash).toBe(
      contentHashFor('Deliver the feature.', [
        { name: 'alice', role: 'reviewer', workflow: 'Review each change.' },
      ])
    );
  });

  it('drops whitespace-only member role and workflow before hashing', async () => {
    const updated = storedTemplate({ revision: 2 });
    const fixture = gatewayFixture({ update: [{ status: 'updated', template: updated }] });
    const useCase = new UpdateCustomTeamTemplateUseCase({ gateway: fixture.gateway, hasher });

    const result = await useCase.execute(
      updateRequest({ members: [{ name: 'alice', role: '   ', workflow: '  ' }] })
    );

    expect(result).toEqual({ status: 'updated', template: updated });
    expect(fixture.requests[0].template.members).toEqual([{ name: 'alice' }]);
    expect(fixture.requests[0].contentHash).toBe(
      contentHashFor('Deliver the feature.', [{ name: 'alice' }])
    );
  });

  it('reconciles an interrupted update whose member name was trimmed before persistence', async () => {
    const committed = storedTemplate({ revision: 2 });
    const fixture = gatewayFixture({
      update: [interrupted('unknown')],
      getById: [{ status: 'found', template: committed }],
    });
    const useCase = new UpdateCustomTeamTemplateUseCase({ gateway: fixture.gateway, hasher });

    const result = await useCase.execute(
      updateRequest({
        members: [{ name: '  alice  ', role: 'reviewer', workflow: 'Review each change.' }],
      })
    );

    expect(result).toEqual({ status: 'updated', template: committed });
    expect(fixture.update).toHaveBeenCalledTimes(1);
  });

  it('reconciles an interrupted update whose member metadata was trimmed before persistence', async () => {
    const committed = storedTemplate({ revision: 2 });
    const fixture = gatewayFixture({
      update: [interrupted('unknown')],
      getById: [{ status: 'found', template: committed }],
    });
    const useCase = new UpdateCustomTeamTemplateUseCase({ gateway: fixture.gateway, hasher });

    const result = await useCase.execute(
      updateRequest({
        members: [{ name: '  alice  ', role: '  reviewer  ', workflow: '  Review each change.  ' }],
      })
    );

    expect(result).toEqual({ status: 'updated', template: committed });
    expect(fixture.update).toHaveBeenCalledTimes(1);
  });

  it('stays unresolved when the stored row differs in prompt, members or revision', async () => {
    const scenarios: CustomTeamTemplateV1[] = [
      storedTemplate({ revision: 2, teamPrompt: 'A different prompt.' }),
      storedTemplate({ revision: 2, members: [{ name: 'alice' }, { name: 'bob' }] }),
      // Same content but no revision bump: the write never committed.
      storedTemplate({ revision: 1 }),
    ];

    for (const scenario of scenarios) {
      const fixture = gatewayFixture({
        update: [interrupted('unknown')],
        getById: [{ status: 'found', template: scenario }],
      });
      const useCase = new UpdateCustomTeamTemplateUseCase({ gateway: fixture.gateway, hasher });

      await expect(useCase.execute(updateRequest({}))).resolves.toEqual({
        status: 'unresolvedWriteOutcome',
        templateId: 'tmpl-1',
      });
    }
  });

  it('stays unresolved when the stored record cannot be read back', async () => {
    const fixture = gatewayFixture({
      update: [interrupted('unknown')],
      getById: [{ status: 'unreadable', templateId: 'tmpl-1' }],
    });
    const useCase = new UpdateCustomTeamTemplateUseCase({ gateway: fixture.gateway, hasher });

    await expect(useCase.execute(updateRequest({}))).resolves.toEqual({
      status: 'unresolvedWriteOutcome',
      templateId: 'tmpl-1',
    });
  });

  it('stays unresolved when the reconciliation read itself fails', async () => {
    const fixture = gatewayFixture({
      update: [interrupted('unknown')],
      getById: [new Error('read failed')],
    });
    const useCase = new UpdateCustomTeamTemplateUseCase({ gateway: fixture.gateway, hasher });

    await expect(useCase.execute(updateRequest({}))).resolves.toEqual({
      status: 'unresolvedWriteOutcome',
      templateId: 'tmpl-1',
    });
  });

  it('propagates definite domain outcomes unchanged', async () => {
    const current = storedTemplate({ revision: 3 });
    const cases: [UpdateCustomTeamTemplateRecordResult, unknown][] = [
      [
        { status: 'revisionConflict', current },
        { status: 'revisionConflict', current },
      ],
      [
        { status: 'notFound', templateId: 'tmpl-1' },
        { status: 'notFound', templateId: 'tmpl-1' },
      ],
      [
        { status: 'conflict', reason: 'nameTaken', existingTemplateId: 'tmpl-2' },
        { status: 'nameConflict', existingTemplateId: 'tmpl-2' },
      ],
      [
        { status: 'unreadable', templateId: 'tmpl-1' },
        { status: 'unreadableRecord', templateId: 'tmpl-1' },
      ],
    ];

    for (const [outcome, expected] of cases) {
      const fixture = gatewayFixture({ update: [outcome] });
      const useCase = new UpdateCustomTeamTemplateUseCase({ gateway: fixture.gateway, hasher });
      await expect(useCase.execute(updateRequest({}))).resolves.toEqual(expected);
    }
  });

  it('reports storageUnavailable only after both attempts stayed retryable', async () => {
    const fixture = gatewayFixture({
      update: [
        { status: 'retryable', reason: 'databaseBusy' },
        { status: 'retryable', reason: 'databaseBusy' },
      ],
    });
    const useCase = new UpdateCustomTeamTemplateUseCase({ gateway: fixture.gateway, hasher });

    await expect(useCase.execute(updateRequest({}))).resolves.toEqual({
      status: 'storageUnavailable',
    });
    expect(fixture.update).toHaveBeenCalledTimes(2);
  });
});
