import { ImportCustomTeamTemplateUseCase } from '@features/custom-team-templates/core/application/ImportCustomTeamTemplateUseCase';
import { CustomTeamTemplateStorageInterruptedError } from '@features/custom-team-templates/core/application/CustomTeamTemplateStorageInterruptedError';
import { serializeCanonicalTemplateContent } from '@features/custom-team-templates/core/domain/canonicalTemplateSerialization';
import { NodeCustomTeamTemplateHasher } from '@features/custom-team-templates/main/adapters/output/NodeCustomTeamTemplateHasher';
import { CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION } from '@features/custom-team-templates/contracts';
import { describe, expect, it, vi } from 'vitest';

import type {
  CreateCustomTeamTemplateRecordRequest,
  CreateCustomTeamTemplateRecordResult,
  CustomTeamTemplateV1,
} from '@features/custom-team-templates/contracts';
import type { CustomTeamTemplateStorageGateway } from '@features/custom-team-templates/core/application/ports';

const hasher = new NodeCustomTeamTemplateHasher();

function gatewayWith(
  create: (
    request: CreateCustomTeamTemplateRecordRequest
  ) => CreateCustomTeamTemplateRecordResult | Promise<CreateCustomTeamTemplateRecordResult>
): CustomTeamTemplateStorageGateway {
  return {
    customTeamTemplateCreate:
      create as CustomTeamTemplateStorageGateway['customTeamTemplateCreate'],
    customTeamTemplateList: vi.fn(),
    customTeamTemplateGetById: vi.fn(),
    customTeamTemplateUpdate: vi.fn(),
    customTeamTemplateDelete: vi.fn(),
  };
}

function validPortable(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'agent-teams-custom-template',
    schemaVersion: 1,
    name: 'Valid Name',
    teamPrompt: '',
    members: [],
    ...overrides,
  };
}

