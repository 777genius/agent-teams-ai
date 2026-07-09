import { describe, expect, it } from 'vitest';

import { createStaticCodexModelCatalogModels } from '../codexModelCatalogFallback';

describe('createStaticCodexModelCatalogModels', () => {
  it('includes GPT-5.6 Sol, Terra, and Luna without changing the default from GPT-5.4', () => {
    const models = createStaticCodexModelCatalogModels();
    const modelIds = models.map((model) => model.launchModel);

    expect(modelIds).toEqual(
      expect.arrayContaining(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'])
    );
    expect(models.find((model) => model.isDefault)?.launchModel).toBe('gpt-5.4');
  });
});
