import { computeEffectiveTeamModel } from '@renderer/components/team/dialogs/teamModelSummary';
import { describe, expect, it } from 'vitest';

import { buildRuntimeProviderLaunchFacts } from '../../../../src/main/services/team/provisioning/TeamProvisioningLaunchIdentity';
import { buildDeterministicLaunchProcessArgs } from '../../../../src/main/services/team/provisioning/TeamProvisioningLaunchTeamFlow';
import { buildEffectiveTeamMemberSpecs } from '../../../../src/main/services/team/provisioning/TeamProvisioningMemberSpecs';
import {
  buildProviderModelLaunchIdentity,
  resolveAnthropicSelectionFromFacts,
  validateRuntimeLaunchSelection,
} from '../../../../src/main/services/team/provisioning/TeamProvisioningRuntimeLaunchSelection';

import type { CliProviderModelCatalog } from '@shared/types';

function buildAliasCatalog(
  source: CliProviderModelCatalog['source'],
  status: CliProviderModelCatalog['status']
): CliProviderModelCatalog {
  return {
    schemaVersion: 1,
    providerId: 'anthropic',
    source,
    status,
    fetchedAt: '2026-10-14T00:00:00.000Z',
    staleAt: '2026-10-14T01:00:00.000Z',
    defaultModelId: 'opus',
    defaultLaunchModel: 'opus',
    diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
    models: [
      {
        id: 'opus',
        launchModel: 'opus',
        displayName: 'Opus alias',
        hidden: true,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        inputModalities: ['text'],
        supportsPersonality: false,
        isDefault: true,
        upgrade: false,
        source,
      },
    ],
  };
}

describe('Anthropic model selection across renderer and runtime launch', () => {
  it.each([
    {
      name: 'no catalog',
      catalog: null,
      limitContext: false,
      expected: 'claude-opus-5-5',
    },
    {
      name: 'incomplete authoritative catalog',
      catalog: buildAliasCatalog('anthropic-models-api', 'ready'),
      limitContext: true,
      expected: 'claude-opus-5-5',
    },
    {
      name: 'stale alias catalog',
      catalog: buildAliasCatalog('anthropic-models-api', 'stale'),
      limitContext: false,
      expected: 'claude-opus-5-5',
    },
    {
      name: 'static alias catalog',
      catalog: buildAliasCatalog('static-fallback', 'ready'),
      limitContext: true,
      expected: 'claude-opus-5-5',
    },
  ])(
    'preserves the runtime default across renderer, main, and inherited members with $name',
    ({ catalog, limitContext, expected }) => {
      const facts = buildRuntimeProviderLaunchFacts({
        providerId: 'anthropic',
        limitContext,
        modelListStdout: JSON.stringify({
          providers: {
            anthropic: {
              defaultModel: 'claude-opus-5-5',
              models: ['opus'],
            },
          },
        }),
        runtimeStatusStdout: JSON.stringify({
          providers: {
            anthropic: {
              defaultModel: 'claude-opus-5-5',
              modelCatalog: catalog,
            },
          },
        }),
      });
      const rendererModel = computeEffectiveTeamModel('', limitContext, 'anthropic', {
        providerId: 'anthropic',
        defaultModel: facts.defaultModel,
        modelCatalog: catalog,
      });
      const selection = resolveAnthropicSelectionFromFacts({
        selectedModel: undefined,
        limitContext,
        facts,
      });
      const identity = buildProviderModelLaunchIdentity({
        request: { providerId: 'anthropic', model: undefined, limitContext },
        facts,
        anthropicFastModeDefault: false,
      });
      const members = buildEffectiveTeamMemberSpecs(
        [{ name: 'inherited-peer', role: 'Developer' }],
        { providerId: 'anthropic', model: rendererModel }
      );

      expect(rendererModel).toBe(expected);
      expect(selection.resolvedLaunchModel).toBe(expected);
      expect(identity).toMatchObject({
        selectedModel: null,
        selectedModelKind: 'default',
        resolvedLaunchModel: expected,
      });
      expect(members[0].model).toBe(expected);
      expect(() =>
        validateRuntimeLaunchSelection({
          actorLabel: 'Default lead',
          providerId: 'anthropic',
          model: undefined,
          limitContext,
          facts,
          anthropicFastModeDefault: false,
          getProviderLabel: () => 'Anthropic',
        })
      ).not.toThrow();
    }
  );

  it('keeps an unsupported explicit model exact and rejects it against authoritative catalog truth', () => {
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
      models: [
        {
          id: 'opus',
          launchModel: 'opus',
          displayName: 'Opus',
          hidden: false,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          inputModalities: ['text'],
          supportsPersonality: false,
          isDefault: true,
          upgrade: false,
          source: 'anthropic-models-api',
        },
      ],
    };
    const facts = buildRuntimeProviderLaunchFacts({
      providerId: 'anthropic',
      limitContext: false,
      modelListStdout: JSON.stringify({
        providers: { anthropic: { defaultModel: 'opus', models: ['opus'] } },
      }),
      runtimeStatusStdout: JSON.stringify({
        providers: { anthropic: { modelCatalog: catalog } },
      }),
    });
    const unsupportedModel = 'claude-opus-99';
    const identity = buildProviderModelLaunchIdentity({
      request: { providerId: 'anthropic', model: unsupportedModel, limitContext: false },
      facts,
      anthropicFastModeDefault: false,
    });

    expect(identity.resolvedLaunchModel).toBe(unsupportedModel);
    expect(() =>
      validateRuntimeLaunchSelection({
        actorLabel: 'Explicit lead',
        providerId: 'anthropic',
        model: unsupportedModel,
        limitContext: false,
        facts,
        anthropicFastModeDefault: false,
        getProviderLabel: () => 'Anthropic',
      })
    ).toThrow('does not list it as launchable');
  });

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
