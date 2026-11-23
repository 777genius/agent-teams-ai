import { describe, expect, it, vi } from 'vitest';

import { applyTemplateToCreateTeam } from './applyTemplateToCreateTeam';

import type { UseCreateTeamTemplateSelectionResult } from './useCreateTeamTemplateSelection';

describe('applying a team template', () => {
  it('replaces template content without changing the selected provider or model', () => {
    const selection = {
      setAppliedTemplateSource: vi.fn(),
      templateSelectionDraft: { setValue: vi.fn() },
    } as unknown as UseCreateTeamTemplateSelectionResult;
    const options = {
      templateSelection: selection,
      descriptionDraft: { setValue: vi.fn() },
      promptDraft: { setValue: vi.fn() },
      promptChipDraft: { clearChipDraft: vi.fn() },
      setMembers: vi.fn(),
      setLaunchTeam: vi.fn(),
      setSoloTeam: vi.fn(),
      setSyncModelsWithLead: vi.fn(),
      setRuntimeSelection: vi.fn(),
    };
    applyTemplateToCreateTeam(
      {
        runtimeSelectionVersion: 1,
        description: 'Review',
        prompt: 'Inspect',
        members: [{ name: 'reviewer', role: 'reviewer' }],
        syncModelsWithLead: true,
      },
      'custom',
      'custom:test',
      options
    );
    expect(options.setRuntimeSelection).not.toHaveBeenCalled();
    expect(options.setMembers).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ name: 'reviewer', roleSelection: 'reviewer' }),
      ])
    );
    expect(options.promptDraft.setValue).toHaveBeenCalledWith('Inspect');
  });
});
