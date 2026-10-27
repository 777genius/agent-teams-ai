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
    customTeamTemplateUpdate: vi.fn(),
    customTeamTemplateDelete: vi.fn(),
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

  it('converts a real internal-storage interruption into an unresolved, reconciled save', async () => {
    // The gateway is the raw Phase 2A backend: it rejects with the internal-
    // storage feature's own interruption error, exactly as the worker client
    // does, so only composition can classify it at the port boundary.
    let settleWriter!: () => void;
    const settled = new Promise<void>((resolve) => {
      settleWriter = resolve;
    });
    const gateway = suppliedGateway();
    gateway.customTeamTemplateCreate = vi
      .fn()
      .mockRejectedValue(
        new InternalStorageOperationInterruptedError('worker exited', 'unknown', settled)
      );
    gateway.customTeamTemplateGetById = vi.fn().mockResolvedValue({
      status: 'unreadable',
      templateId: 'template-1',
    });
    const feature = createCustomTeamTemplatesFeature({
      backend: { gateway },
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

    // A real preview is prepared first, so the save below carries a live token
    // and genuinely reaches storage.
    const prepared = await feature.preparePreview.execute({
      sourceTeamName: 'alpha-team',
      name: 'Template',
    });
    expect(prepared.status).toBe('previewReady');
    if (prepared.status !== 'previewReady') return;

    const save = feature.saveTemplate.execute({
      previewToken: prepared.preview.previewToken,
    });
    // An unknown interruption must wait for the failed writer to settle before
    // any reconciliation read; without the classifying gateway the raw error
    // would skip that wait and reconcile immediately.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(gateway.customTeamTemplateGetById).not.toHaveBeenCalled();
    settleWriter();

    const create = vi.mocked(gateway.customTeamTemplateCreate);
    const getById = vi.mocked(gateway.customTeamTemplateGetById);
    const attemptedTemplateId = create.mock.calls[0][0].template.templateId;

    // The write may have reached the database, so the outcome stays unresolved
    // and the reconciliation lookup classifies it by the stable template id —
    // an unreadable record is never reported as success or absence.
    await expect(save).resolves.toEqual({
      status: 'unresolvedWriteOutcome',
      templateId: attemptedTemplateId,
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(getById).toHaveBeenCalledWith({ templateId: attemptedTemplateId });
  });

  it('retries a not-started interruption without ever consulting reconciliation', async () => {
    const gateway = suppliedGateway();
    gateway.customTeamTemplateCreate = vi
      .fn()
      .mockRejectedValueOnce(
        new InternalStorageOperationInterruptedError(
          'previous worker has not exited',
          'not_started',
          Promise.resolve()
        )
      )
      .mockResolvedValue({ status: 'created', template: stored });
    gateway.customTeamTemplateGetById = vi.fn().mockResolvedValue({ status: 'notFound' });
    const feature = createCustomTeamTemplatesFeature({
      backend: { gateway },
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
    const prepared = await feature.preparePreview.execute({
      sourceTeamName: 'alpha-team',
      name: 'Template',
    });
    expect(prepared.status).toBe('previewReady');
    if (prepared.status !== 'previewReady') return;

    // Only the classifying gateway recognizes the interruption as `not_started`
    // and retries the identical request; without it the raw error would be
    // reconciled through a lookup that never happens on this path.
    await expect(
      feature.saveTemplate.execute({ previewToken: prepared.preview.previewToken })
    ).resolves.toEqual({ status: 'created', template: stored });
    expect(gateway.customTeamTemplateCreate).toHaveBeenCalledTimes(2);
    expect(gateway.customTeamTemplateGetById).not.toHaveBeenCalled();
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
