import { describe, expect, it } from 'vitest';

import {
  canAttemptOpenCodeDefaultSelection,
  needsOpenCodeModelExecutionProof,
} from './runtimeProviderModelAccess';

import type { RuntimeProviderModelDto } from '@features/runtime-provider-management/contracts';

function model(overrides: Partial<RuntimeProviderModelDto> = {}): RuntimeProviderModelDto {
  return {
    modelId: 'local/test-model',
    providerId: 'local',
    displayName: 'Test Model',
    sourceLabel: 'Local',
    free: true,
    default: false,
    catalogStatus: 'active',
    availability: 'untested',
    accessKind: 'configured_authless',
    routeKind: 'configured_local',
    proofState: 'needs_probe',
    requiresExecutionProof: true,
    ...overrides,
  };
}

describe('needsOpenCodeModelExecutionProof', () => {
  it.each([
    ['deprecated catalog with pending proof', { catalogStatus: 'deprecated' }],
    ['failed proof with a stale proof requirement', { proofState: 'failed' }],
    ['unavailable model', { availability: 'unavailable' }],
    ['unauthenticated availability', { availability: 'not-authenticated' }],
    ['unauthenticated access', { accessKind: 'not_authenticated' }],
    ['failed execution access', { accessKind: 'execution_failed' }],
    ['unknown model route', { accessKind: 'unknown_model' }],
    ['missing model route', { accessKind: 'no_model' }],
  ] satisfies readonly [string, Partial<RuntimeProviderModelDto>][])(
    'returns false for hard-negative evidence: %s',
    (_label, overrides) => {
      expect(needsOpenCodeModelExecutionProof(model(overrides))).toBe(false);
    }
  );

  it.each([
    ['verified proof', { proofState: 'verified' }],
    ['available model', { availability: 'available' }],
    ['verified access', { accessKind: 'verified' }],
  ] satisfies readonly [string, Partial<RuntimeProviderModelDto>][])(
    'returns false for completed positive evidence: %s',
    (_label, overrides) => {
      expect(needsOpenCodeModelExecutionProof(model(overrides))).toBe(false);
    }
  );

  it.each([
    ['explicit needs-probe state', { proofState: 'needs_probe', requiresExecutionProof: false }],
    [
      'explicit execution-proof requirement',
      { proofState: 'not_required', requiresExecutionProof: true },
    ],
  ] satisfies readonly [string, Partial<RuntimeProviderModelDto>][])(
    'returns true for genuine pending execution proof: %s',
    (_label, overrides) => {
      expect(needsOpenCodeModelExecutionProof(model(overrides))).toBe(true);
    }
  );
});

describe('canAttemptOpenCodeDefaultSelection', () => {
  it('lets the neutral all-projects probe decide project-scoped availability failures', () => {
    const projectUnavailableModel = model({
      availability: 'not-authenticated',
      accessKind: 'not_authenticated',
      proofState: 'failed',
    });

    expect(canAttemptOpenCodeDefaultSelection(projectUnavailableModel, 'project')).toBe(false);
    expect(canAttemptOpenCodeDefaultSelection(projectUnavailableModel, 'all_projects')).toBe(true);
  });

  it.each([
    ['deprecated catalog route', { catalogStatus: 'deprecated' }],
    ['unknown catalog route', { accessKind: 'unknown_model' }],
    ['missing catalog route', { accessKind: 'no_model' }],
  ] satisfies readonly [string, Partial<RuntimeProviderModelDto>][])(
    'keeps universal hard negatives blocked for all projects: %s',
    (_label, overrides) => {
      expect(canAttemptOpenCodeDefaultSelection(model(overrides), 'all_projects')).toBe(false);
    }
  );
});
