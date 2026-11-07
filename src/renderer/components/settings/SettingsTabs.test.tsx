import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@renderer/api', () => ({ isElectronMode: () => true }));

import { SettingsTabs } from './SettingsTabs';

describe('settings navigation', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
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
});
