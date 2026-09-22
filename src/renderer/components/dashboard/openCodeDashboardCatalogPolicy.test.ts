import { describe, expect, it } from 'vitest';

import { canLoadOpenCodeDashboardCatalog } from './openCodeDashboardCatalogPolicy';

import type { CliProviderStatus } from '@shared/types';

describe('OpenCode dashboard catalog detection gate', () => {
  it.each(['opencode-live-host', 'opencode-managed-runtime'])(
    'permits read-only catalogs with %s evidence despite passive missing metadata',
    (id) => {
      const provider = {
        providerId: 'opencode',
        supported: false,
        authenticated: false,
        capabilities: { teamLaunch: false },
        externalRuntimeDiagnostics: [{ id, detected: true }],
      } as unknown as CliProviderStatus;
      expect(canLoadOpenCodeDashboardCatalog(provider, null)).toBe(true);
      expect(provider.supported).toBe(false);
      expect(provider.capabilities.teamLaunch).toBe(false);
    }
  );
  it('does not treat unrelated or negative detection as permission to query', () => {
    const provider = {
      supported: false,
      externalRuntimeDiagnostics: [
        { id: 'opencode-live-host', detected: false },
        { id: 'codex', detected: true },
      ],
    } as unknown as CliProviderStatus;
    expect(canLoadOpenCodeDashboardCatalog(provider, null)).toBe(false);
    expect(canLoadOpenCodeDashboardCatalog(null, null)).toBe(false);
  });
});
