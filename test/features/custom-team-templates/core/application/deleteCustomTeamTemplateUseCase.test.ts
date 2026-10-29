import { CustomTeamTemplateStorageInterruptedError } from '@features/custom-team-templates/core/application/CustomTeamTemplateStorageInterruptedError';
import { DeleteCustomTeamTemplateUseCase } from '@features/custom-team-templates/core/application/DeleteCustomTeamTemplateUseCase';
import { describe, expect, it, vi } from 'vitest';

import type {
  CustomTeamTemplateV1,
  DeleteCustomTeamTemplateRecordRequest,
  DeleteCustomTeamTemplateRecordResult,
  ReadCustomTeamTemplateRecordResult,
} from '@features/custom-team-templates/contracts';
import type { CustomTeamTemplateStorageGateway } from '@features/custom-team-templates/core/application/ports';

function storedTemplate(overrides: Partial<CustomTeamTemplateV1> = {}): CustomTeamTemplateV1 {
  return {
    templateId: 'tmpl-1',
    name: 'Release Pipeline',
    schemaVersion: 1,
    teamPrompt: 'Deliver the feature.',
    members: [{ name: 'alice' }],
    createdAt: '2026-01-01T00:00:00.000Z',
    revision: 2,
    ...overrides,
  };
}

interface GatewayFixture {
  gateway: CustomTeamTemplateStorageGateway;
  remove: ReturnType<typeof vi.fn>;
  getById: ReturnType<typeof vi.fn>;
  requests: DeleteCustomTeamTemplateRecordRequest[];
}

