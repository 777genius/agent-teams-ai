import { describe, expect, it } from 'vitest';

import {
  createLegacyRuntimeFallbackCliExtensionCapabilities,
  getCliProviderExtensionCapabilities,
} from '@shared/utils/providerExtensionCapabilities';

import type { CliProviderStatus } from '@shared/types';

function makeProvider(
  overrides?: Partial<CliProviderStatus>
): Pick<CliProviderStatus, 'capabilities'> {
  return {
    capabilities: {
      teamLaunch: false,
      oneShot: false,
      ...(overrides?.capabilities ?? {}),
    } as CliProviderStatus['capabilities'],
  };
}

describe('providerExtensionCapabilities', () => {
  it('returns conservative fallback capabilities when runtime omits extension metadata', () => {
    const capabilities = getCliProviderExtensionCapabilities(
      makeProvider({
        capabilities: {
          teamLaunch: true,
          oneShot: true,
        } as CliProviderStatus['capabilities'],
      })
    );

    expect(capabilities).toEqual(createLegacyRuntimeFallbackCliExtensionCapabilities());
  });

  it('keeps plugins unsupported and mcp read-only in the legacy multimodel fallback', () => {
    const capabilities = createLegacyRuntimeFallbackCliExtensionCapabilities();

    expect(capabilities.plugins.status).toBe('unsupported');
    expect(capabilities.mcp.status).toBe('read-only');
    expect(capabilities.skills.status).toBe('supported');
    expect(capabilities.apiKeys.status).toBe('supported');
  });
});
