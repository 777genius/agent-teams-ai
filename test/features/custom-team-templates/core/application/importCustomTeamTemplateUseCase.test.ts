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

  it('reports an unexpected top-level property with its own issue code', async () => {
    const uc = new ImportCustomTeamTemplateUseCase({
      gateway: gatewayWith(async () => ({
        status: 'created',
        template: {
          templateId: 'x',
          name: 'N',
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
        name: 'Valid Name',
        teamPrompt: '',
        members: [],
        templateId: 'tmpl-stolen',
      },
    });

    expect(res.status).toBe('validationFailed');
    if (res.status === 'validationFailed') {
      // The name is valid, so it must never be reported as missing.
      expect(res.issues).toEqual([
        { code: 'unexpectedProperty', field: 'templateId', parameter: 'templateId' },
      ]);
      expect(res.issues[0]?.code).not.toBe('templateNameRequired');
    }
  });

  it('reports an unexpected member property instead of blaming the member name', async () => {
    const uc = new ImportCustomTeamTemplateUseCase({
      gateway: gatewayWith(async () => ({
        status: 'created',
        template: {
          templateId: 'x',
          name: 'N',
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
        teamPrompt: '',
        members: [{ name: 'a', role: 'r', workflow: 'w', provider: 'attacker' }],
      },
    });

    expect(res.status).toBe('validationFailed');
    if (res.status === 'validationFailed') {
      expect(res.issues).toEqual([
        { code: 'unexpectedProperty', field: 'members[0].provider', parameter: 'provider' },
      ]);
    }
  });

  it('rejects dangerous own property names without polluting prototypes', async () => {
    const cases: readonly string[] = ['__proto__', 'constructor', 'prototype'];
    for (const dangerousKey of cases) {
      const obj: Record<string, unknown> = {
        format: 'agent-teams-custom-template',
        schemaVersion: 1,
        name: 'N',
        teamPrompt: '',
        members: [],
      };
      // An own *enumerable* key is what JSON.parse produces for this input, so
      // this is the shape the allowlist actually has to reject.
      Object.defineProperty(obj, dangerousKey, {
        value: { polluted: true },
        enumerable: true,
        writable: true,
        configurable: true,
      });

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

      const res = await uc.execute({ portable: obj });

      expect(res.status).toBe('validationFailed');
      if (res.status === 'validationFailed') {
        expect(res.issues[0]?.code).toBe('unexpectedProperty');
        expect(res.issues[0]?.parameter).toBe(dangerousKey);
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    }
  });

  it('rejects dangerous keys that arrive from a parsed JSON document', async () => {
    const parsed = JSON.parse(
      '{"format":"agent-teams-custom-template","schemaVersion":1,"name":"N","teamPrompt":"","members":[],"__proto__":{"polluted":true}}'
    ) as unknown;
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

    const res = await uc.execute({ portable: parsed });

    expect(res.status).toBe('validationFailed');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
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
