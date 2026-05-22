import {
  getVisibleTeamProviderModels,
  isAnthropicOneMillionContextTeamModel,
  isAnthropicSonnetOneMillionContextTeamModel,
  isAnthropicSonnetTeamModel,
} from '@renderer/utils/teamModelCatalog';
import { describe, expect, it } from 'vitest';

describe('teamModelCatalog', () => {
  it('filters UI-disabled Codex models from provider badge lists', () => {
    expect(
      getVisibleTeamProviderModels('codex', [
        'gpt-5.4',
        'gpt-5.4-mini',
        'gpt-5.3-codex',
        'gpt-5.3-codex-spark',
        'gpt-5.2',
        'gpt-5.2-codex',
        'gpt-5.1-codex-mini',
        'gpt-5.1-codex-max',
      ])
    ).toEqual(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2', 'gpt-5.1-codex-max']);
  });

  it('adds curated Anthropic Opus 4.7 badges when the runtime list only reports legacy Opus variants', () => {
    expect(
      getVisibleTeamProviderModels('anthropic', [
        'claude-haiku-4-5-20251001',
        'claude-opus-4-6',
        'claude-opus-4-6[1m]',
        'claude-sonnet-4-6',
        'claude-sonnet-4-6[1m]',
      ])
    ).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-opus-4-7',
      'claude-opus-4-7[1m]',
      'claude-opus-4-6',
      'claude-opus-4-6[1m]',
      'claude-sonnet-4-6',
      'claude-sonnet-4-6[1m]',
    ]);
  });

  it('orders OpenCode free models before paid models', () => {
    expect(
      getVisibleTeamProviderModels(
        'opencode',
        [
          'openrouter/deepseek/deepseek-r1',
          'openai/gpt-5.4',
          'openrouter/openai/gpt-oss-20b:free',
          'opencode/big-pickle',
        ],
        {
          providerId: 'opencode',
          authMethod: 'opencode_managed',
          backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'opencode',
            source: 'app-server',
            status: 'ready',
            fetchedAt: '2026-05-12T00:00:00.000Z',
            staleAt: '2026-05-12T00:10:00.000Z',
            defaultModelId: 'opencode/big-pickle',
            defaultLaunchModel: 'opencode/big-pickle',
            models: [
              {
                id: 'opencode/big-pickle',
                launchModel: 'opencode/big-pickle',
                displayName: 'opencode/big-pickle',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: true,
                isDefault: true,
                upgrade: false,
                source: 'app-server',
                badgeLabel: 'Free',
              },
              {
                id: 'openrouter/openai/gpt-oss-20b:free',
                launchModel: 'openrouter/openai/gpt-oss-20b:free',
                displayName: 'openrouter/openai/gpt-oss-20b:free',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: true,
                isDefault: false,
                upgrade: false,
                source: 'app-server',
                badgeLabel: 'Free',
              },
              {
                id: 'openai/gpt-5.4',
                launchModel: 'openai/gpt-5.4',
                displayName: 'openai/gpt-5.4',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: true,
                isDefault: false,
                upgrade: false,
                source: 'app-server',
                badgeLabel: null,
              },
              {
                id: 'openrouter/deepseek/deepseek-r1',
                launchModel: 'openrouter/deepseek/deepseek-r1',
                displayName: 'openrouter/deepseek/deepseek-r1',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: true,
                isDefault: false,
                upgrade: false,
                source: 'app-server',
                badgeLabel: null,
              },
            ],
            diagnostics: {
              configReadState: 'ready',
              appServerState: 'healthy',
            },
          },
        }
      )
    ).toEqual([
      'opencode/big-pickle',
      'openrouter/openai/gpt-oss-20b:free',
      'openai/gpt-5.4',
      'openrouter/deepseek/deepseek-r1',
    ]);
  });

  it('orders OpenCode free models by metadata when badge labels are absent', () => {
    expect(
      getVisibleTeamProviderModels(
        'opencode',
        [
          'openai/gpt-5.4',
          'opencode/big-pickle',
          'openrouter/openai/gpt-oss-20b',
        ],
        {
          providerId: 'opencode',
          authMethod: 'opencode_managed',
          backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'opencode',
            source: 'app-server',
            status: 'ready',
            fetchedAt: '2026-05-12T00:00:00.000Z',
            staleAt: '2026-05-12T00:10:00.000Z',
            defaultModelId: 'opencode/big-pickle',
            defaultLaunchModel: 'opencode/big-pickle',
            models: [
              {
                id: 'openai/gpt-5.4',
                launchModel: 'openai/gpt-5.4',
                displayName: 'openai/gpt-5.4',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: true,
                isDefault: false,
                upgrade: false,
                source: 'app-server',
                badgeLabel: null,
                metadata: { free: false },
              },
              {
                id: 'openrouter/openai/gpt-oss-20b',
                launchModel: 'openrouter/openai/gpt-oss-20b',
                displayName: 'openrouter/openai/gpt-oss-20b',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: true,
                isDefault: false,
                upgrade: false,
                source: 'app-server',
                badgeLabel: null,
                metadata: { free: true },
              },
              {
                id: 'opencode/big-pickle',
                launchModel: 'opencode/big-pickle',
                displayName: 'opencode/big-pickle',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: true,
                isDefault: true,
                upgrade: false,
                source: 'app-server',
                badgeLabel: null,
                metadata: { free: true },
              },
            ],
            diagnostics: {
              configReadState: 'ready',
              appServerState: 'healthy',
            },
          },
        }
      )
    ).toEqual([
      'opencode/big-pickle',
      'openrouter/openai/gpt-oss-20b',
      'openai/gpt-5.4',
    ]);
  });

  it('uses the OpenCode model catalog when the runtime model list is summary-only', () => {
    expect(
      getVisibleTeamProviderModels('opencode', ['opencode/big-pickle'], {
        providerId: 'opencode',
        authMethod: 'opencode_managed',
        backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
        modelCatalog: {
          schemaVersion: 1,
          providerId: 'opencode',
          source: 'app-server',
          status: 'ready',
          fetchedAt: '2026-05-12T00:00:00.000Z',
          staleAt: '2026-05-12T00:10:00.000Z',
          defaultModelId: 'opencode/big-pickle',
          defaultLaunchModel: 'opencode/big-pickle',
          models: [
            {
              id: 'openai/gpt-5.4',
              launchModel: 'openai/gpt-5.4',
              displayName: 'openai/gpt-5.4',
              hidden: false,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: null,
              inputModalities: ['text'],
              supportsPersonality: true,
              isDefault: false,
              upgrade: false,
              source: 'app-server',
              badgeLabel: null,
            },
            {
              id: 'opencode/big-pickle',
              launchModel: 'opencode/big-pickle',
              displayName: 'opencode/big-pickle',
              hidden: false,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: null,
              inputModalities: ['text'],
              supportsPersonality: true,
              isDefault: true,
              upgrade: false,
              source: 'app-server',
              badgeLabel: 'Free',
            },
            {
              id: 'openrouter/hidden-model',
              launchModel: 'openrouter/hidden-model',
              displayName: 'openrouter/hidden-model',
              hidden: true,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: null,
              inputModalities: ['text'],
              supportsPersonality: true,
              isDefault: false,
              upgrade: false,
              source: 'app-server',
              badgeLabel: null,
            },
          ],
          diagnostics: {
            configReadState: 'ready',
            appServerState: 'healthy',
          },
        },
      })
    ).toEqual(['opencode/big-pickle', 'openai/gpt-5.4']);
  });

  it('detects Sonnet aliases with or without 1M suffix', () => {
    expect(isAnthropicSonnetTeamModel('sonnet')).toBe(true);
    expect(isAnthropicSonnetTeamModel('sonnet[1m]')).toBe(true);
    expect(isAnthropicSonnetTeamModel('claude-sonnet-4-6')).toBe(true);
    expect(isAnthropicSonnetTeamModel('claude-sonnet-4-6[1m]')).toBe(true);
    expect(isAnthropicSonnetTeamModel('opus')).toBe(false);
    expect(isAnthropicSonnetTeamModel('haiku')).toBe(false);
  });

  it('detects 1M Anthropic selections and native 1M launch ids', () => {
    expect(isAnthropicOneMillionContextTeamModel('sonnet')).toBe(false);
    expect(isAnthropicOneMillionContextTeamModel('sonnet[1m]')).toBe(true);
    expect(isAnthropicOneMillionContextTeamModel('claude-opus-4-7')).toBe(true);
    expect(isAnthropicOneMillionContextTeamModel('claude-opus-4-7[1m]')).toBe(true);
    expect(isAnthropicOneMillionContextTeamModel('claude-sonnet-4-6')).toBe(true);
    expect(isAnthropicSonnetOneMillionContextTeamModel('sonnet')).toBe(false);
    expect(isAnthropicSonnetOneMillionContextTeamModel('sonnet[1m]')).toBe(true);
    expect(isAnthropicSonnetOneMillionContextTeamModel('claude-sonnet-4-6')).toBe(true);
    expect(isAnthropicSonnetOneMillionContextTeamModel('claude-sonnet-4-6[1m]')).toBe(true);
    expect(isAnthropicSonnetOneMillionContextTeamModel('opus[1m]')).toBe(false);
  });
});
