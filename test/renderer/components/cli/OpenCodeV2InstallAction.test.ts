import { createElement } from 'react';
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

  it('leaves a fresh V2 installation to the primary install action', () => {
    expect(
      render({ installed: false, source: 'missing', state: 'idle', compatibleV2Version: '2.1.4' })
    ).toBe('');
  });
});
