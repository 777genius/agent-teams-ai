import { describe, expect, it } from 'vitest';

import type { PluginCatalogItem } from '@shared/types/extensions';

import {
  buildPluginId,
  formatInstallCount,
  getExtensionActionDisableReason,
  getCapabilityLabel,
  getInstallationSummaryLabel,
  getPluginOperationKey,
  getPrimaryCapabilityLabel,
  hasInstallationInScope,
  inferCapabilities,
  normalizeCategory,
  normalizeRepoUrl,
  parseGitHubOwnerRepo,
  sanitizeMcpServerName,
} from '@shared/utils/extensionNormalizers';

describe('normalizeRepoUrl', () => {
  it('lowercases and strips .git', () => {
    expect(normalizeRepoUrl('https://GitHub.com/Org/Repo.git')).toBe(
      'https://github.com/org/repo',
    );
  });

  it('strips trailing slashes', () => {
    expect(normalizeRepoUrl('https://github.com/org/repo/')).toBe(
      'https://github.com/org/repo',
    );
  });

  it('handles already clean URLs', () => {
    expect(normalizeRepoUrl('https://github.com/org/repo')).toBe(
      'https://github.com/org/repo',
    );
  });
});

describe('inferCapabilities', () => {
  const makePlugin = (overrides: Partial<PluginCatalogItem>): PluginCatalogItem => ({
    pluginId: 'test@marketplace',
    marketplaceId: 'test@marketplace',
    qualifiedName: 'test@marketplace',
    name: 'test',
    source: 'official',
    description: 'test',
    category: 'development',
    hasLspServers: false,
    hasMcpServers: false,
    hasAgents: false,
    hasCommands: false,
    hasHooks: false,
    isExternal: false,
    ...overrides,
  });

  it('returns "skill" fallback when no capabilities', () => {
    expect(inferCapabilities(makePlugin({}))).toEqual(['skill']);
  });

  it('detects LSP capability', () => {
    expect(inferCapabilities(makePlugin({ hasLspServers: true }))).toEqual(['lsp']);
  });

  it('detects multiple capabilities', () => {
    expect(
      inferCapabilities(makePlugin({ hasLspServers: true, hasMcpServers: true })),
    ).toEqual(['lsp', 'mcp']);
  });

  it('preserves capability order', () => {
    expect(
      inferCapabilities(
        makePlugin({
          hasHooks: true,
          hasAgents: true,
          hasLspServers: true,
        }),
      ),
    ).toEqual(['lsp', 'agent', 'hook']);
  });
});

describe('getPrimaryCapabilityLabel', () => {
  it('returns "Skill" for empty array', () => {
    expect(getPrimaryCapabilityLabel([])).toBe('Skill');
  });

  it('returns label for first capability', () => {
    expect(getPrimaryCapabilityLabel(['lsp', 'mcp'])).toBe('LSP');
  });
});

describe('getCapabilityLabel', () => {
  it('maps all capabilities', () => {
    expect(getCapabilityLabel('lsp')).toBe('LSP');
    expect(getCapabilityLabel('mcp')).toBe('MCP');
    expect(getCapabilityLabel('agent')).toBe('Agent');
    expect(getCapabilityLabel('command')).toBe('Command');
    expect(getCapabilityLabel('hook')).toBe('Hook');
    expect(getCapabilityLabel('skill')).toBe('Skill');
  });
});

describe('formatInstallCount', () => {
  it('formats small numbers as-is', () => {
    expect(formatInstallCount(0)).toBe('0');
    expect(formatInstallCount(42)).toBe('42');
    expect(formatInstallCount(999)).toBe('999');
  });

  it('formats thousands with K suffix', () => {
    expect(formatInstallCount(1_000)).toBe('1K');
    expect(formatInstallCount(1_500)).toBe('1.5K');
    expect(formatInstallCount(10_000)).toBe('10K');
    expect(formatInstallCount(277_472)).toBe('277K');
  });

  it('formats millions with M suffix', () => {
    expect(formatInstallCount(1_000_000)).toBe('1M');
    expect(formatInstallCount(1_200_000)).toBe('1.2M');
    expect(formatInstallCount(15_000_000)).toBe('15M');
  });

  it('removes trailing .0 in formatted numbers', () => {
    expect(formatInstallCount(5_000)).toBe('5K');
    expect(formatInstallCount(2_000_000)).toBe('2M');
  });
});

