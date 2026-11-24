import { describe, expect, it } from 'vitest';

import {
  CHANNEL_SETUP_DOCS_URL,
  PROVIDER_SETUP_GUIDES,
} from '@features/notification-channels/renderer/ui/providerSetupGuide';
import { DELIVERY_PROVIDERS } from '@features/notification-channels/contracts';

describe('Notification provider onboarding', () => {
  it('documents all supported providers with a provider-specific example and official HTTPS setup link', () => {
    const names = DELIVERY_PROVIDERS.map((provider) => provider.id);
    expect(Object.keys(PROVIDER_SETUP_GUIDES).sort()).toEqual([...names].sort());
    for (const id of names) {
      const guide = PROVIDER_SETUP_GUIDES[id];
      expect(guide.example.length).toBeGreaterThan(20);
      expect(new URL(guide.officialUrl).protocol).toBe('https:');
      expect(guide.example).not.toContain('123456789:abcdefghijklmnopqrstuvwxyz_0123456789');
    }
  });

  it('links to the product documentation without embedding credentials', () => {
    const docs = new URL(CHANNEL_SETUP_DOCS_URL);
    expect(docs.origin).toBe('https://agentteams.live');
    expect(docs.pathname).toBe('/docs/guide/notification-channels');
    expect(CHANNEL_SETUP_DOCS_URL).not.toContain('?');
  });
});
