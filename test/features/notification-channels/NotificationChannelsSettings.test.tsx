import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { NotificationChannelsSettings } from '@features/notification-channels/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeliveryChannelDto } from '@features/notification-channels/contracts';

const mockUseSettings = vi.hoisted(() => vi.fn());

vi.mock('@features/notification-channels/renderer/hooks/useNotificationChannelsSettings', () => ({
  useNotificationChannelsSettings: () => mockUseSettings(),
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    resolvedLanguage: 'en',
    t: (key: string) =>
      ({
        'notifications.delivery.pausedDisabled':
          'Automatic delivery is paused: Enable System Notifications is OFF. Turn it on below to resume. Manual Test still works.',
        'notifications.delivery.pausedSnoozed':
          'Automatic delivery is snoozed until 10:00. Click Clear Snooze above to resume. Manual Test still works.',
        'notifications.delivery.pausedSnoozedUnknown':
          'Automatic delivery is snoozed. Click Clear Snooze above to resume. Manual Test still works.',
      })[key] ?? key,
  }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  mockUseSettings.mockReset();
  vi.unstubAllGlobals();
});

async function renderChannel(
  enabled: boolean,
  hasCredential: boolean,
  pauseReason: 'notifications_off' | 'snoozed' | null = null
) {
  const toggle = vi.fn();
  const channel: DeliveryChannelDto = {
    id: 'ab84b487-0c13-4bd8-9b4a-57c9947efcd0',
    name: 'Private destination',
    provider: 'telegram',
    enabled,
    events: ['user_inbox'],
    chatId: '123456',
    hasCredential,
  };
  mockUseSettings.mockReturnValue({
    channels: [channel],
    draft: null,
    loading: false,
    busy: false,
    deletePending: null,
    error: null,
    localSettingsUrl: null,
    remoteSettingsUnavailable: false,
    save: vi.fn(),
    edit: vi.fn(),
    toggle,
    remove: vi.fn(),
    test: vi.fn(),
    providerChanged: false,
    credentialMissing: !hasCredential,
    updateDraft: vi.fn(),
    route: vi.fn(),
    start: vi.fn(),
    cancel: vi.fn(),
  });

  await act(async () =>
    root.render(
      <NotificationChannelsSettings
        settings={mockUseSettings()}
        autoDeliveryPauseReason={pauseReason}
        snoozedUntil={Date.now() + 60_000}
      />
    )
  );
  const control = container.querySelector<HTMLButtonElement>(
    '[role="checkbox"][aria-label="Enable Private destination"]'
  );
  expect(control).not.toBeNull();
  return { control: control!, channel, toggle };
}

describe('Notification Channels settings: unavailable credentials', () => {
  it('shows a decorative, locally bundled provider logo without replacing accessible labels', async () => {
    await renderChannel(true, true);
    const logo = container.querySelector<HTMLImageElement>(
      'img[data-notification-provider-logo="telegram"]'
    );
    expect(logo).not.toBeNull();
    expect(logo?.getAttribute('alt')).toBe('');
    expect(logo?.getAttribute('src')).not.toMatch(/^https?:\/\//);
  });

  it('still permits disabling an already-enabled channel if its vault is unavailable', async () => {
    const { control, channel, toggle } = await renderChannel(true, false);
    expect(control.disabled).toBe(false);
    await act(async () => control.click());
    expect(toggle).toHaveBeenCalledWith(channel, false);
  });

  it('does not allow enabling an inactive channel without its credential', async () => {
    const { control, toggle } = await renderChannel(false, false);
    expect(control.disabled).toBe(true);
    await act(async () => control.click());
    expect(toggle).not.toHaveBeenCalled();
  });

  it('allows normal enabling after a valid credential is available', async () => {
    const { control, channel, toggle } = await renderChannel(false, true);
    expect(control.disabled).toBe(false);
    await act(async () => control.click());
    expect(toggle).toHaveBeenCalledWith(channel, true);
  });
});

describe('Notification Channels pause explanation', () => {
  it('identifies the disabled master switch rather than Dev Mode or Snooze', async () => {
    await renderChannel(true, true, 'notifications_off');
    expect(container.textContent).toContain('Enable System Notifications is OFF');
    expect(container.textContent).not.toContain('snoozed');
  });

  it('identifies Snooze and tells the user where to resume', async () => {
    await renderChannel(true, true, 'snoozed');
    expect(container.textContent).toContain('Automatic delivery is snoozed');
    expect(container.textContent).toContain('Clear Snooze');
  });

  it('does not warn about a paused external delivery when no channel exists', async () => {
    await renderChannel(true, true, 'notifications_off');
    mockUseSettings.mockReturnValue({ ...mockUseSettings(), channels: [] });
    await act(async () =>
      root.render(
        <NotificationChannelsSettings
          settings={mockUseSettings()}
          autoDeliveryPauseReason="notifications_off"
        />
      )
    );
    expect(container.textContent).not.toContain('Automatic delivery is paused');
  });
});
