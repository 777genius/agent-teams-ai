import { renderToStaticMarkup } from 'react-dom/server';

import { OpenCodeV2InstallAction } from '@features/opencode-runtime-installer/renderer';
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
  it.each(['required', 'ready'] as const)(
    'exposes support-only install/repair for native V2 with %s availability',
    (v2Support) => {
      const markup = render({
        installed: true,
        source: 'override',
        state: 'ready',
        version: '2.9.0',
        v2Support,
      });
      expect(markup).toContain(v2Support === 'required' ? 'v2SupportInstall' : 'v2SupportRepair');
      expect(markup).toContain('<button');
    }
  );

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
  it('explains override selection and an unqualified platform without a misleading V2 action', () => {
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
    expect(unsupported).toContain('v2Unavailable');
    expect(unsupported).not.toContain('<button');
  });
});
