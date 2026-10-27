import { CustomTeamTemplateStorageInterruptedError } from '@features/custom-team-templates/core/application/CustomTeamTemplateStorageInterruptedError';
import { DuplicateCustomTeamTemplateUseCase } from '@features/custom-team-templates/core/application/DuplicateCustomTeamTemplateUseCase';
import { NodeCustomTeamTemplateHasher } from '@features/custom-team-templates/main/adapters/output/NodeCustomTeamTemplateHasher';
import { describe, expect, it, vi } from 'vitest';

import type {
  CreateCustomTeamTemplateRecordRequest,
  CreateCustomTeamTemplateRecordResult,
  CustomTeamTemplateV1,
  ReadCustomTeamTemplateRecordResult,
} from '@features/custom-team-templates/contracts';
import type { CustomTeamTemplateStorageGateway } from '@features/custom-team-templates/core/application/ports';

const hasher = new NodeCustomTeamTemplateHasher();
const NEW_ID = 'tmpl-new';

function sourceTemplate(overrides: Partial<CustomTeamTemplateV1> = {}): CustomTeamTemplateV1 {
  return {
    templateId: 'tmpl-src',
    name: 'Release Pipeline',
    description: 'Ship it.',
    schemaVersion: 1,
    teamPrompt: 'Deliver the feature.',
    members: [{ name: 'alice', role: 'reviewer' }],
    createdAt: '2026-01-01T00:00:00.000Z',
    revision: 3,
    ...overrides,
  };
}

function duplicatedTemplate(overrides: Partial<CustomTeamTemplateV1> = {}): CustomTeamTemplateV1 {
  return {
    templateId: NEW_ID,
    name: 'Release Pipeline (copy)',
    description: 'Ship it.',
    schemaVersion: 1,
    teamPrompt: 'Deliver the feature.',
    members: [{ name: 'alice', role: 'reviewer' }],
    createdAt: '2026-01-02T00:00:00.000Z',
    revision: 1,
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
  getById?: (ReadCustomTeamTemplateRecordResult | Error)[];
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
      customTeamTemplateList: vi.fn(),
      customTeamTemplateGetById: getById,
      customTeamTemplateUpdate: vi.fn(),
      customTeamTemplateDelete: vi.fn(),
    },
    create,
    getById,
    requests,
  };
}

