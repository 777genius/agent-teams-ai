import { ExportCustomTeamTemplateUseCase } from '@features/custom-team-templates/core/application/ExportCustomTeamTemplateUseCase';
import { NodeCustomTeamTemplateHasher } from '@features/custom-team-templates/main/adapters/output/NodeCustomTeamTemplateHasher';
import { describe, expect, it, vi } from 'vitest';

import type { CustomTeamTemplateStorageGateway } from '@features/custom-team-templates/core/application/ports';

describe('ExportCustomTeamTemplateUseCase', () => {
  it('exports portable data without internals', async () => {
    const template = { templateId: 'tmpl-1', name: 'N', schemaVersion: 1, teamPrompt: 'hi', members: [{ name: 'a' }], createdAt: '2026-01-01', revision: 2 };
    const gw: CustomTeamTemplateStorageGateway = {
      customTeamTemplateCreate: vi.fn(),
      customTeamTemplateList: vi.fn(),
      customTeamTemplateGetById: vi.fn().mockResolvedValue({ status: 'found', template }),
      customTeamTemplateUpdate: vi.fn(),
      customTeamTemplateDelete: vi.fn(),
    };
    const uc = new ExportCustomTeamTemplateUseCase({ gateway: gw });
    const res = await uc.execute({ templateId: 'tmpl-1' });
    expect(res.status).toBe('exported');
    if (res.status === 'exported') {
      expect((res.portable as any).templateId).toBeUndefined();
      expect((res.portable as any).revision).toBeUndefined();
      expect(res.portable.name).toBe('N');
      expect(res.portable.teamPrompt).toBe('hi');
      expect(res.portable.format).toBe('agent-teams-custom-template');
    }
  });

  it('returns notFound for missing', async () => {
    const gw: CustomTeamTemplateStorageGateway = {
      customTeamTemplateCreate: vi.fn(),
      customTeamTemplateList: vi.fn(),
      customTeamTemplateGetById: vi.fn().mockResolvedValue({ status: 'notFound' }),
      customTeamTemplateUpdate: vi.fn(),
      customTeamTemplateDelete: vi.fn(),
    };
    const uc = new ExportCustomTeamTemplateUseCase({ gateway: gw });
    const res = await uc.execute({ templateId: 'missing' });
    expect(res.status).toBe('notFound');
  });

  it('storage unavailable when null gateway', async () => {
    const uc = new ExportCustomTeamTemplateUseCase({ gateway: null });
    const res = await uc.execute({ templateId: 'x' });
    expect(res.status).toBe('storageUnavailable');
  });
});