describe('ImportCustomTeamTemplateUseCase', () => {
  it('rejects unsupported format', async () => {
    const uc = new ImportCustomTeamTemplateUseCase({
      gateway: gatewayWith(() => ({
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
    expect(res).toEqual({ status: 'unsupportedFormat' });
  });

  it('rejects unsupported version', async () => {
    const uc = new ImportCustomTeamTemplateUseCase({
      gateway: gatewayWith(() => ({
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
    expect(res).toEqual({ status: 'unsupportedVersion' });
  });

  it('rejects non-string teamPrompt', async () => {
    const uc = new ImportCustomTeamTemplateUseCase({
      gateway: gatewayWith(() => ({
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
      gateway: gatewayWith(() => ({
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
      gateway: gatewayWith(() => ({
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
        gateway: gatewayWith(() => ({
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
      gateway: gatewayWith(() => ({
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
    const created: CustomTeamTemplateV1 = {
      templateId: 'tmpl-new',
      name: 'N',
      schemaVersion: 1,
      teamPrompt: 'hi',
      members: [{ name: 'a', role: 'r', workflow: 'w' }],
      revision: 1,
    };
    const uc = new ImportCustomTeamTemplateUseCase({
      gateway: gatewayWith(() => ({ status: 'created', template: created })),
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

  describe('bounded unsupported results', () => {
    function useCase(): ImportCustomTeamTemplateUseCase {
      return new ImportCustomTeamTemplateUseCase({
        gateway: gatewayWith(() => ({
          status: 'created',
          template: { templateId: 'x', name: 'x', schemaVersion: 1, teamPrompt: '', members: [], revision: 1 },
        })),
        hasher,
        createTemplateId: () => 'tmpl-new',
      });
    }

    it('never echoes a top-level array', async () => {
      const res = await useCase().execute([1, 2, 3]);
      expect(res).toEqual({ status: 'unsupportedFormat' });
    });

    it('never echoes a top-level string', async () => {
      const res = await useCase().execute('not-a-template');
      expect(res).toEqual({ status: 'unsupportedFormat' });
    });

    it('never echoes a very large format string', async () => {
      const res = await useCase().execute({
        portable: validPortable({ format: 'x'.repeat(1_000_000) }),
      });
      expect(res).toEqual({ status: 'unsupportedFormat' });
    });

    it('never exposes an object-valued format', async () => {
      const res = await useCase().execute({
        portable: validPortable({ format: { nested: ['x'] } }),
      });
      expect(res).toEqual({ status: 'unsupportedFormat' });
    });

    it('keeps a deeply nested rejection bounded', async () => {
      let deep: unknown = 'leaf';
      for (let i = 0; i < 200; i += 1) {
        deep = { nested: deep };
      }
      const res = await useCase().execute({ portable: validPortable({ format: deep }) });
      expect(res).toEqual({ status: 'unsupportedFormat' });
      expect(JSON.stringify(res)).toBe('{"status":"unsupportedFormat"}');
    });

    it('never echoes a very large schemaVersion string', async () => {
      const res = await useCase().execute({
        portable: validPortable({ schemaVersion: 'v'.repeat(1_000_000) }),
      });
      expect(res).toEqual({ status: 'unsupportedVersion' });
    });

    it('never exposes an object or array schemaVersion', async () => {
      const objectVersion = await useCase().execute({
        portable: validPortable({ schemaVersion: { major: 1 } }),
      });
      const arrayVersion = await useCase().execute({
        portable: validPortable({ schemaVersion: [1] }),
      });
      expect(objectVersion).toEqual({ status: 'unsupportedVersion' });
      expect(arrayVersion).toEqual({ status: 'unsupportedVersion' });
    });
  });

  describe('teamPrompt normalization', () => {
    function capturingUseCase(): {
      uc: ImportCustomTeamTemplateUseCase;
      requests: CreateCustomTeamTemplateRecordRequest[];
    } {
      const requests: CreateCustomTeamTemplateRecordRequest[] = [];
      const uc = new ImportCustomTeamTemplateUseCase({
        gateway: gatewayWith((request) => {
          requests.push(request);
          return { status: 'created', template: { ...request.template, revision: 1 } };
        }),
        hasher,
        createTemplateId: () => 'tmpl-new',
      });
      return { uc, requests };
    }

    it('trims only the prompt edges and hashes the persisted value', async () => {
      const { uc, requests } = capturingUseCase();
      const res = await uc.execute({
        portable: validPortable({ teamPrompt: '  Build\n  Test  ' }),
      });

      expect(res.status).toBe('imported');
      expect(requests).toHaveLength(1);
      expect(requests[0].template.teamPrompt).toBe('Build\n  Test');
      expect(requests[0].contentHash).toBe(
        hasher.hashCanonicalContent(
          serializeCanonicalTemplateContent({
            schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
            teamPrompt: 'Build\n  Test',
            members: [],
          })
        )
      );
    });

    it('preserves internal newlines, indentation and Unicode', async () => {
      const prompt = '\n  Build\n\tTest ✓\n  ';
      const { uc, requests } = capturingUseCase();
      await uc.execute({ portable: validPortable({ teamPrompt: prompt }) });

      expect(requests[0].template.teamPrompt).toBe('Build\n\tTest ✓');
    });

    it('persists whitespace-only prompts as the established empty prompt', async () => {
      const { uc, requests } = capturingUseCase();
      const res = await uc.execute({ portable: validPortable({ teamPrompt: '   \n\t  ' }) });

      expect(res.status).toBe('imported');
      expect(requests[0].template.teamPrompt).toBe('');
    });

    it('keeps persisted content and hash aligned with an unchanged update', async () => {
      const { uc, requests } = capturingUseCase();
      await uc.execute({ portable: validPortable({ teamPrompt: '  Build\nTest  ' }) });

      // An edit that leaves the prompt untouched trims it again in the update
      // use case, so the canonical hash must not see a spurious difference.
      const updateHash = hasher.hashCanonicalContent(
        serializeCanonicalTemplateContent({
          schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
          teamPrompt: 'Build\nTest',
          members: [],
        })
      );
      expect(requests[0].template.teamPrompt).toBe('Build\nTest');
      expect(requests[0].contentHash).toBe(updateHash);
    });
  });

  describe('generated id collisions', () => {
    function createdTemplate(request: CreateCustomTeamTemplateRecordRequest) {
      return { ...request.template, revision: 1 };
    }

    it('rotates to a fresh id after a definitive id collision', async () => {
      const ids = ['tmpl-collides', 'tmpl-fresh'];
      const createTemplateId = vi.fn(() => {
        const id = ids.shift();
        if (!id) throw new Error('unexpected id allocation');
        return id;
      });
      const requests: CreateCustomTeamTemplateRecordRequest[] = [];
      const uc = new ImportCustomTeamTemplateUseCase({
        gateway: gatewayWith((request): CreateCustomTeamTemplateRecordResult => {
          requests.push(request);
          if (requests.length === 1) {
            return {
              status: 'conflict',
              reason: 'idReusedWithDifferentContent',
              existingTemplateId: request.template.templateId,
            };
          }
          return { status: 'created', template: createdTemplate(request) };
        }),
        hasher,
        createTemplateId,
      });

      const res = await uc.execute({ portable: validPortable({ teamPrompt: 'hi' }) });

      expect(res.status).toBe('imported');
      if (res.status === 'imported') {
        expect(res.template.templateId).toBe('tmpl-fresh');
      }
      expect(createTemplateId).toHaveBeenCalledTimes(2);
      expect(requests.map((request) => request.template.templateId)).toEqual([
        'tmpl-collides',
        'tmpl-fresh',
      ]);
      expect(requests[0].template.teamPrompt).toBe(requests[1].template.teamPrompt);
      expect(requests[0].contentHash).toBe(requests[1].contentHash);
      expect(requests[1].template).toEqual({
        ...requests[0].template,
        templateId: 'tmpl-fresh',
      });
    });

    it('keeps the same id for a generic retryable status', async () => {
      const requests: CreateCustomTeamTemplateRecordRequest[] = [];
      const createTemplateId = vi.fn(() => 'tmpl-stable');
      const uc = new ImportCustomTeamTemplateUseCase({
        gateway: gatewayWith((request): CreateCustomTeamTemplateRecordResult => {
          requests.push(request);
          if (requests.length === 1) {
            return { status: 'retryable', reason: 'databaseBusy' };
          }
          return { status: 'created', template: createdTemplate(request) };
        }),
        hasher,
        createTemplateId,
      });

      const res = await uc.execute({ portable: validPortable({ teamPrompt: 'hi' }) });

      expect(res.status).toBe('imported');
      expect(createTemplateId).toHaveBeenCalledTimes(1);
      expect(requests.map((request) => request.template.templateId)).toEqual([
        'tmpl-stable',
        'tmpl-stable',
      ]);
      expect(requests[0].contentHash).toBe(requests[1].contentHash);
    });

    it('does not rotate identity after an unknown execution', async () => {
      const ids = ['tmpl-uncertain'];
      const requests: CreateCustomTeamTemplateRecordRequest[] = [];
      const gateway = gatewayWith((request): CreateCustomTeamTemplateRecordResult => {
        requests.push(request);
        if (requests.length === 1) {
          throw new CustomTeamTemplateStorageInterruptedError(
            'worker died',
            'unknown',
            Promise.resolve()
          );
        }
        return {
          status: 'conflict',
          reason: 'idReusedWithDifferentContent',
          existingTemplateId: request.template.templateId,
        };
      });
      // Reconciliation proves the first write is absent, so the use case retries
      // before it observes the definitive conflict.
      gateway.customTeamTemplateGetById = vi.fn(() => Promise.resolve({ status: 'notFound' as const }));

      const uc = new ImportCustomTeamTemplateUseCase({
        gateway,
        hasher,
        createTemplateId: () => {
          const id = ids.shift();
          if (!id) throw new Error('unknown execution must not allocate a new id');
          return id;
        },
      });

      const res = await uc.execute({ portable: validPortable({ teamPrompt: 'hi' }) });

      expect(res).toEqual({ status: 'unresolvedWriteOutcome', templateId: 'tmpl-uncertain' });
      expect(requests.map((request) => request.template.templateId)).toEqual([
        'tmpl-uncertain',
        'tmpl-uncertain',
      ]);
    });

    it('respects the bounded retry limit after repeated collisions', async () => {
      const ids = ['tmpl-first', 'tmpl-second'];
      const uc = new ImportCustomTeamTemplateUseCase({
        gateway: gatewayWith(
          (request): CreateCustomTeamTemplateRecordResult => ({
            status: 'conflict',
            reason: 'idReusedWithDifferentContent',
            existingTemplateId: request.template.templateId,
          })
        ),
        hasher,
        createTemplateId: () => {
          const id = ids.shift();
          if (!id) throw new Error('retry limit exceeded');
          return id;
        },
      });

      const res = await uc.execute({ portable: validPortable({ teamPrompt: 'hi' }) });

      expect(res).toEqual({ status: 'templateIdConflict', templateId: 'tmpl-second' });
    });
  });
});
