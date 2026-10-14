import { InMemoryCustomTeamTemplatePreviewStore } from '@features/custom-team-templates/core/application/InMemoryCustomTeamTemplatePreviewStore';
import { PrepareCustomTemplatePreviewUseCase } from '@features/custom-team-templates/core/application/PrepareCustomTemplatePreviewUseCase';
import { serializeCanonicalTemplateContent } from '@features/custom-team-templates/core/domain/canonicalTemplateSerialization';
import { NodeCustomTeamTemplateHasher } from '@features/custom-team-templates/main/adapters/output/NodeCustomTeamTemplateHasher';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CustomTeamTemplateV1 } from '@features/custom-team-templates/contracts';
import type {
  CustomTeamTemplateSnapshotReader,
  CustomTeamTemplateStorageGateway,
} from '@features/custom-team-templates/core/application/ports';
import type { CustomTemplateSourceTeamSnapshot } from '@features/custom-team-templates/core/domain/templateSourceSnapshot';

const hasher = new NodeCustomTeamTemplateHasher();

function requester(teamName: string) {
  const asked: string[] = [];
  const reader: CustomTeamTemplateSnapshotReader = {
    readSnapshot: (sourceTeamName) => {
      asked.push(sourceTeamName);
      if (sourceTeamName !== teamName) {
        return Promise.resolve({ status: 'sourceUnavailable', sourceTeamName } as const);
      }
      return Promise.resolve({
        status: 'available',
        snapshot: {
          sourceTeamName: teamName,
          teamPrompt: 'Deliver the feature.',
          roster: {
            status: 'readable',
            members: [
              { name: 'team-lead', agentType: 'team-lead', role: 'Lead' },
              { name: 'alice', role: 'reviewer', workflow: 'Review each change.' },
            ],
          },
        },
        revision: 'revision-1',
      } as const);
    },
  };
  return { reader, asked: () => asked };
}

function gateway(templates: readonly CustomTeamTemplateV1[] = []) {
  const create = vi.fn();
  const value: CustomTeamTemplateStorageGateway = {
    customTeamTemplateCreate: create,
    customTeamTemplateList: vi.fn().mockResolvedValue({ templates, unreadableRecords: [] }),
    customTeamTemplateGetById: vi.fn().mockResolvedValue({ status: 'notFound' }),
  };
  return { value, create };
}

function build(deps: {
  reader: CustomTeamTemplateSnapshotReader;
  gateway: CustomTeamTemplateStorageGateway | null;
}) {
  const previewStore = new InMemoryCustomTeamTemplatePreviewStore({
    now: () => 1_000,
    createToken: () => 'token-1',
  });
  const useCase = new PrepareCustomTemplatePreviewUseCase({
    gateway: deps.gateway,
    reader: deps.reader,
    hasher,
    previewStore,
  });
  return { useCase, previewStore };
}

const ALPHA = 'alpha-team';