describe('normalizeCategory', () => {
  it('lowercases and trims', () => {
    expect(normalizeCategory(' Development ')).toBe('development');
  });

  it('returns "other" for undefined', () => {
    expect(normalizeCategory(undefined)).toBe('other');
  });

  it('returns "other" for empty string', () => {
    expect(normalizeCategory('')).toBe('other');
    expect(normalizeCategory('   ')).toBe('other');
  });
});

describe('buildPluginId', () => {
  it('creates qualifiedName format', () => {
    expect(buildPluginId('context7', 'claude-plugins-official')).toBe(
      'context7@claude-plugins-official',
    );
  });
});

describe('getPluginOperationKey', () => {
  it('namespaces plugin operation keys by scope', () => {
    expect(getPluginOperationKey('context7@claude-plugins-official', 'local')).toBe(
      'plugin:context7@claude-plugins-official:local',
    );
  });
});

describe('hasInstallationInScope', () => {
  it('returns true when the selected scope exists', () => {
    expect(
      hasInstallationInScope(
        [
          { scope: 'user' },
          { scope: 'project' },
        ],
        'project',
      ),
    ).toBe(true);
  });

  it('returns false when the selected scope is missing', () => {
    expect(hasInstallationInScope([{ scope: 'user' }], 'project')).toBe(false);
  });
});

describe('getInstallationSummaryLabel', () => {
  it('returns null when there are no installations', () => {
    expect(getInstallationSummaryLabel([])).toBeNull();
  });

  it('describes a single global installation', () => {
    expect(getInstallationSummaryLabel([{ scope: 'user' }])).toBe('Installed globally');
  });

  it('describes a single project installation', () => {
    expect(getInstallationSummaryLabel([{ scope: 'project' }])).toBe('Installed in project');
  });

  it('summarizes multiple scopes without pretending they are global', () => {
    expect(
      getInstallationSummaryLabel([
        { scope: 'project' },
        { scope: 'user' },
      ]),
    ).toBe('Installed in 2 scopes');
  });
});

describe('getExtensionActionDisableReason', () => {
  it('requires auth only for install actions', () => {
    expect(
      getExtensionActionDisableReason({
        isInstalled: false,
        cliStatus: { installed: true, authLoggedIn: false },
        cliStatusLoading: false,
      }),
    ).toContain('not signed in');
  });

  it('allows uninstall when CLI is present but auth is missing', () => {
    expect(
      getExtensionActionDisableReason({
        isInstalled: true,
        cliStatus: { installed: true, authLoggedIn: false },
        cliStatusLoading: false,
      }),
    ).toBeNull();
  });

  it('still blocks actions when the CLI is missing', () => {
    expect(
      getExtensionActionDisableReason({
        isInstalled: true,
        cliStatus: { installed: false, authLoggedIn: false },
        cliStatusLoading: false,
      }),
    ).toContain('Claude CLI required');
  });
});

describe('sanitizeMcpServerName', () => {
  it('lowercases and replaces spaces with dashes', () => {
    expect(sanitizeMcpServerName('My Server')).toBe('my-server');
  });

  it('strips special characters', () => {
    expect(sanitizeMcpServerName('Stripe (Beta)')).toBe('stripe-beta');
    expect(sanitizeMcpServerName('MCP/Server')).toBe('mcpserver');
    expect(sanitizeMcpServerName("O'Reilly")).toBe('oreilly');
  });

  it('keeps dots, underscores, and dashes', () => {
    expect(sanitizeMcpServerName('v2.0-server_name')).toBe('v2.0-server_name');
  });

  it('handles simple names', () => {
    expect(sanitizeMcpServerName('Alpic')).toBe('alpic');
    expect(sanitizeMcpServerName('Context7')).toBe('context7');
  });
});

describe('parseGitHubOwnerRepo', () => {
  it('extracts owner/repo from https URL', () => {
    expect(parseGitHubOwnerRepo('https://github.com/owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('strips .git suffix', () => {
    expect(parseGitHubOwnerRepo('https://github.com/owner/repo.git')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('strips trailing slashes', () => {
    expect(parseGitHubOwnerRepo('https://github.com/owner/repo/')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('returns null for non-GitHub URLs', () => {
    expect(parseGitHubOwnerRepo('https://gitlab.com/owner/repo')).toBeNull();
    expect(parseGitHubOwnerRepo('https://example.com')).toBeNull();
  });

  it('returns null for invalid URL', () => {
    expect(parseGitHubOwnerRepo('not-a-url')).toBeNull();
  });
});
