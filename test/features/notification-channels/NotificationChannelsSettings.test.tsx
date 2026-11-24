import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { NotificationChannelsSettings } from '@features/notification-channels/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeliveryChannelDto } from '@features/notification-channels/contracts';

const mockUseSettings = vi.hoisted(() => vi.fn());

vi.mock('@features/notification-channels/renderer/hooks/useNotificationChannelsSettings', () => ({
  useNotificationChannelsSettings: () => mockUseSettings(),
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

async function renderChannel(enabled: boolean, hasCredential: boolean) {
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
    save: vi.fn(),
    edit: vi.fn(),
    toggle,
    remove: vi.fn(),
    test: vi.fn(),
    providerChanged: false,
    credentialMissing: !hasCredential,
    updateDraft: vi.fn(),
    toggleEvent: vi.fn(),
    start: vi.fn(),
    cancel: vi.fn(),
  });

  await act(async () => root.render(<NotificationChannelsSettings />));
  const control = container.querySelector<HTMLButtonElement>(
    '[role="checkbox"][aria-label="Enable Private destination"]'
  );
  expect(control).not.toBeNull();
  return { control: control!, channel, toggle };
}

describe('Notification Channels settings: unavailable credentials', () => {
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