describe('PrepareCustomTemplatePreviewUseCase', () => {
  let readerFixture: ReturnType<typeof requester>;
  let gatewayFixture: ReturnType<typeof gateway>;

  beforeEach(() => {
    readerFixture = requester(ALPHA);
    gatewayFixture = gateway();
  });

  it('builds the allowlisted projection and returns an opaque token', async () => {
    const { useCase, previewStore } = build({
      reader: readerFixture.reader,
      gateway: gatewayFixture.value,
    });

    const result = await useCase.execute({
      sourceTeamName: ALPHA,
      name: '  Release Pipeline  ',
      description: '  Weekly release  ',
    });

    expect(result.status).toBe('previewReady');
    if (result.status !== 'previewReady') return;
    expect(readerFixture.asked()).toEqual([ALPHA]);
    expect(result.preview).toEqual({
      sourceTeamName: ALPHA,
      name: 'Release Pipeline',
      description: 'Weekly release',
      teamPrompt: 'Deliver the feature.',
      members: [{ name: 'alice', role: 'reviewer', workflow: 'Review each change.' }],
      warnings: [],
      canonicalContent: serializeCanonicalTemplateContent({
        schemaVersion: 1,
        teamPrompt: 'Deliver the feature.',
        members: [{ name: 'alice', role: 'reviewer', workflow: 'Review each change.' }],
      }),
      previewToken: 'token-1',
    });

    // Preview is a read-only step: nothing may be persisted.
    expect(gatewayFixture.create).not.toHaveBeenCalled();
    // The token is not the canonical payload.
    expect(result.preview.previewToken).not.toContain('schemaVersion');
    expect(previewStore.size).toBe(1);
  });

  it('is deterministic for the same source and keeps tokens distinct per preview', async () => {
    let issued = 0;
    const previewStore = new InMemoryCustomTeamTemplatePreviewStore({
      now: () => 1_000,
      createToken: () => `token-${++issued}`,
    });
    const useCase = new PrepareCustomTemplatePreviewUseCase({
      gateway: gatewayFixture.value,
      reader: readerFixture.reader,
      hasher,
      previewStore,
    });

    const first = await useCase.execute({ sourceTeamName: ALPHA, name: 'Release Pipeline' });
    const second = await useCase.execute({ sourceTeamName: ALPHA, name: 'release   pipeline' });

    expect(first.status).toBe('previewReady');
    expect(second.status).toBe('previewReady');
    if (first.status !== 'previewReady' || second.status !== 'previewReady') return;
    expect(second.preview.canonicalContent).toBe(first.preview.canonicalContent);
    expect(second.preview.previewToken).not.toBe(first.preview.previewToken);
    // Case-insensitive uniqueness: both previews resolve to one template id.
    const firstState = previewStore.resolve(first.preview.previewToken);
    const secondState = previewStore.resolve(second.preview.previewToken);
    expect(firstState.status).toBe('found');
    expect(secondState.status).toBe('found');
    if (firstState.status !== 'found' || secondState.status !== 'found') return;
    expect(secondState.state.templateId).toBe(firstState.state.templateId);
    // Only the uniqueness key collapses whitespace; the display name keeps the
    // capitalization and spacing the user typed (trimmed at the edges).
    expect(secondState.state.name).toBe('release   pipeline');
  });

  it('reports validation failures before touching the source', async () => {
    const { useCase, previewStore } = build({
      reader: readerFixture.reader,
      gateway: gatewayFixture.value,
    });

    await expect(useCase.execute({ sourceTeamName: ALPHA, name: '   ' })).resolves.toEqual({
      status: 'validationFailed',
      issues: [{ code: 'templateNameRequired', field: 'name' }],
    });
    await expect(useCase.execute({ sourceTeamName: '', name: 'Name' })).resolves.toEqual({
      status: 'validationFailed',
      issues: [{ code: 'sourceTeamNameInvalid', field: 'sourceTeamName' }],
    });
    await expect(useCase.execute(null)).resolves.toEqual({
      status: 'validationFailed',
      issues: [{ code: 'sourceTeamNameInvalid', field: 'sourceTeamName' }],
    });
    await expect(
      useCase.execute({ sourceTeamName: ALPHA, name: 'Name', description: 'x'.repeat(2_001) })
    ).resolves.toEqual({
      status: 'validationFailed',
      issues: [{ code: 'templateDescriptionTooLong', field: 'description' }],
    });

    expect(readerFixture.asked()).toEqual([]);
    expect(previewStore.size).toBe(0);
  });

  it('never issues a saveable preview from an unreadable roster', async () => {
    const unreadable: CustomTeamTemplateSnapshotReader = {
      readSnapshot: () =>
        Promise.resolve({
          status: 'available',
          snapshot: { sourceTeamName: ALPHA, roster: { status: 'unreadable' } },
          revision: 'revision-1',
        } as const),
    };
    const { useCase, previewStore } = build({
      reader: unreadable,
      gateway: gatewayFixture.value,
    });

    await expect(useCase.execute({ sourceTeamName: ALPHA, name: 'Name' })).resolves.toEqual({
      status: 'rosterUnreadable',
      sourceTeamName: ALPHA,
    });
    expect(previewStore.size).toBe(0);
    expect(gatewayFixture.create).not.toHaveBeenCalled();
  });

  it('returns every source-state outcome the contract defines', async () => {
    const unavailable: CustomTeamTemplateSnapshotReader = {
      readSnapshot: () => Promise.resolve({ status: 'sourceUnavailable', sourceTeamName: ALPHA }),
    };
    await expect(
      build({ reader: unavailable, gateway: gatewayFixture.value }).useCase.execute({
        sourceTeamName: ALPHA,
        name: 'Name',
      })
    ).resolves.toEqual({ status: 'sourceUnavailable', sourceTeamName: ALPHA });

    const changed: CustomTeamTemplateSnapshotReader = {
      readSnapshot: () =>
        Promise.resolve({ status: 'configurationChanged', sourceTeamName: ALPHA }),
    };
    await expect(
      build({ reader: changed, gateway: gatewayFixture.value }).useCase.execute({
        sourceTeamName: ALPHA,
        name: 'Name',
      })
    ).resolves.toEqual({ status: 'sourceUnavailable', sourceTeamName: ALPHA });
  });

  it('reports a case-insensitive name conflict without issuing a token', async () => {
    const existing: CustomTeamTemplateV1 = {
      templateId: 'tmpl-existing',
      name: 'Release Pipeline',
      schemaVersion: 1,
      teamPrompt: '',
      members: [],
    };
    const { useCase, previewStore } = build({
      reader: readerFixture.reader,
      gateway: gateway([existing]).value,
    });

    await expect(
      useCase.execute({ sourceTeamName: ALPHA, name: '  release   PIPELINE ' })
    ).resolves.toEqual({ status: 'nameConflict', existingTemplateId: 'tmpl-existing' });
    expect(previewStore.size).toBe(0);
  });

  it('fails closed when the library cannot be read', async () => {
    const failing: CustomTeamTemplateStorageGateway = {
      customTeamTemplateCreate: vi.fn(),
      customTeamTemplateList: vi.fn().mockRejectedValue(new Error('worker unavailable')),
      customTeamTemplateGetById: vi.fn(),
    };
    await expect(
      build({ reader: readerFixture.reader, gateway: failing }).useCase.execute({
        sourceTeamName: ALPHA,
        name: 'Name',
      })
    ).resolves.toEqual({ status: 'storageUnavailable' });

    await expect(
      build({ reader: readerFixture.reader, gateway: null }).useCase.execute({
        sourceTeamName: ALPHA,
        name: 'Name',
      })
    ).resolves.toEqual({ status: 'storageUnavailable' });
  });

  it('keeps working when the roster is absent or validly empty', async () => {
    const snapshotWith = (roster: CustomTemplateSourceTeamSnapshot['roster']) => {
      const reader: CustomTeamTemplateSnapshotReader = {
        readSnapshot: () =>
          Promise.resolve({
            status: 'available',
            snapshot: { sourceTeamName: ALPHA, teamPrompt: 'Prompt.', roster },
            revision: 'revision-1',
          } as const),
      };
      return build({ reader, gateway: gatewayFixture.value }).useCase;
    };

    const absent = await snapshotWith({ status: 'absent' }).execute({
      sourceTeamName: ALPHA,
      name: 'Prompt only',
    });
    const empty = await snapshotWith({ status: 'readable', members: [] }).execute({
      sourceTeamName: ALPHA,
      name: 'Empty roster',
    });

    expect(absent.status).toBe('previewReady');
    expect(empty.status).toBe('previewReady');
    if (absent.status !== 'previewReady' || empty.status !== 'previewReady') return;
    expect(absent.preview.warnings).toEqual([{ code: 'noRecordedRoster' }]);
    expect(empty.preview.warnings).toEqual([{ code: 'emptyRoster' }]);
    expect(absent.preview.members).toEqual([]);
    expect(empty.preview.members).toEqual([]);
  });
});
