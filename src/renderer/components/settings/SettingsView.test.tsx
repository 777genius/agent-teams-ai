/* eslint-disable @typescript-eslint/naming-convention -- Component mocks mirror exports. */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

const loading = vi.hoisted(() => {
  let loadContent = (): void => undefined;
  let loadConfig = (): void => undefined;
  const content = new Promise<void>((resolve) => {
    loadContent = resolve;
  });
  const config = new Promise<void>((resolve) => {
    loadConfig = resolve;
  });
  return { content, config, loadContent, loadConfig };
});

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@renderer/api', () => ({ isElectronMode: () => true }));
vi.mock('@features/external-agent-connection/renderer', () => ({
  ExternalAgentConnectionSettings: () => null,
}));
vi.mock('./SettingsContent', async () => {
  await loading.content;
  return vi.importActual('./SettingsContent');
});
vi.mock('./hooks', () => ({
  useSettingsConfig: () => {
    const [loaded, setLoaded] = React.useState(false);
    React.useEffect(() => {
      void loading.config.then(() => setLoaded(true));
    }, []);
    return { config: loaded ? {} : null, safeConfig: {}, loading: !loaded };
  },
  useSettingsHandlers: () => ({}),
}));
vi.mock('./sections', () => ({
  GeneralSection: () => <div>General form</div>,
  ConnectionSection: () => null,
  AdvancedSection: () => null,
  NotificationsSection: () => <div id="notifications-anchor">Notifications form</div>,
}));
vi.mock('./sections/AppearanceSection', () => ({
  AppearanceSection: () => <div>Appearance form</div>,
}));
vi.mock('../dashboard/CliStatusBanner', () => ({
  CliStatusBanner: ({ isDashboardActive }: { isDashboardActive: boolean }) => (
    <input aria-label="Provider draft" data-active={String(isDashboardActive)} />
  ),
}));
/* eslint-enable @typescript-eslint/naming-convention -- restore checks after component mock exports */

import { useStore } from '@renderer/store';

import { SettingsView } from './SettingsView';

const flush = async (): Promise<void> => {
  for (let tick = 0; tick < 4; tick += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
};

describe('settings loading navigation', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps navigation interactive through chunk/config loading, preserves deep links and provider drafts', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) =>
      window.setTimeout(() => callback(0), 0)
    );
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(window.clearTimeout);
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
    const originalState = useStore.getState();
    useStore.setState({ pendingSettingsSection: 'providers#provider-anchor' });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const nav = (section: string): HTMLButtonElement | null =>
      host.querySelector(`[data-testid="settings-nav-${section}"]`);

    try {
      await act(async () => {
        root.render(<SettingsView />);
        await flush();
      });
      const navigation = host.querySelector('nav');
      expect(navigation).not.toBeNull();
      expect(nav('providers')?.getAttribute('aria-current')).toBe('page');
      expect(host.querySelector('[role="status"]')).not.toBeNull();

      act(() => nav('appearance')?.click());
      expect(nav('appearance')?.getAttribute('aria-current')).toBe('page');
      expect(host.querySelector('nav')).toBe(navigation);

      act(() =>
        useStore.setState({ pendingSettingsSection: 'notifications#notifications-anchor' })
      );
      await act(async () => {
        loading.loadContent();
        await flush();
      });
      expect(nav('notifications')?.getAttribute('aria-current')).toBe('page');
      expect(host.querySelector('nav')).toBe(navigation);
      expect(host.querySelector('[role="status"]')).not.toBeNull();
      expect(scroll).not.toHaveBeenCalled();

      await act(async () => {
        loading.loadConfig();
        await flush();
      });
      for (
        let attempt = 0;
        attempt < 30 && !host.textContent?.includes('Notifications form');
        attempt += 1
      ) {
        await act(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
        });
      }
      expect(host.textContent).toContain('Notifications form');
      await act(async () => {
        await flush();
      });
      expect(scroll).toHaveBeenCalledWith({ block: 'start' });
      expect(scroll.mock.instances[0]).toBe(host.querySelector('#notifications-anchor'));
      expect(host.querySelector('nav')).toBe(navigation);

      await act(async () => {
        nav('providers')?.click();
        await flush();
      });
      for (let attempt = 0; attempt < 30 && !host.querySelector('input'); attempt += 1) {
        await act(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
        });
      }
      const draft = host.querySelector<HTMLInputElement>('input[aria-label="Provider draft"]');
      expect(draft).not.toBeNull();
      if (!draft) throw new Error('Provider form was not loaded');
      draft.value = 'Unsaved connection';
      act(() => nav('appearance')?.click());
      expect(host.textContent).toContain('Appearance form');
      expect(
        draft.closest('[data-testid="provider-settings-page"]')?.classList.contains('hidden')
      ).toBe(true);
      expect(draft.getAttribute('data-active')).toBe('false');
      act(() => nav('providers')?.click());
      expect(host.querySelector('input[aria-label="Provider draft"]')).toBe(draft);
      expect(draft.value).toBe('Unsaved connection');
      expect(draft.getAttribute('data-active')).toBe('true');
    } finally {
      act(() => root.unmount());
      useStore.setState(originalState, true);
    }
  });
});