function useCaseFor(
  fixture: GatewayFixture,
  source: CustomTeamTemplateV1 | Error = sourceTemplate()
): DuplicateCustomTeamTemplateUseCase {
  fixture.getById.mockImplementationOnce(() =>
    source instanceof Error
      ? Promise.reject(source)
      : Promise.resolve({ status: 'found', template: source })
  );
  return new DuplicateCustomTeamTemplateUseCase({
    gateway: fixture.gateway,
    hasher,
    createTemplateId: () => NEW_ID,
  });
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

describe('DuplicateCustomTeamTemplateUseCase', () => {
  it('creates an independent copy under a fresh id', async () => {
    const fixture = gatewayFixture({
      create: [{ status: 'created', template: duplicatedTemplate() }],
    });
    const useCase = useCaseFor(fixture);

    const result = await useCase.execute({
      sourceTemplateId: 'tmpl-src',
      name: 'Release Pipeline (copy)',
    });

    expect(result).toEqual({
      status: 'duplicated',
      template: duplicatedTemplate(),
    });
    const request = fixture.requests[0];
    expect(request.template.templateId).toBe(NEW_ID);
    expect(request.template.name).toBe('Release Pipeline (copy)');
    expect(request.template.description).toBe('Ship it.');
    expect(request.template.members).toEqual([{ name: 'alice', role: 'reviewer' }]);
  });

  it('omits an empty source description from the copy and its identity', async () => {
    const fixture = gatewayFixture({
      create: [{ status: 'created', template: duplicatedTemplate({ description: undefined }) }],
    });
    const useCase = useCaseFor(fixture, sourceTemplate({ description: undefined }));

    await useCase.execute({ sourceTemplateId: 'tmpl-src', name: 'Copy' });

    expect('description' in fixture.requests[0].template).toBe(false);
  });

  it('reports a missing or unreadable source instead of creating anything', async () => {
    const notFound = gatewayFixture({ create: [{ status: 'retryable', reason: 'databaseBusy' }] });
    notFound.getById.mockResolvedValueOnce({ status: 'notFound' });
    await expect(
      new DuplicateCustomTeamTemplateUseCase({
        gateway: notFound.gateway,
        hasher,
        createTemplateId: () => NEW_ID,
      }).execute({ sourceTemplateId: 'tmpl-src', name: 'Copy' })
    ).resolves.toEqual({ status: 'sourceNotFound', sourceTemplateId: 'tmpl-src' });
    expect(notFound.create).not.toHaveBeenCalled();

    const unreadable = gatewayFixture({
      create: [{ status: 'retryable', reason: 'databaseBusy' }],
    });
    unreadable.getById.mockResolvedValueOnce({ status: 'unreadable', templateId: 'tmpl-src' });
    await expect(
      new DuplicateCustomTeamTemplateUseCase({
        gateway: unreadable.gateway,
        hasher,
        createTemplateId: () => NEW_ID,
      }).execute({ sourceTemplateId: 'tmpl-src', name: 'Copy' })
    ).resolves.toEqual({ status: 'sourceUnreadable', sourceTemplateId: 'tmpl-src' });
    expect(unreadable.create).not.toHaveBeenCalled();
  });

  it('validates the duplicate name before reading the source', async () => {
    const fixture = gatewayFixture({ create: [{ status: 'retryable', reason: 'databaseBusy' }] });
    const useCase = new DuplicateCustomTeamTemplateUseCase({
      gateway: fixture.gateway,
      hasher,
      createTemplateId: () => NEW_ID,
    });

    await expect(
      useCase.execute({ sourceTemplateId: 'tmpl-src', name: '  ' })
    ).resolves.toMatchObject({ status: 'validationFailed' });
    expect(fixture.getById).not.toHaveBeenCalled();
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it('reports storageUnavailable when the worker gateway is unavailable', async () => {
    const useCase = new DuplicateCustomTeamTemplateUseCase({
      gateway: null,
      hasher,
      createTemplateId: () => NEW_ID,
    });
    await expect(useCase.execute({ sourceTemplateId: 'tmpl-src', name: 'Copy' })).resolves.toEqual({
      status: 'storageUnavailable',
    });
  });

  it('reports storageUnavailable for a source read that fails', async () => {
    const fixture = gatewayFixture({ create: [{ status: 'retryable', reason: 'databaseBusy' }] });
    const useCase = useCaseFor(fixture, new Error('read failed'));

    await expect(useCase.execute({ sourceTemplateId: 'tmpl-src', name: 'Copy' })).resolves.toEqual({
      status: 'storageUnavailable',
    });
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it('reports storageUnavailable for a create error that never dispatched', async () => {
    const fixture = gatewayFixture({ create: [new Error('worker unavailable')] });
    const useCase = useCaseFor(fixture);

    await expect(useCase.execute({ sourceTemplateId: 'tmpl-src', name: 'Copy' })).resolves.toEqual({
      status: 'storageUnavailable',
    });
    expect(fixture.getById).toHaveBeenCalledTimes(1);
  });

  it('recognises a copy that committed before the acknowledgement was lost', async () => {
    const stored = duplicatedTemplate();
    const fixture = gatewayFixture({
      create: [interrupted('unknown')],
      getById: [{ status: 'found', template: stored }],
    });
    const useCase = useCaseFor(fixture);

    await expect(
      useCase.execute({ sourceTemplateId: 'tmpl-src', name: 'Release Pipeline (copy)' })
    ).resolves.toEqual({ status: 'duplicated', template: stored });
    expect(fixture.create).toHaveBeenCalledTimes(1);
  });

  it('does not claim success for a stored record with different content', async () => {
    const fixture = gatewayFixture({
      create: [interrupted('unknown')],
      getById: [{ status: 'found', template: duplicatedTemplate({ teamPrompt: 'Other.' }) }],
    });
    const useCase = useCaseFor(fixture);

    await expect(
      useCase.execute({ sourceTemplateId: 'tmpl-src', name: 'Release Pipeline (copy)' })
    ).resolves.toEqual({ status: 'templateIdConflict', templateId: NEW_ID });
  });

  it('stays unresolved when the copy cannot be proven either way', async () => {
    const unreadable = gatewayFixture({
      create: [interrupted('unknown')],
      getById: [{ status: 'unreadable', templateId: NEW_ID }],
    });
    await expect(
      useCaseFor(unreadable).execute({ sourceTemplateId: 'tmpl-src', name: 'Copy' })
    ).resolves.toEqual({ status: 'unresolvedWriteOutcome', templateId: NEW_ID });

    const absent = gatewayFixture({
      create: [interrupted('unknown')],
      getById: [{ status: 'notFound' }],
    });
    await expect(
      useCaseFor(absent).execute({ sourceTemplateId: 'tmpl-src', name: 'Copy' })
    ).resolves.toEqual({ status: 'unresolvedWriteOutcome', templateId: NEW_ID });
  });

  it('retries an interruption that provably never started', async () => {
    const fixture = gatewayFixture({
      create: [interrupted('not_started'), { status: 'created', template: duplicatedTemplate() }],
    });
    const useCase = useCaseFor(fixture);

    await expect(
      useCase.execute({ sourceTemplateId: 'tmpl-src', name: 'Copy' })
    ).resolves.toMatchObject({ status: 'duplicated' });
    expect(fixture.create).toHaveBeenCalledTimes(2);
  });

  it('propagates name conflicts and unreadable stored records', async () => {
    const nameTaken = gatewayFixture({
      create: [{ status: 'conflict', reason: 'nameTaken', existingTemplateId: 'tmpl-2' }],
    });
    await expect(
      useCaseFor(nameTaken).execute({ sourceTemplateId: 'tmpl-src', name: 'Copy' })
    ).resolves.toEqual({ status: 'nameConflict', existingTemplateId: 'tmpl-2' });

    const unreadable = gatewayFixture({
      create: [{ status: 'existingRecordUnreadable', templateId: NEW_ID }],
    });
    await expect(
      useCaseFor(unreadable).execute({ sourceTemplateId: 'tmpl-src', name: 'Copy' })
    ).resolves.toEqual({ status: 'unresolvedWriteOutcome', templateId: NEW_ID });
  });

  it('reports templateIdConflict after both attempts reused the id with different content', async () => {
    const fixture = gatewayFixture({
      create: [
        { status: 'conflict', reason: 'idReusedWithDifferentContent', existingTemplateId: NEW_ID },
        { status: 'conflict', reason: 'idReusedWithDifferentContent', existingTemplateId: NEW_ID },
      ],
    });
    const useCase = useCaseFor(fixture);

    await expect(useCase.execute({ sourceTemplateId: 'tmpl-src', name: 'Copy' })).resolves.toEqual({
      status: 'templateIdConflict',
      templateId: NEW_ID,
    });
    expect(fixture.create).toHaveBeenCalledTimes(2);
  });

  it('reports storageUnavailable only after both attempts stayed retryable', async () => {
    const fixture = gatewayFixture({
      create: [
        { status: 'retryable', reason: 'databaseBusy' },
        { status: 'retryable', reason: 'databaseBusy' },
      ],
    });
    const useCase = useCaseFor(fixture);

    await expect(useCase.execute({ sourceTemplateId: 'tmpl-src', name: 'Copy' })).resolves.toEqual({
      status: 'storageUnavailable',
    });
  });
});
