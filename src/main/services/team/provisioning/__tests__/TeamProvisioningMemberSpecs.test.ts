import { describe, expect, it } from 'vitest';

import { buildEffectiveTeamMemberSpec } from '../TeamProvisioningMemberSpecs';

describe('TeamProvisioningMemberSpecs', () => {
  it('keeps legacy lead-model inheritance when the sync preference is absent', () => {
    expect(
      buildEffectiveTeamMemberSpec(
        { name: 'builder' },
        { providerId: 'codex', model: 'gpt-5.6-sol', effort: 'high' }
      )
    ).toEqual({
      name: 'builder',
      providerId: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
    });
  });

  it('uses the teammate provider default when lead-model sync is disabled', () => {
    expect(
      buildEffectiveTeamMemberSpec(
        { name: 'builder' },
        {
          providerId: 'codex',
          model: 'gpt-5.6-sol',
          effort: 'high',
          syncModelsWithLead: false,
        }
      )
    ).toEqual({
      name: 'builder',
      providerId: 'codex',
      model: undefined,
      effort: undefined,
    });
  });

  it('preserves an explicit teammate model when lead-model sync is disabled', () => {
    expect(
      buildEffectiveTeamMemberSpec(
        { name: 'builder', model: 'gpt-5.5', effort: 'medium' },
        {
          providerId: 'codex',
          model: 'gpt-5.6-sol',
          effort: 'high',
          syncModelsWithLead: false,
        }
      )
    ).toEqual({
      name: 'builder',
      providerId: 'codex',
      model: 'gpt-5.5',
      effort: 'medium',
    });
  });
});
