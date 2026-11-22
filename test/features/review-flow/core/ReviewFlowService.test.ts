import { ReviewFlowService, ReviewFlowValidationError } from '@features/review-flow/core/application';
import { describe, expect, it, vi } from 'vitest';

import type { ReviewFlowSettings, TeamReviewFlowOverrides } from '@features/review-flow';

function createService(overrides: TeamReviewFlowOverrides = {}, unreadable: string[] = []) {
  let defaults: ReviewFlowSettings = { reviewFlow: 'agent_approval', reviewFlowPrompt: '' };
  const ports = {
    defaults: {
      read: vi.fn(async () => defaults),
      write: vi.fn(async (next: ReviewFlowSettings) => (defaults = next)),
    },
    teams: {
      writeOverride: vi.fn(async () => undefined),
      listOverrides: vi.fn(async () => ({ overrides, unreadable, projectTeams: { builders: { saved: true, settings: null, projects: [] } } })),
    },
  };
  return { service: new ReviewFlowService(ports), ports };
}

describe('ReviewFlowService', () => {
  it('returns the default together with the teams that override it', async () => {
    const custom = { reviewFlow: 'human_approval', reviewFlowPrompt: '' } as const;
    const { service } = createService({ alpha: custom });
    expect(await service.getOverview()).toEqual({
      defaults: { reviewFlow: 'agent_approval', reviewFlowPrompt: '' },
      overrides: { alpha: custom },
      unreadableTeams: [],
      projectTeams: { builders: { saved: true, settings: null, projects: [] } },
    });
  });

  it('keeps the screen usable when the saved default cannot be read', async () => {
    const { service, ports } = createService({}, ['broken-team']);
    ports.defaults.read.mockRejectedValueOnce(new Error('Review flow defaults are corrupt'));
    expect(await service.getOverview()).toEqual({
      defaults: { reviewFlow: 'agent_approval', reviewFlowPrompt: '' },
      defaultsError: 'Review flow defaults are corrupt',
      overrides: {},
      unreadableTeams: ['broken-team'],
      projectTeams: { builders: { saved: true, settings: null, projects: [] } },
    });
  });

  it('validates before touching any port', async () => {
    const { service, ports } = createService();
    await expect(service.saveDefaults({ reviewFlow: 'everyone' })).rejects.toBeInstanceOf(
      ReviewFlowValidationError
    );
    await expect(service.saveTeamOverride('alpha', { reviewFlowPrompt: 'x' })).rejects.toBeInstanceOf(
      ReviewFlowValidationError
    );
    await expect(service.saveTeamOverride('  ', null)).rejects.toBeInstanceOf(ReviewFlowValidationError);
    // A missing value must never be read as "remove the override".
    await expect(service.saveTeamOverride('alpha', undefined)).rejects.toBeInstanceOf(
      ReviewFlowValidationError
    );
    expect(ports.defaults.write).not.toHaveBeenCalled();
    expect(ports.teams.writeOverride).not.toHaveBeenCalled();
  });

  it('saves normalised settings and removes an override with null', async () => {
    const { service, ports } = createService();
    expect(
      await service.saveDefaults({ reviewFlow: 'human_approval', reviewFlowPrompt: ' Hi ' })
    ).toEqual({ reviewFlow: 'human_approval', reviewFlowPrompt: 'Hi' });
    expect(await service.saveTeamOverride('alpha', null)).toBeNull();
    expect(ports.teams.writeOverride).toHaveBeenCalledWith('alpha', null);
  });
});
