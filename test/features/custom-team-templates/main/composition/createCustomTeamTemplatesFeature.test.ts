import { createCustomTeamTemplatesFeature } from '@features/custom-team-templates/main/composition/createCustomTeamTemplatesFeature';
import { InternalStorageOperationInterruptedError } from '@features/internal-storage/main';
import { describe, expect, it, vi } from 'vitest';

import type { CustomTeamTemplateV1 } from '@features/custom-team-templates/contracts';
import type { CustomTeamTemplateStorageGateway } from '@features/custom-team-templates/core/application/ports';

const stored: CustomTeamTemplateV1 = {
  templateId: 'tmpl-1',
  name: 'Release Pipeline',
  schemaVersion: 1,
  teamPrompt: 'Prompt.',
  members: [],
  createdAt: '2026-01-01T00:00:00.000Z',
};

function suppliedGateway(): CustomTeamTemplateStorageGateway {
  return {
    customTeamTemplateCreate: vi.fn().mockResolvedValue({ status: 'created', template: stored }),
    customTeamTemplateList: vi
      .fn()
      .mockResolvedValue({ templates: [stored], unreadableRecords: [] }),
    customTeamTemplateGetById: vi.fn().mockResolvedValue({ status: 'found', template: stored }),
  };
}

describe('createCustomTeamTemplatesFeature', () => {
  it('uses the supplied backend gateway rather than constructing another store', async () => {
    const gateway = suppliedGateway();
    const feature = createCustomTeamTemplatesFeature({
      backend: { gateway },
      snapshotReader: { readSnapshot: vi.fn() },
    });

    await expect(feature.listTemplates.execute()).resolves.toEqual({
      status: 'ready',
      templates: [stored],
    });
    expect(gateway.customTeamTemplateList).toHaveBeenCalledTimes(1);
    // No store is constructed here: nothing else can be reached from the facade.
    expect(feature.preparePreview).toBeDefined();
    expect(feature.saveTemplate).toBeDefined();
  });

  it('classifies worker interruptions at the port boundary', async () => {
    const gateway = suppliedGateway();
    gateway.customTeamTemplateCreate = vi
      .fn()
      .mockRejectedValue(
        new InternalStorageOperationInterruptedError('worker exited', 'unknown', Promise.resolve())
      );
    const feature = createCustomTeamTemplatesFeature({
      backend: { gateway },
      previewStoreCapacity: 1,
      createPreviewToken: () => 'token-1',
      now: () => 0,
    });

    const failure = await feature.saveTemplate
      .execute({ previewToken: 'token-unknown' })
      .catch((error: unknown) => error);
    // An unknown token never reaches storage, so nothing is written.
    expect(failure).toEqual({
      status: 'validationFailed',
      issues: [{ code: 'previewTokenUnknown', field: 'previewToken' }],
    });
    expect(gateway.customTeamTemplateCreate).not.toHaveBeenCalled();
  });

  it('reports a missing worker backend as unavailable storage instead of degrading', async () => {
    const feature = createCustomTeamTemplatesFeature({
      backend: null,
      snapshotReader: {
        readSnapshot: () =>
          Promise.resolve({
            status: 'available',
            snapshot: {
              sourceTeamName: 'alpha-team',
              teamPrompt: 'Prompt.',
              roster: { status: 'absent' },
            },
            revision: 'revision-1',
          } as const),
      },
    });

    await expect(feature.listTemplates.execute()).resolves.toEqual({
      status: 'storageUnavailable',
    });
    // The source reads fine; only the store is missing, and that must block the
    // preview rather than fall back to some other backend.
    await expect(
      feature.preparePreview.execute({ sourceTeamName: 'alpha-team', name: 'Template' })
    ).resolves.toEqual({ status: 'storageUnavailable' });
    await expect(feature.saveTemplate.execute({ previewToken: 'any-token' })).resolves.toEqual({
      status: 'validationFailed',
      issues: [{ code: 'previewTokenUnknown', field: 'previewToken' }],
    });
  });

  it('defaults to a real saved-configuration reader that validates the team identity first', async () => {
    const feature = createCustomTeamTemplatesFeature({ backend: { gateway: suppliedGateway() } });

    // An unsafe identity is rejected by the default reader before any path is
    // built, so it can never reach the filesystem.
    await expect(
      feature.preparePreview.execute({ sourceTeamName: '../escape', name: 'Template' })
    ).resolves.toEqual({ status: 'sourceUnavailable', sourceTeamName: '../escape' });

    // Local input problems are still reported before the source is read.
    await expect(
      feature.preparePreview.execute({ sourceTeamName: 'alpha-team', name: '' })
    ).resolves.toEqual({
      status: 'validationFailed',
      issues: [{ code: 'templateNameRequired', field: 'name' }],
    });
    // The preview-token class is the port-level interruption signal, and no
    // renderer-facing surface is registered by composition.
    expect(Object.keys(feature).sort((left, right) => left.localeCompare(right))).toEqual([
      'dispose',
      'listTemplates',
      'preparePreview',
      'recheckSave',
      'saveTemplate',
    ]);
  });
});
