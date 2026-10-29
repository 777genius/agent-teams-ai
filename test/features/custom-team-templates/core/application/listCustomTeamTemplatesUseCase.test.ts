import { ListCustomTeamTemplatesUseCase } from '@features/custom-team-templates/core/application/ListCustomTeamTemplatesUseCase';
import { describe, expect, it, vi } from 'vitest';

import type { CustomTeamTemplateV1 } from '@features/custom-team-templates/contracts';
import type { CustomTeamTemplateStorageGateway } from '@features/custom-team-templates/core/application/ports';

const template: CustomTeamTemplateV1 = {
  templateId: 'tmpl-1',
  name: 'Release Pipeline',
  schemaVersion: 1,
  teamPrompt: 'Deliver the feature.',
  members: [{ name: 'alice' }],
  createdAt: '2026-01-01T00:00:00.000Z',
};

function gatewayWith(list: () => Promise<unknown>): CustomTeamTemplateStorageGateway {
  return {
    customTeamTemplateCreate: vi.fn(),
    customTeamTemplateList: list as CustomTeamTemplateStorageGateway['customTeamTemplateList'],
    customTeamTemplateGetById: vi.fn(),
    customTeamTemplateUpdate: vi.fn(),
    customTeamTemplateDelete: vi.fn(),
  };
}

describe('ListCustomTeamTemplatesUseCase', () => {
  it('distinguishes a valid empty library from unreadable records and valid records', async () => {
    const cases: {
      listed: {
        templates: readonly CustomTeamTemplateV1[];
        unreadableRecords: readonly { templateId: string; reason: 'unreadableRecord' }[];
      };
      expected: unknown;
    }[] = [
      {
        listed: { templates: [], unreadableRecords: [] },
        expected: { status: 'empty' },
      },
      {
        listed: { templates: [template], unreadableRecords: [] },
        expected: { status: 'ready', templates: [template] },
      },
      {
        listed: {
          templates: [template],
          unreadableRecords: [{ templateId: 'tmpl-broken', reason: 'unreadableRecord' }],
        },
        expected: {
          status: 'hasUnreadableRecords',
          templates: [template],
          unreadableRecords: [{ templateId: 'tmpl-broken', reason: 'unreadableRecord' }],
        },
      },
      {
        // A wholly unreadable library is still not an empty library.
        listed: {
          templates: [],
          unreadableRecords: [{ templateId: 'tmpl-broken', reason: 'unreadableRecord' }],
        },
        expected: {
          status: 'hasUnreadableRecords',
          templates: [],
          unreadableRecords: [{ templateId: 'tmpl-broken', reason: 'unreadableRecord' }],
        },
      },
    ];

    for (const testCase of cases) {
      const useCase = new ListCustomTeamTemplatesUseCase({
        gateway: gatewayWith(() => Promise.resolve(testCase.listed)),
      });
      await expect(useCase.execute()).resolves.toEqual(testCase.expected);
    }
  });

  it('never reports a storage failure as an empty library', async () => {
    const failing = new ListCustomTeamTemplatesUseCase({
      gateway: gatewayWith(() => Promise.reject(new Error('worker unavailable'))),
    });
    await expect(failing.execute()).resolves.toEqual({ status: 'storageUnavailable' });

    const absent = new ListCustomTeamTemplatesUseCase({ gateway: null });
    await expect(absent.execute()).resolves.toEqual({ status: 'storageUnavailable' });
  });

  it('reads the library without mutating it', async () => {
    const create = vi.fn();
    const getById = vi.fn();
    const useCase = new ListCustomTeamTemplatesUseCase({
      gateway: {
        customTeamTemplateCreate: create,
        customTeamTemplateList: vi
          .fn()
          .mockResolvedValue({ templates: [template], unreadableRecords: [] }),
        customTeamTemplateGetById: getById,
        customTeamTemplateUpdate: vi.fn(),
        customTeamTemplateDelete: vi.fn(),
      },
    });

    await useCase.execute();
    expect(create).not.toHaveBeenCalled();
    expect(getById).not.toHaveBeenCalled();
  });
});
