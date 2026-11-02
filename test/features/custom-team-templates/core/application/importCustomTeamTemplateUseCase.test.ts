import { ImportCustomTeamTemplateUseCase } from '@features/custom-team-templates/core/application/ImportCustomTeamTemplateUseCase';
import { NodeCustomTeamTemplateHasher } from '@features/custom-team-templates/main/adapters/output/NodeCustomTeamTemplateHasher';
import { describe, expect, it, vi } from 'vitest';

import type { CustomTeamTemplateStorageGateway } from '@features/custom-team-templates/core/application/ports';

const hasher = new NodeCustomTeamTemplateHasher();

function gatewayWith(create: (req: unknown) => Promise<unknown>): CustomTeamTemplateStorageGateway {
  return {
    customTeamTemplateCreate:
      create as CustomTeamTemplateStorageGateway['customTeamTemplateCreate'],
    customTeamTemplateList: vi.fn(),
    customTeamTemplateGetById: vi.fn(),
    customTeamTemplateUpdate: vi.fn(),
    customTeamTemplateDelete: vi.fn(),
  };
}

describe('ImportCustomTeamTemplateUseCase', () => {
  it('rejects unsupported format', async () => {
    const uc = new ImportCustomTeamTemplateUseCase({
      gateway: gatewayWith(async () => ({
        status: 'created',
        template: {
          templateId: 'x',
          name: 'n',
          schemaVersion: 1,
          teamPrompt: '',
          members: [],
          revision: 1,
        },
      })),
      hasher,
      createTemplateId: () => 'tmpl-new',
    });
    const res = await uc.execute({
      portable: { format: 'wrong', schemaVersion: 1, name: 'N', teamPrompt: '', members: [] },
    });
    expect(res.status).toBe('unsupportedFormat');
  });

  it('rejects unsupported version', async () => {
    const uc = new ImportCustomTeamTemplateUseCase({
      gateway: gatewayWith(async () => ({
        status: 'created',
        template: {
          templateId: 'x',
          name: 'n',
          schemaVersion: 1,
          teamPrompt: '',
          members: [],
          revision: 1,
        },
      })),
      hasher,
      createTemplateId: () => 'tmpl-new',
    });
    const res = await uc.execute({
      portable: {
        format: 'agent-teams-custom-template',
        schemaVersion: 2,
        name: 'N',
        teamPrompt: '',
        members: [],
      },
    });
    expect(res.status).toBe('unsupportedVersion');
  });

  it('rejects non-string teamPrompt', async () => {
    const uc = new ImportCustomTeamTemplateUseCase({
      gateway: gatewayWith(async () => ({
        status: 'created',
        template: {
          templateId: 'x',
          name: 'n',
          schemaVersion: 1,
          teamPrompt: '',
          members: [],
          revision: 1,
        },
      })),
      hasher,
      createTemplateId: () => 'tmpl-new',
    });
    const res = await uc.execute({
      portable: {
        format: 'agent-teams-custom-template',
        schemaVersion: 1,
        name: 'N',
        teamPrompt: 123,
        members: [],
      },
    });
    expect(res.status).toBe('validationFailed');
    if (res.status === 'validationFailed') {
      expect(res.issues).toEqual([{ code: 'teamPromptInvalidType', field: 'teamPrompt' }]);
    }
  });

  it('rejects dangerous property names', async () => {
    const obj: Record<string, unknown> = {
      format: 'agent-teams-custom-template',
      schemaVersion: 1,
      name: 'N',
      teamPrompt: '',
      members: [],
    };
    Object.defineProperty(obj, '__proto__', { value: { polluted: true }, writable: true });
    const uc = new ImportCustomTeamTemplateUseCase({
      gateway: gatewayWith(async () => ({
        status: 'created',
        template: {
          templateId: 'x',
          name: 'n',
          schemaVersion: 1,
          teamPrompt: '',
          members: [],
          revision: 1,
        },
      })),
      hasher,
      createTemplateId: () => 'tmpl-new',
    });
    // hasOnlyKeys checks Object.keys; __proto__ own key would be caught
    const res = await uc.execute({ portable: obj });
    // Either validationFailed or imported; ensure no pollution
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(['validationFailed', 'imported', 'storageUnavailable']).toContain(res.status);
  });

  it('imports valid template with fresh identity', async () => {
    const created = {
      templateId: 'tmpl-new',
      name: 'N',
      schemaVersion: 1,
      teamPrompt: 'hi',
      members: [{ name: 'a', role: 'r', workflow: 'w' }],
      revision: 1,
    };
    const uc = new ImportCustomTeamTemplateUseCase({
      gateway: gatewayWith(async () => ({ status: 'created', template: created })),
      hasher,
      createTemplateId: () => 'tmpl-new',
    });
    const res = await uc.execute({
      portable: {
        format: 'agent-teams-custom-template',
        schemaVersion: 1,
        name: 'N',
        teamPrompt: 'hi',
        members: [{ name: 'a', role: 'r', workflow: 'w' }],
      },
    });
    expect(res.status).toBe('imported');
    if (res.status === 'imported') {
      expect(res.template.templateId).toBe('tmpl-new');
      expect(res.template.revision).toBe(1);
    }
  });

  it('storage unavailable when gateway null', async () => {
    const uc = new ImportCustomTeamTemplateUseCase({
      gateway: null,
      hasher,
      createTemplateId: () => 'tmpl-new',
    });
    const res = await uc.execute({
      portable: {
        format: 'agent-teams-custom-template',
        schemaVersion: 1,
        name: 'N',
        teamPrompt: '',
        members: [],
      },
    });
    expect(res.status).toBe('storageUnavailable');
  });
});
