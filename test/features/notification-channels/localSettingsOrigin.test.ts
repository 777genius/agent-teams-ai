import { describe, expect, it } from 'vitest';

import { isLocalSettingsOrigin, resolveLocalSettingsUrl } from '@features/notification-channels/renderer/utils/localSettingsOrigin';

describe('Notification channels browser origin', () => {
  it('does not redirect normal Electron or same-origin browsers', () => {
    expect(resolveLocalSettingsUrl('http://localhost:5173', '?port=3456', true)).toBeNull();
    expect(resolveLocalSettingsUrl('http://127.0.0.1:3456', '?port=3456', false)).toBeNull();
    expect(resolveLocalSettingsUrl('http://localhost:3456', '?port=3456', false)).toBeNull();
  });

  it('never attempts credential management from remote or TLS browser origins', () => {
    expect(isLocalSettingsOrigin('http://localhost:3456', false)).toBe(true);
    expect(isLocalSettingsOrigin('http://127.0.0.1:3456', false)).toBe(true);
    expect(isLocalSettingsOrigin('http://192.168.1.50:3456', false)).toBe(false);
    expect(isLocalSettingsOrigin('https://example.org', false)).toBe(false);
    expect(isLocalSettingsOrigin('https://localhost:3456', false)).toBe(false);
    expect(isLocalSettingsOrigin('not-an-origin', false)).toBe(false);
    expect(isLocalSettingsOrigin('file://', true)).toBe(true);
  });

  it('offers a local page instead of initiating blocked cross-origin secret requests', () => {
    expect(resolveLocalSettingsUrl('http://localhost:5173', '?port=3456', false))
      .toBe('http://127.0.0.1:3456/');
    expect(resolveLocalSettingsUrl('https://example.org', '?port=3456', false))
      .toBe('http://127.0.0.1:3456/');
    expect(resolveLocalSettingsUrl('https://example.org', '?port=99999', false)).toBeNull();
  });
});
