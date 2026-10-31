import { renderToStaticMarkup } from 'react-dom/server';

import { OpenCodeV2InstallAction } from '@features/opencode-runtime-installer/renderer';
import { getRuntimeInstallLabel } from '@renderer/components/dashboard/runtimeInstallActionUi';
import { describe, expect, it, vi } from 'vitest';

import type { OpenCodeRuntimeStatus } from '@shared/types';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

function render(status: OpenCodeRuntimeStatus): string {
  return renderToStaticMarkup(
    <OpenCodeV2InstallAction status={status} busy={false} onInstall={() => undefined} />
  );
}

describe('V2 installation choice', () => {
  it('labels the first-time primary install as OpenCode V1', () => {
    const t = ((key: string) => key) as Parameters<typeof getRuntimeInstallLabel>[1];
    const label = getRuntimeInstallLabel(
      { installed: false, source: 'missing', state: 'idle', compatibleV2Version: '2.1.4' },
      t
    );
    expect(label).toBe('cliStatus.runtimeInstall.install OpenCode V1');
  });
  it.each(['required', 'ready'] as const)(
    'exposes support-only install/repair for native V2 with %s availability',
    (v2Support) => {
      const markup = render({
        installed: true,
        source: 'override',
        state: 'ready',
        version: '2.9.0',
        v2Support,
        compatibleV2Version: '2.1.4',
      });
      expect(markup).toContain(v2Support === 'required' ? 'v2SupportInstall' : 'v2SupportRepair');
      expect(markup).toContain('<button');
    }
  );

  it('offers no V2 support action when the native platform has no qualified engine', () => {
    expect(
      render({
        installed: true,
        source: 'path',
        state: 'idle',
        version: '2.9.0',
        v2Support: 'required',
        compatibleV2Version: null,
      })
    ).toBe('');
  });

  it('offers the pinned V2 only for an unsupported installed runtime', () => {
    expect(
      render({
        installed: true,
        source: 'path',
        state: 'ready',
        version: '0.9.0',
        compatibleV2Version: '2.1.4',
      })
    ).toContain('V2 2.1.4');
  });
  it.each(['1.18.3', '2.9.0'])(
    'preserves supported version %s without a migration offer',
    (version) => {
      for (const source of ['path', 'override'] as const) {
        expect(
          render({ installed: true, source, state: 'ready', version, compatibleV2Version: '2.1.4' })
        ).toBe('');
      }
    }
  );
  it('explains override selection without promoting V2 for new installs', () => {
    const override = render({
      installed: true,
      source: 'override',
      state: 'ready',
      version: '0.9.0',
      compatibleV2Version: '2.1.4',
    });
    expect(override).toContain('overrideSelection');
    expect(override).not.toContain('<button');
    const unsupported = render({
      installed: false,
      source: 'missing',
      state: 'idle',
      compatibleV2Version: null,
    });
    expect(unsupported).toBe('');
    expect(render({ installed: false, source: 'missing', state: 'idle', compatibleV2Version: '2.1.4' })).toBe('');
  });
});
