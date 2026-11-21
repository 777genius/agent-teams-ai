import { CopyBuiltinTemplateUseCase } from '@features/custom-team-templates/core/application/CopyBuiltinTemplateUseCase';
import { CustomTeamTemplateStorageInterruptedError } from '@features/custom-team-templates/core/application/CustomTeamTemplateStorageInterruptedError';
import { NodeCustomTeamTemplateHasher } from '@features/custom-team-templates/main/adapters/output/NodeCustomTeamTemplateHasher';
import { describe, expect, it, vi } from 'vitest';

import type {
  CreateCustomTeamTemplateRecordRequest,
  CreateCustomTeamTemplateRecordResult,
  CustomTeamTemplateContentV1,
  CustomTeamTemplateV1,
  ReadCustomTeamTemplateRecordResult,
} from '@features/custom-team-templates/contracts';
import type { CustomTeamTemplateStorageGateway } from '@features/custom-team-templates/core/application/ports';

const hasher = new NodeCustomTeamTemplateHasher();
const NEW_ID = 'tmpl-copy';

const BUILTIN_CONTENT: CustomTeamTemplateContentV1 = {
  schemaVersion: 1,
  teamPrompt: 'Ship the product.',
  members: [{ name: 'lead', role: 'Lead', workflow: 'Coordinate.' }],
};

