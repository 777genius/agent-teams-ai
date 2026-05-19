import { describe, expect, it } from 'vitest';

import { normalizeCodexAppServerModels } from '../normalizeCodexAppServerModel';

describe('normalizeCodexAppServerModels', () => {
  it('keeps app-server model metadata required by the UI picker', () => {
    const result = normalizeCodexAppServerModels([
      {
        id: 'gpt-5.5',
        displayName: 'GPT-5.5',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low' },
          { reasoningEffort: 'medium' },
          { reasoningEffort: 'high' },
          { reasoningEffort: 'xhigh' },
        ],
        defaultReasoningEffort: 'xhigh',
        inputModalities: ['text', 'image'],
        supportsPersonality: true,
        isDefault: true,
      },
    ]);

    expect(result.defaultModelId).toBe('gpt-5.5');
    expect(result.models).toEqual([
      expect.objectContaining({
        id: 'gpt-5.5',
        launchModel: 'gpt-5.5',
        displayName: 'GPT-5.5',
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'xhigh',
        inputModalities: ['text', 'image'],
        supportsPersonality: true,
        isDefault: true,
        source: 'app-server',
      }),
    ]);
  });

  it('filters hidden models unless the caller explicitly asks for them', () => {
    const result = normalizeCodexAppServerModels([
      { id: 'gpt-visible', hidden: false },
      { id: 'gpt-hidden', hidden: true },
    ]);

    expect(result.models.map((model) => model.id)).toEqual(['gpt-visible']);

    const withHidden = normalizeCodexAppServerModels(
      [
        { id: 'gpt-visible', hidden: false },
        { id: 'gpt-hidden', hidden: true },
      ],
      { includeHidden: true }
    );

    expect(withHidden.models.map((model) => model.id)).toEqual(['gpt-visible', 'gpt-hidden']);
  });

  it('drops unknown effort values instead of leaking them into launch options', () => {
    const result = normalizeCodexAppServerModels([
      {
        id: 'gpt-5.4',
        supportedReasoningEfforts: ['none', 'medium', { reasoningEffort: 'future-effort' }],
        defaultReasoningEffort: 'future-effort',
      },
    ]);

    expect(result.models[0]?.supportedReasoningEfforts).toEqual(['medium']);
    expect(result.models[0]?.defaultReasoningEffort).toBe('medium');
  });

  it('uses model as the launch value and de-duplicates duplicate launch models', () => {
    const result = normalizeCodexAppServerModels([
      {
        id: 'catalog-alias',
        model: 'gpt-5.5',
        displayName: 'GPT-5.5 Alias',
      },
      {
        id: 'catalog-duplicate',
        model: 'gpt-5.5',
        displayName: 'Duplicate GPT-5.5 Alias',
      },
    ]);

    expect(result.models).toEqual([
      expect.objectContaining({
        id: 'catalog-alias',
        launchModel: 'gpt-5.5',
        displayName: 'GPT-5.5 Alias',
      }),
    ]);
    expect(result.diagnostics).toContain('model/list returned duplicate launch model gpt-5.5.');
  });
});
