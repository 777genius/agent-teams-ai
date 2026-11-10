import { parseTeamProvisioningBooleanOptions } from '@main/ipc/teamIpcRequestParsers';
import { describe, expect, it } from 'vitest';

describe('parseTeamProvisioningBooleanOptions', () => {
  it('preserves supported boolean values', () => {
    expect(
      parseTeamProvisioningBooleanOptions({
        allowExperimentalLocalModels: true,
        limitContext: false,
        skipPermissions: true,
        syncModelsWithLead: false,
      })
    ).toEqual({
      valid: true,
      value: {
        allowExperimentalLocalModels: true,
        limitContext: false,
        skipPermissions: true,
        syncModelsWithLead: false,
      },
    });
  });

  it('keeps omitted options undefined', () => {
    expect(parseTeamProvisioningBooleanOptions({})).toEqual({
      valid: true,
      value: {
        allowExperimentalLocalModels: undefined,
        limitContext: undefined,
        skipPermissions: undefined,
        syncModelsWithLead: undefined,
      },
    });
  });

  it('rejects a non-boolean sync preference', () => {
    expect(parseTeamProvisioningBooleanOptions({ syncModelsWithLead: 'false' })).toEqual({
      valid: false,
      error: 'syncModelsWithLead must be a boolean',
    });
  });
});
