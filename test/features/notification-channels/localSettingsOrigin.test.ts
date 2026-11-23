import { describe, expect, it } from 'vitest';

import { resolveLocalSettingsUrl } from '@features/notification-channels/renderer/utils/localSettingsOrigin';

describe('Notification channels browser origin', () => {
  it('does not redirect normal Electron or same-origin browsers', () => {
    expect(resolveLocalSettingsUrl('http://localhost:5173', '?port=3456', true)).toBeNull();
    expect(resolveLocalSettingsUrl('http://127.0.0.1:3456', '?port=3456', false)).toBeNull();
  });

  it('offers a local page instead of initiating blocked cross-origin secret requests', () => {
    expect(resolveLocalSettingsUrl('http://localhost:5173', '?port=3456', false))
      .toBe('http://127.0.0.1:3456/');
    expect(resolveLocalSettingsUrl('https://example.org', '?port=3456', false))
      .toBe('http://127.0.0.1:3456/');
    expect(resolveLocalSettingsUrl('https://example.org', '?port=99999', false)).toBeNull();
  });
});
