import { describe, expect, it } from 'vitest';

import {
  coerceCodexCatalogModelInput,
  extractCodexCatalogModelRecords,
  parseCodexModelCatalogJsonPathFromToml,
} from '../coerceCodexCatalogModelInput';
import { mergeProviderCatalogModels } from '../mergeCodexCatalogModels';
import { normalizeCodexAppServerModels } from '../normalizeCodexAppServerModel';

import type { CliProviderModelCatalogItem } from '@shared/types';

function catalogItem(id: string, overrides: Partial<CliProviderModelCatalogItem> = {}) {
  return {
    id,
    launchModel: id,
    displayName: id,
    hidden: false,
    supportedReasoningEfforts: ['medium'],
    defaultReasoningEffort: 'medium' as const,
    inputModalities: ['text'],
    supportsPersonality: false,
    isDefault: false,
    upgrade: false,
    source: 'app-server' as const,
    ...overrides,
  };
}

describe('coerceCodexCatalogModelInput', () => {
  it('maps mixin slug catalogs onto app-server model ids', () => {
    expect(
      coerceCodexCatalogModelInput({
        slug: 'composer-2.5-fast-cursor',
        display_name: 'Composer 2.5 Fast · Cursor',
        visibility: 'list',
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }],
        default_reasoning_level: 'low',
        input_modalities: ['text'],
      })
    ).toMatchObject({
      id: 'composer-2.5-fast-cursor',
      displayName: 'Composer 2.5 Fast · Cursor',
      hidden: false,
      defaultReasoningEffort: 'low',
    });
  });

  it('hides mixin rows with visibility hide', () => {
    expect(
      coerceCodexCatalogModelInput({ slug: 'codex-auto-review', visibility: 'hide' })
    ).toMatchObject({
      id: 'codex-auto-review',
      hidden: true,
    });
  });

  it('does not treat display name as a model id', () => {
    expect(coerceCodexCatalogModelInput({ name: 'GPT-5.4' })).toBeNull();
  });
});

describe('normalizeCodexAppServerModels local catalogs', () => {
  it('keeps mixin slug models that have no camelCase id', () => {
    const result = normalizeCodexAppServerModels([
      {
        slug: 'auto-cursor',
        display_name: 'auto · Cursor',
        visibility: 'list',
        supported_reasoning_levels: [{ effort: 'medium' }],
      },
    ]);

    expect(result.models[0]).toMatchObject({
      id: 'auto-cursor',
      launchModel: 'auto-cursor',
      displayName: 'auto · Cursor',
      source: 'app-server',
    });
  });
});

describe('mergeProviderCatalogModels', () => {
  it('appends configured extras without replacing live ids', () => {
    const merged = mergeProviderCatalogModels(
      [catalogItem('gpt-5.6-sol', { isDefault: true })],
      [catalogItem('gpt-5.6-sol'), catalogItem('composer-2.5-fast-cursor', { isDefault: true })]
    );

    expect(merged.map((model) => model.id)).toEqual(['gpt-5.6-sol', 'composer-2.5-fast-cursor']);
    expect(merged.find((model) => model.id === 'composer-2.5-fast-cursor')).toMatchObject({
      isDefault: false,
      metadata: { configuredFromLocalCatalog: true },
    });
    expect(
      merged.find((model) => model.id === 'gpt-5.6-sol')?.metadata?.configuredFromLocalCatalog
    ).toBeUndefined();
  });

  it('tags extras from any provider catalog, not only Cursor suffix slugs', () => {
    const merged = mergeProviderCatalogModels(
      [catalogItem('claude-sonnet-4-5')],
      [catalogItem('local-proxy-qwen3')]
    );

    expect(merged.find((model) => model.id === 'local-proxy-qwen3')?.metadata).toEqual({
      configuredFromLocalCatalog: true,
    });
  });
});

describe('parseCodexModelCatalogJsonPathFromToml', () => {
  it('reads the first model_catalog_json assignment', () => {
    expect(
      parseCodexModelCatalogJsonPathFromToml(
        '# comment\nmodel = "auto"\nmodel_catalog_json = "/Users/example/.codex/mixin-models.json"\n'
      )
    ).toBe('/Users/example/.codex/mixin-models.json');
  });
});

describe('extractCodexCatalogModelRecords', () => {
  it('accepts { models } wrappers used by cursor-proxy catalogs', () => {
    expect(extractCodexCatalogModelRecords({ models: [{ id: 'auto' }] })).toEqual([{ id: 'auto' }]);
  });
});