function gatewayFixture(options: {
  remove: (DeleteCustomTeamTemplateRecordResult | Error)[];
  getById?: (ReadCustomTeamTemplateRecordResult | Error)[];
}): GatewayFixture {
  const requests: DeleteCustomTeamTemplateRecordRequest[] = [];
  let removeIndex = 0;
  let readIndex = 0;
  const remove = vi.fn((request: DeleteCustomTeamTemplateRecordRequest) => {
    requests.push(request);
    const outcome = options.remove[Math.min(removeIndex, options.remove.length - 1)];
    removeIndex += 1;
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
      customTeamTemplateUpdate: vi.fn(),
      customTeamTemplateDelete: remove,
    },
    remove,
    getById,
    requests,
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

const request = { templateId: 'tmpl-1', expectedRevision: 2 };

describe('DeleteCustomTeamTemplateUseCase', () => {
  it('deletes exactly the requested record with its expected revision', async () => {
    const fixture = gatewayFixture({ remove: [{ status: 'deleted', templateId: 'tmpl-1' }] });
    const useCase = new DeleteCustomTeamTemplateUseCase({ gateway: fixture.gateway });

    await expect(useCase.execute(request)).resolves.toEqual({
      status: 'deleted',
      templateId: 'tmpl-1',
    });
    expect(fixture.requests).toEqual([{ templateId: 'tmpl-1', expectedRevision: 2 }]);
  });

  it('rejects malformed requests without dispatching a delete', async () => {
    const fixture = gatewayFixture({ remove: [{ status: 'deleted', templateId: 'tmpl-1' }] });
    const useCase = new DeleteCustomTeamTemplateUseCase({ gateway: fixture.gateway });

    await expect(useCase.execute({})).resolves.toMatchObject({ status: 'notFound' });
    await expect(
      useCase.execute({ templateId: 'tmpl-1', expectedRevision: 1.5 })
    ).resolves.toMatchObject({ status: 'notFound' });
    expect(fixture.remove).not.toHaveBeenCalled();
  });

  it('reports storageUnavailable when the worker gateway is unavailable', async () => {
    const useCase = new DeleteCustomTeamTemplateUseCase({ gateway: null });
    await expect(useCase.execute(request)).resolves.toEqual({ status: 'storageUnavailable' });
  });

  it('reports storageUnavailable for a worker error that never dispatched', async () => {
    const fixture = gatewayFixture({ remove: [new Error('worker unavailable')] });
    const useCase = new DeleteCustomTeamTemplateUseCase({ gateway: fixture.gateway });

    await expect(useCase.execute(request)).resolves.toEqual({ status: 'storageUnavailable' });
    expect(fixture.getById).not.toHaveBeenCalled();
  });

  it('retries an interruption that provably never started', async () => {
    const fixture = gatewayFixture({
      remove: [interrupted('not_started'), { status: 'deleted', templateId: 'tmpl-1' }],
    });
    const useCase = new DeleteCustomTeamTemplateUseCase({ gateway: fixture.gateway });

    await expect(useCase.execute(request)).resolves.toMatchObject({ status: 'deleted' });
    expect(fixture.remove).toHaveBeenCalledTimes(2);
  });

  it('recognises a delete that committed before the acknowledgement was lost', async () => {
    const fixture = gatewayFixture({
      remove: [interrupted('unknown')],
      getById: [{ status: 'notFound' }],
    });
    const useCase = new DeleteCustomTeamTemplateUseCase({ gateway: fixture.gateway });

    await expect(useCase.execute(request)).resolves.toEqual({
      status: 'deleted',
      templateId: 'tmpl-1',
    });
  });

  it('stays unresolved when the record still exists after an interrupted delete', async () => {
    const fixture = gatewayFixture({
      remove: [interrupted('unknown')],
      getById: [{ status: 'found', template: storedTemplate() }],
    });
    const useCase = new DeleteCustomTeamTemplateUseCase({ gateway: fixture.gateway });

    await expect(useCase.execute(request)).resolves.toEqual({
      status: 'unresolvedWriteOutcome',
      templateId: 'tmpl-1',
    });
    expect(fixture.remove).toHaveBeenCalledTimes(1);
  });

  it('stays unresolved when the reconciliation read cannot prove the outcome', async () => {
    for (const read of [
      { status: 'unreadable' as const, templateId: 'tmpl-1' },
      new Error('read failed'),
    ]) {
      const fixture = gatewayFixture({ remove: [interrupted('unknown')], getById: [read] });
      const useCase = new DeleteCustomTeamTemplateUseCase({ gateway: fixture.gateway });

      await expect(useCase.execute(request)).resolves.toEqual({
        status: 'unresolvedWriteOutcome',
        templateId: 'tmpl-1',
      });
    }
  });

  it('propagates definite domain outcomes unchanged', async () => {
    const current = storedTemplate();
    const cases: [DeleteCustomTeamTemplateRecordResult, unknown][] = [
      [
        { status: 'revisionConflict', current },
        { status: 'revisionConflict', current },
      ],
      [
        { status: 'notFound', templateId: 'tmpl-1' },
        { status: 'notFound', templateId: 'tmpl-1' },
      ],
      [
        { status: 'unreadable', templateId: 'tmpl-1' },
        { status: 'unreadableRecord', templateId: 'tmpl-1' },
      ],
    ];

    for (const [outcome, expected] of cases) {
      const fixture = gatewayFixture({ remove: [outcome] });
      const useCase = new DeleteCustomTeamTemplateUseCase({ gateway: fixture.gateway });
      await expect(useCase.execute(request)).resolves.toEqual(expected);
    }
  });

  it('reports storageUnavailable only after both attempts stayed retryable', async () => {
    const fixture = gatewayFixture({
      remove: [
        { status: 'retryable', reason: 'databaseBusy' },
        { status: 'retryable', reason: 'databaseBusy' },
      ],
    });
    const useCase = new DeleteCustomTeamTemplateUseCase({ gateway: fixture.gateway });

    await expect(useCase.execute(request)).resolves.toEqual({ status: 'storageUnavailable' });
    expect(fixture.remove).toHaveBeenCalledTimes(2);
  });
});
