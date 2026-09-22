import type {
  CliExtensionCapabilities,
  CliExtensionCapability,
  CliProviderStatus,
} from '@shared/types';

const SUPPORTED_SHARED_CAPABILITY: CliExtensionCapability = {
  status: 'supported',
  ownership: 'shared',
  reason: null,
};

const LEGACY_MULTIMODEL_FALLBACK_CAPABILITIES: CliExtensionCapabilities = {
  plugins: {
    status: 'unsupported',
    ownership: 'shared',
    reason:
      'This runtime does not declare plugin capability support. Upgrade the runtime to manage plugins here.',
  },
  mcp: {
    status: 'read-only',
    ownership: 'shared',
    reason:
      'This runtime does not declare MCP management support. Upgrade the runtime to install or remove MCP servers here.',
  },
  skills: {
    ...SUPPORTED_SHARED_CAPABILITY,
  },
  apiKeys: {
    ...SUPPORTED_SHARED_CAPABILITY,
  },
};

export function createDefaultCliExtensionCapabilities(
  overrides?: Partial<CliExtensionCapabilities>
): CliExtensionCapabilities {
  return {
    plugins: { ...SUPPORTED_SHARED_CAPABILITY },
    mcp: { ...SUPPORTED_SHARED_CAPABILITY },
    skills: { ...SUPPORTED_SHARED_CAPABILITY },
    apiKeys: { ...SUPPORTED_SHARED_CAPABILITY },
    ...overrides,
  };
}

export function createLegacyRuntimeFallbackCliExtensionCapabilities(
  overrides?: Partial<CliExtensionCapabilities>
): CliExtensionCapabilities {
  return {
    plugins: { ...LEGACY_MULTIMODEL_FALLBACK_CAPABILITIES.plugins },
    mcp: { ...LEGACY_MULTIMODEL_FALLBACK_CAPABILITIES.mcp },
    skills: { ...LEGACY_MULTIMODEL_FALLBACK_CAPABILITIES.skills },
    apiKeys: { ...LEGACY_MULTIMODEL_FALLBACK_CAPABILITIES.apiKeys },
    ...overrides,
  };
}

export function getCliProviderExtensionCapabilities(
  provider: Pick<CliProviderStatus, 'capabilities'>
): CliExtensionCapabilities {
  return provider.capabilities.extensions ?? createLegacyRuntimeFallbackCliExtensionCapabilities();
}

export function getCliProviderExtensionCapability(
  provider: Pick<CliProviderStatus, 'capabilities'>,
  section: keyof CliExtensionCapabilities
): CliExtensionCapability {
  return getCliProviderExtensionCapabilities(provider)[section];
}

export function isCliExtensionCapabilityAvailable(
  capability: Pick<CliExtensionCapability, 'status'>
): boolean {
  return capability.status === 'supported' || capability.status === 'read-only';
}

export function isCliExtensionCapabilityMutable(
  capability: Pick<CliExtensionCapability, 'status'>
): boolean {
  return capability.status === 'supported';
}
