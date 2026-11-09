import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@renderer/api', () => ({ isElectronMode: vi.fn(() => true) }));

import { isElectronMode } from '@renderer/api';

import { SettingsTabs } from './SettingsTabs';

describe('settings navigation', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.mocked(isElectronMode).mockReturnValue(true);
  });

  it('offers external agent connection as a separate page and omits gateway providers', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onSectionChange = vi.fn();
    act(() =>
      root.render(<SettingsTabs activeSection="general" onSectionChange={onSectionChange} />)
    );
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons.some((button) => button.textContent === 'tabs.gatewayProviders.label')).toBe(
      false
    );
    const appearance = buttons.find((button) => button.textContent === 'general.appearance.title');
    expect(appearance).toBeDefined();
    act(() => appearance?.click());
    expect(onSectionChange).toHaveBeenCalledWith('appearance');
    const external = buttons.find(
      (button) => button.textContent === 'general.externalAgentConnection.title'
    );
    expect(external).toBeDefined();
    act(() => external?.click());
    expect(onSectionChange).toHaveBeenCalledWith('externalAgentConnection');
    act(() =>
      root.render(
        <SettingsTabs activeSection="externalAgentConnection" onSectionChange={onSectionChange} />
      )
    );
    expect(external?.getAttribute('aria-current')).toBe('page');
    act(() => root.unmount());
  });
  it('keeps shared navigation available outside Electron', () => {
    vi.mocked(isElectronMode).mockReturnValue(false);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<SettingsTabs activeSection="general" onSectionChange={vi.fn()} />));
    const labels = [...host.querySelectorAll('button')].map((button) => button.textContent);
    expect(labels).toContain('tabs.general.label');
    expect(labels).toContain('general.appearance.title');
    expect(labels).toContain('tabs.notifications.label');
    expect(labels).toContain('tabs.advanced.label');
    expect(labels).not.toContain('runtimeProvider.tabs.providers');
    expect(labels).not.toContain('general.externalAgentConnection.title');
    act(() => root.unmount());
  });
});
