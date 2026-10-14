import { computeEffectiveTeamModel } from '@renderer/components/team/dialogs/teamModelSummary';
import { describe, expect, it } from 'vitest';

import { buildRuntimeProviderLaunchFacts } from '../../../../src/main/services/team/provisioning/TeamProvisioningLaunchIdentity';
import { buildDeterministicLaunchProcessArgs } from '../../../../src/main/services/team/provisioning/TeamProvisioningLaunchTeamFlow';
import { buildEffectiveTeamMemberSpecs } from '../../../../src/main/services/team/provisioning/TeamProvisioningMemberSpecs';
import {
  buildProviderModelLaunchIdentity,
  validateRuntimeLaunchSelection,
} from '../../../../src/main/services/team/provisioning/TeamProvisioningRuntimeLaunchSelection';

import type { CliProviderModelCatalog } from '@shared/types';

describe('Anthropic model selection across renderer and runtime launch', () => {
  it.each(['claude-opus-5', 'claude-opus-5-5'])('preserves %s with the 200K limit', (model) => {
    const catalog: CliProviderModelCatalog = {
      schemaVersion: 1,
      providerId: 'anthropic',
      source: 'anthropic-models-api',
      status: 'ready',
      fetchedAt: '2026-10-14T00:00:00.000Z',
      staleAt: '2026-10-14T01:00:00.000Z',
      defaultModelId: 'opus',
      defaultLaunchModel: 'opus',
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
      models: ['opus', model].map((id) => ({
        id,
        launchModel: id,
        displayName: id === 'opus' ? 'Opus 4.8' : model,
        hidden: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        inputModalities: ['text'],
        supportsPersonality: false,
        isDefault: id === 'opus',
        upgrade: false,
        source: 'anthropic-models-api',
      })),
    };
    const rendererModel = computeEffectiveTeamModel(`${model}[1m]`, true, 'anthropic', {
      providerId: 'anthropic',
      modelCatalog: catalog,
    });
    const facts = buildRuntimeProviderLaunchFacts({
      providerId: 'anthropic',
      limitContext: true,
      runtimeStatusStdout: JSON.stringify({ providers: { anthropic: { modelCatalog: catalog } } }),
    });
    const request = { providerId: 'anthropic' as const, model: rendererModel, limitContext: true };
    validateRuntimeLaunchSelection({
      ...request,
      actorLabel: 'Test lead',
      facts,
      anthropicFastModeDefault: false,
      getProviderLabel: () => 'Anthropic',
    });
    const identity = buildProviderModelLaunchIdentity({
      request,
      facts,
      anthropicFastModeDefault: false,
    });
    const members = buildEffectiveTeamMemberSpecs(
      [{ name: 'test-peer', role: 'Developer' }],
      request
    );
    const args = buildDeterministicLaunchProcessArgs({
      providerId: 'anthropic',
      model: rendererModel,
      launchIdentity: identity,
      mcpConfigPath: '/TEST/mcp.json',
      bootstrapSpecPath: '/TEST/bootstrap.json',
      bootstrapUserPromptPath: null,
      disallowedTools: '',
      teammateModeDecision: { injectedTeammateMode: null },
      runtimeArgsPlan: {
        providerArgs: [],
        fastModeArgs: [],
        runtimeTurnSettledHookArgs: [],
        extraArgs: [],
        settingsArgs: [],
        inheritedProviderArgs: [],
        appManagedSettingsPath: null,
      },
    });

    expect(rendererModel).toBe(model);
    expect(identity).toMatchObject({
      selectedModel: model,
      resolvedLaunchModel: model,
      catalogId: model,
    });
    expect(members[0].model).toBe(model);
    expect(args[args.indexOf('--model') + 1]).toBe(model);
  });
});
