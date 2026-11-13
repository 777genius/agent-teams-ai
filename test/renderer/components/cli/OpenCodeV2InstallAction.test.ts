import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { OpenCodeV2InstallAction } from '@features/opencode-runtime-installer/renderer';
import { describe, expect, it, vi } from 'vitest';

import type { OpenCodeRuntimeStatus } from '@shared/types';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

function render(status: OpenCodeRuntimeStatus, busy = false): string {
  return renderToStaticMarkup(
    createElement(OpenCodeV2InstallAction, {
      status,
      busy,
      onInstall: vi.fn(),
    })
  );
}

describe('OpenCode V2 installation offer', () => {
  it.each([true, false])('hides support installation during native checking (busy=%s)', (busy) => {
    expect(
      render(
        {
          installed: true,
          version: '2.1.4',
          source: 'path',
          state: busy ? 'ready' : 'checking',
          v2Support: 'required',
          compatibleV2Version: '2.2.0',
        },
        busy
      )
    ).toBe('');
  });

  it.each(['path', 'app-managed', 'override'] as const)(
    'does not offer a major upgrade for V1 selected from %s',
    (source) => {
      expect(
        render({
          installed: true,
          version: '1.19.4',
          source,
          state: 'ready',
          compatibleV2Version: '2.1.4',
        })
      ).toBe('');
    }
  );

  it.each([false, true])('requires confirmation before support-only repair (maintenance=%s)', async (maintenance) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const onInstall = vi.fn();
    try {
      await act(async () =>
        root.render(
          createElement(OpenCodeV2InstallAction, {
            status: {
              installed: true,
              version: '2.1.4',
              engineVersion: '2.1.4',
              source: 'captured-host',
              state: 'ready',
              v2Support: 'ready',
            },
            busy: false,
            onInstall,
          })
        )
      );
      expect(host.querySelector('button')).toBeNull();
      expect(onInstall).not.toHaveBeenCalled();
      await act(async () =>
        root.render(
          createElement(OpenCodeV2InstallAction, {
            status: maintenance ? {
              installed: true,
              version: '2.1.4',
              engineVersion: '2.1.4',
              sourceRevision: 'TEST original source',
              source: 'captured-host',
              state: 'ready',
              v2Support: 'ready',
              v2Maintenance: { kind: 'installed', cliVersion: '2.0.21',
                engineVersion: '2.1.4', support: 'ready' },
            } : {
              installed: true,
              version: '2.0.21',
              engineVersion: '2.1.4',
              source: 'override',
              state: 'ready',
              v2Support: 'ready',
              compatibleV2Version: '2.1.4',
            },
            busy: false,
            onInstall,
          })
        )
      );
      await act(async () => host.querySelector<HTMLButtonElement>('button')?.click());
      const dialog = document.querySelector('[data-testid="opencode-v2-reinstall-dialog"]');
      expect(dialog?.textContent).toContain('cliStatus.runtimeInstall.v2ReinstallDescription');
      expect(dialog?.textContent).toContain('cliStatus.runtimeInstall.v2ReinstallEffect');
      expect(onInstall).not.toHaveBeenCalled();
      const cancel = Array.from(dialog!.querySelectorAll('button')).find(
        (button) => button.textContent === 'cliStatus.runtimeInstall.v2ReinstallCancel'
      );
      await act(async () => cancel?.click());
      expect(document.querySelector('[data-testid="opencode-v2-reinstall-dialog"]')).toBeNull();
      expect(onInstall).not.toHaveBeenCalled();
      await act(async () => host.querySelector<HTMLButtonElement>('button')?.click());
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>('[data-testid="opencode-v2-reinstall-confirm"]')
          ?.click()
      );
      expect(onInstall).toHaveBeenCalledExactlyOnceWith({ generation: 'v2', supportOnly: true });
      expect(document.querySelector('[data-testid="opencode-v2-reinstall-dialog"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });

  it('uses the existing download and support-only actions for original V2 maintenance', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const onInstall = vi.fn();
    const status: OpenCodeRuntimeStatus = {
      installed: true, version: '2.1.4', engineVersion: '2.1.4', source: 'captured-host',
      sourceRevision: 'TEST original source', state: 'ready', v2Support: 'ready',
    };
    try {
      for (const [index, support] of [false, true].entries()) {
        const selected: OpenCodeRuntimeStatus = {
          ...status,
          v2Maintenance: support
            ? { kind: 'installed', cliVersion: '2.0.21', engineVersion: '2.1.4', support: 'required' }
            : { kind: 'missing', engineVersion: '2.1.4' },
        };
        await act(async () => root.render(
          createElement(OpenCodeV2InstallAction, {
            status: { ...selected, compatibleV2Version: '2.1.4' }, busy: false, onInstall,
          })
        ));
        const button = host.querySelector<HTMLButtonElement>('button');
        expect(button?.textContent).toContain(support
          ? 'cliStatus.runtimeInstall.v2SupportInstall' : 'cliStatus.runtimeInstall.install');
        expect(onInstall).toHaveBeenCalledTimes(index);
        await act(async () => button?.click());
        expect(onInstall).toHaveBeenCalledTimes(index + 1);
        expect(onInstall).toHaveBeenLastCalledWith(support
          ? { generation: 'v2', supportOnly: true } : { generation: 'v2' });
        expect(render(selected, true)).toBe('');
        expect(render({ ...selected, state: 'checking' })).toBe('');
        expect(render({ ...selected, state: 'failed' })).toBe('');
        expect(render({ ...selected, version: '1.19.4' })).toBe('');
        expect(render({ ...selected, engineVersion: '2.9.9' })).toBe('');
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });

  it('leaves a fresh V2 installation to the primary install action', () => {
    expect(
      render({ installed: false, source: 'missing', state: 'idle', compatibleV2Version: '2.1.4' })
    ).toBe('');
  });
});
