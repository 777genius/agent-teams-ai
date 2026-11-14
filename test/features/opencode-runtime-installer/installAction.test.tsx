import { renderToStaticMarkup } from 'react-dom/server';

import { OpenCodeV2InstallAction } from '@features/opencode-runtime-installer/renderer';
import { isOpenCodeRuntimeUsable } from '@features/runtime-provider-management/renderer';
import {
  getRuntimeInstallLabel,
  shouldShowOpenCodeInstallAction,
} from '@renderer/components/dashboard/runtimeInstallActionUi';
import { describe, expect, it, vi } from 'vitest';

import type { CliProviderStatus, OpenCodeRuntimeStatus } from '@shared/types';

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

    const provider: CliProviderStatus = {
      providerId: 'opencode',
      displayName: 'OpenCode',
      supported: true,
      authenticated: true,
      authMethod: 'managed',
      verificationState: 'verified',
      models: [],
      canLoginFromUi: false,
      capabilities: {
        teamLaunch: true,
        oneShot: true,
        extensions: {
          plugins: { status: 'unsupported', ownership: 'shared' },
          mcp: { status: 'unsupported', ownership: 'shared' },
          skills: { status: 'unsupported', ownership: 'shared' },
          apiKeys: { status: 'unsupported', ownership: 'shared' },
        },
      },
    };
    const native: OpenCodeRuntimeStatus = {
      installed: true,
      source: 'captured-host',
      state: 'ready',
      nativeGeneration: 'v1',
      sourceRevision: 'b'.repeat(64),
    };
    const missing: OpenCodeRuntimeStatus = {
      ...native, v1Maintenance: { installed: false, source: 'missing', state: 'idle' },
    };
    expect(isOpenCodeRuntimeUsable(native)).toBe(true);
    expect(isOpenCodeRuntimeUsable(missing)).toBe(true);
    expect(shouldShowOpenCodeInstallAction(provider, false, native, false)).toBe(false);
    expect(shouldShowOpenCodeInstallAction(provider, false, missing, false)).toBe(true);
    expect(getRuntimeInstallLabel(missing, t)).toBe('cliStatus.runtimeInstall.install OpenCode V1');
    expect(shouldShowOpenCodeInstallAction(provider, true, missing, false)).toBe(false);
    expect(shouldShowOpenCodeInstallAction(provider, false, missing, true)).toBe(false);

    const unknown: OpenCodeRuntimeStatus = {
      installed: true,
      source: 'captured-host',
      state: 'ready',
      sourceRevision: 'b'.repeat(64),
      v1Maintenance: { installed: false, source: 'missing', state: 'idle' },
    };
    const unsupported: OpenCodeRuntimeStatus = { ...missing, version: '2.777.777 (TEST sentinel)' };
    for (const refused of [unknown, unsupported, { ...missing, nativeGeneration: 'v2' as const }]) {
      expect(isOpenCodeRuntimeUsable(refused)).toBe(false);
      expect(getRuntimeInstallLabel(refused, t)).not.toBe('cliStatus.runtimeInstall.install OpenCode V1');
    }
    expect(shouldShowOpenCodeInstallAction(provider, false, unknown, false)).toBe(false);
    expect(getRuntimeInstallLabel({ ...missing, state: 'checking' }, t))
      .toBe('cliStatus.runtimeInstall.checking');
    expect(getRuntimeInstallLabel({ ...missing, state: 'failed' }, t))
      .toBe('cliStatus.runtimeInstall.retryInstall');
    expect(isOpenCodeRuntimeUsable({ ...missing, state: 'failed' })).toBe(false);
    const path: OpenCodeRuntimeStatus = {
      ...native,
      v1Maintenance: { installed: true, source: 'path', state: 'ready', version: '1.19.4' },
    };
    expect(shouldShowOpenCodeInstallAction(provider, false, path, false)).toBe(false);
    expect(getRuntimeInstallLabel({
      ...native,
      source: 'path',
      version: '1.19.4',
      latestVersion: '1.19.5',
      updateAvailable: true,
    }, t)).toBe('cliStatus.runtimeInstall.update v1.19.4 → v1.19.5');
  });
  it('labels a failed first-time OpenCode installation as retry', () => {
    const t = ((key: string) => key) as Parameters<typeof getRuntimeInstallLabel>[1];
    expect(
      getRuntimeInstallLabel(
        { installed: false, source: 'missing', state: 'failed', compatibleV2Version: '2.1.4' },
        t
      )
    ).toBe('cliStatus.runtimeInstall.retryInstall');
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
    expect(
      render({ installed: false, source: 'override', state: 'failed', compatibleV2Version: null })
    ).toContain('overrideSelection');
    const unsupported = render({
      installed: false,
      source: 'missing',
      state: 'idle',
      compatibleV2Version: null,
    });
    expect(unsupported).toBe('');
    expect(
      render({ installed: false, source: 'missing', state: 'idle', compatibleV2Version: '2.1.4' })
    ).toBe('');
  });
});