function copiedTemplate(overrides: Partial<CustomTeamTemplateV1> = {}): CustomTeamTemplateV1 {
  return {
    templateId: NEW_ID,
    name: 'Software Product Team',
    schemaVersion: 1,
    teamPrompt: 'Ship the product.',
    members: [{ name: 'lead', role: 'Lead', workflow: 'Coordinate.' }],
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
  resolveBuiltin: (id: string) => CustomTeamTemplateContentV1 | null = () => BUILTIN_CONTENT
): CopyBuiltinTemplateUseCase {
  return new CopyBuiltinTemplateUseCase({
    gateway: fixture.gateway,
    hasher,
    resolveBuiltin,
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

describe('CopyBuiltinTemplateUseCase', () => {
  it('persists a built-in copy under a fresh id without a description', async () => {
    const fixture = gatewayFixture({
      create: [{ status: 'created', template: copiedTemplate() }],
    });

    const result = await useCaseFor(fixture).execute({
      builtinTemplateId: 'software-product',
      name: 'Software Product Team',
    });

    expect(result).toEqual({ status: 'copied', template: copiedTemplate() });
    const request = fixture.requests[0];
    expect(request.template.templateId).toBe(NEW_ID);
    expect('description' in request.template).toBe(false);
    expect(request.template.members).toEqual([
      { name: 'lead', role: 'Lead', workflow: 'Coordinate.' },
    ]);
  });

  it('reports an unknown built-in id and an invalid name without writing', async () => {
    const fixture = gatewayFixture({ create: [{ status: 'retryable', reason: 'databaseBusy' }] });
    const useCase = useCaseFor(fixture, () => null);

    await expect(
      useCase.execute({ builtinTemplateId: 'software-product', name: 'Copy' })
    ).resolves.toEqual({ status: 'builtinNotFound', builtinTemplateId: 'software-product' });
    await expect(
      useCaseFor(fixture).execute({ builtinTemplateId: 'software-product', name: '' })
    ).resolves.toMatchObject({ status: 'validationFailed' });
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it('rejects built-in content that fails the template content policy', async () => {
    const fixture = gatewayFixture({ create: [{ status: 'retryable', reason: 'databaseBusy' }] });
    const useCase = useCaseFor(fixture, () => ({
      ...BUILTIN_CONTENT,
      members: [{ name: 'team-lead' }],
    }));

    await expect(
      useCase.execute({ builtinTemplateId: 'software-product', name: 'Copy' })
    ).resolves.toMatchObject({ status: 'validationFailed' });
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it('reports storageUnavailable when the worker gateway is unavailable', async () => {
    const useCase = new CopyBuiltinTemplateUseCase({
      gateway: null,
      hasher,
      resolveBuiltin: () => BUILTIN_CONTENT,
      createTemplateId: () => NEW_ID,
    });

    await expect(
      useCase.execute({ builtinTemplateId: 'software-product', name: 'Copy' })
    ).resolves.toEqual({ status: 'storageUnavailable' });
  });

  it('reports storageUnavailable for a create error that never dispatched', async () => {
    const fixture = gatewayFixture({ create: [new Error('worker unavailable')] });

    await expect(
      useCaseFor(fixture).execute({ builtinTemplateId: 'software-product', name: 'Copy' })
    ).resolves.toEqual({ status: 'storageUnavailable' });
    expect(fixture.getById).not.toHaveBeenCalled();
  });

  it('recognises a copy that committed before the acknowledgement was lost', async () => {
    const stored = copiedTemplate();
    const fixture = gatewayFixture({
      create: [interrupted('unknown')],
      getById: [{ status: 'found', template: stored }],
    });

    await expect(
      useCaseFor(fixture).execute({
        builtinTemplateId: 'software-product',
        name: 'Software Product Team',
      })
    ).resolves.toEqual({ status: 'copied', template: stored });
    expect(fixture.create).toHaveBeenCalledTimes(1);
  });

  it('does not claim success when the stored record carries a description', async () => {
    const fixture = gatewayFixture({
      create: [interrupted('unknown')],
      getById: [{ status: 'found', template: copiedTemplate({ description: 'Unrelated.' }) }],
    });

    await expect(
      useCaseFor(fixture).execute({
        builtinTemplateId: 'software-product',
        name: 'Software Product Team',
      })
    ).resolves.toEqual({ status: 'unresolvedWriteOutcome', templateId: NEW_ID });
  });

  it('stays unresolved when the copy cannot be proven either way', async () => {
    const unreadable = gatewayFixture({
      create: [interrupted('unknown')],
      getById: [{ status: 'unreadable', templateId: NEW_ID }],
    });
    await expect(
      useCaseFor(unreadable).execute({ builtinTemplateId: 'software-product', name: 'Copy' })
    ).resolves.toEqual({ status: 'unresolvedWriteOutcome', templateId: NEW_ID });

    const absent = gatewayFixture({
      create: [interrupted('unknown')],
      getById: [{ status: 'notFound' }],
    });
    await expect(
      useCaseFor(absent).execute({ builtinTemplateId: 'software-product', name: 'Copy' })
    ).resolves.toEqual({ status: 'unresolvedWriteOutcome', templateId: NEW_ID });
  });

  it('retries an interruption that provably never started', async () => {
    const fixture = gatewayFixture({
      create: [interrupted('not_started'), { status: 'created', template: copiedTemplate() }],
    });

    await expect(
      useCaseFor(fixture).execute({ builtinTemplateId: 'software-product', name: 'Copy' })
    ).resolves.toMatchObject({ status: 'copied' });
    expect(fixture.create).toHaveBeenCalledTimes(2);
  });

  it('propagates name conflicts and unreadable stored records', async () => {
    const nameTaken = gatewayFixture({
      create: [{ status: 'conflict', reason: 'nameTaken', existingTemplateId: 'tmpl-2' }],
    });
    await expect(
      useCaseFor(nameTaken).execute({ builtinTemplateId: 'software-product', name: 'Copy' })
    ).resolves.toEqual({ status: 'nameConflict', existingTemplateId: 'tmpl-2' });

    const unreadable = gatewayFixture({
      create: [{ status: 'existingRecordUnreadable', templateId: NEW_ID }],
    });
    await expect(
      useCaseFor(unreadable).execute({ builtinTemplateId: 'software-product', name: 'Copy' })
    ).resolves.toEqual({ status: 'unresolvedWriteOutcome', templateId: NEW_ID });
  });

  it('reports storageUnavailable only after both attempts stayed retryable', async () => {
    const fixture = gatewayFixture({
      create: [
        { status: 'retryable', reason: 'databaseBusy' },
        { status: 'retryable', reason: 'databaseBusy' },
      ],
    });

    await expect(
      useCaseFor(fixture).execute({ builtinTemplateId: 'software-product', name: 'Copy' })
    ).resolves.toEqual({ status: 'storageUnavailable' });
    expect(fixture.create).toHaveBeenCalledTimes(2);
  });
});
