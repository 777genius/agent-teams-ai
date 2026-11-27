import { describe, expect, it, vi } from 'vitest';

import { selectedLaunchConfiguration } from '../../../packages/legacy-agent-host/dist/composition/executeTeamLaunch.js';
import { runtimeMemberProfileSchema } from '../../../packages/legacy-agent-host/dist/composition/runtimeProfile.js';
import { opencodeV2ModelProbeProfile } from '../../../packages/legacy-agent-host/tests/fixtures/opencode-v2-model-probe-profile';
import { projectLaunchModelConfiguration } from '../../../src/features/agent-backend/main/adapters/output/projectLaunchConfiguration';
import { createOpenCodeInputDeclarationResolver } from '../../../src/features/runtime-provider-management/core/application/resolveOpenCodeInputDeclaration';
import { models } from '../../../src/features/runtime-provider-management/main/adapters/output/capturedManagementCatalog';

function profile(providerId: string, model: string) {
  const base = opencodeV2ModelProbeProfile('/TEST/model-presentation', model);
  return runtimeMemberProfileSchema.parse({
    ...base,
    nativeOptions: { ...base.nativeOptions, providerId },
  });
}
function project(selected: unknown) {
  return projectLaunchModelConfiguration({
    source: { sourceId: 'TEST-source', rosterRevision: 'TEST-roster' },
    members: [{ memberId: 'TEST-member', label: 'TEST-lead', role: 'lead', selected }],
  }).members[0].selected!;
}

describe('captured OpenCode model presentation boundary', () => {
  it.each([
    'TEST-model',
    'anthropic/TEST-model',
    'openai/TEST-model',
    `${'x'.repeat(120)}/${'y'.repeat(135)}`,
  ])(
    'preserves the native model %s and uses the exact pair for existing catalog declarations',
    async (model) => {
      const original = profile('openai', model),
        before = structuredClone(original);
      const selected = project(selectedLaunchConfiguration(original));
      expect(original).toEqual(before);
      expect(selected.model).toBe(model);
      expect(selected.qualifiedModel).toBe(`openai/${model}`);
      const catalogModels = models({
        providerId: 'openai',
        displayName: 'TEST-provider',
        source: 'config',
        connected: true,
        configured: true,
        defaultModelId: null,
        modelCount: 1,
        authMethods: [],
        models: [
          {
            modelId: model,
            displayName: 'TEST-model',
            contextTokens: null,
            outputTokens: null,
            free: false,
            declaredInputModalities: ['image'],
          },
        ],
      });
      const loadModels = vi.fn(async () => ({
        schemaVersion: 1 as const,
        runtimeId: 'opencode' as const,
        models: {
          runtimeId: 'opencode' as const,
          providerId: 'openai',
          catalogState: 'fresh' as const,
          defaultModelId: null,
          diagnostics: [],
          models: catalogModels,
        },
      }));
      const read = createOpenCodeInputDeclarationResolver(loadModels);
      expect(
        await read({ projectPath: selected.workspace, model: selected.qualifiedModel! })
      ).toEqual(['image']);
      expect(
        await read({ projectPath: selected.workspace, model: 'openai/TEST-unlisted' })
      ).toBeNull();
      expect(loadModels).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'openai', projectPath: before.cwd })
      );
    }
  );

  it.each([
    ['source/ambiguous', 'TEST-model'],
    ['openai', 'model with spaces'],
    ['openai', 'model//nested'],
  ])('omits an ambiguous display pair while retaining native selection', (source, model) => {
    const selected = project(selectedLaunchConfiguration(profile(source, model)));
    expect(selected.model).toBe(model);
    expect(selected.qualifiedModel).toBeUndefined();
  });

  it.each([
    { qualifiedModel: 'openai/TEST-other' },
    { qualifiedModel: 'invalid source/TEST-model' },
    { qualifiedModel: 'openai//TEST-model' },
    { provider: 'claude' },
  ])('Main refuses inconsistent display metadata %j', (invalid) => {
    const selected = selectedLaunchConfiguration(profile('openai', 'TEST-model'));
    expect(() => project({ ...selected, ...invalid })).toThrow();
  });
});
