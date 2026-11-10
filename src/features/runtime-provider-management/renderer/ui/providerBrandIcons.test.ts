import { describe, expect, it } from 'vitest';

import { getModelsDevLogoKey } from './providerBrandIcons';

describe('getModelsDevLogoKey', () => {
  it('maps Kimi Code Membership onto the Moonshot logo instead of the models.dev sparkle fallback', () => {
    expect(
      getModelsDevLogoKey({
        providerId: 'kimi-for-coding',
        displayName: 'Kimi Code Membership',
      })
    ).toBe('moonshotai');
    expect(
      getModelsDevLogoKey({
        providerId: 'kimi-code-membership',
        displayName: 'Kimi Code Membership',
      })
    ).toBe('moonshotai');
  });
});
