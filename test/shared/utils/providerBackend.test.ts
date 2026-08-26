import { describe, expect, it } from 'vitest';

import {
  formatProviderBackendLabel,
  getDefaultProviderBackendId,
  migrateProviderBackendId,
} from '../../../src/shared/utils/providerBackend';

describe('providerBackend utils', () => {
  it('does not let Codex backends leak into Anthropic selections', () => {
    expect(migrateProviderBackendId('anthropic', 'codex-native')).toBeUndefined();
    expect(formatProviderBackendLabel('anthropic', 'codex-native')).toBeUndefined();
  });

  it('migrates legacy Codex backend ids to the native runtime', () => {
    expect(migrateProviderBackendId('codex', undefined)).toBe('codex-native');
    expect(migrateProviderBackendId('codex', 'auto')).toBe('codex-native');
    expect(migrateProviderBackendId('codex', 'api')).toBe('codex-native');
    expect(migrateProviderBackendId('codex', 'adapter')).toBe('codex-native');
    expect(migrateProviderBackendId('codex', 'codex-native')).toBe('codex-native');
    expect(migrateProviderBackendId('codex', 'opencode-cli')).toBeUndefined();
  });

  it('preserves legacy-shaped Codex routes only for an explicit selection', () => {
    expect(migrateProviderBackendId('codex', 'auto', 'explicit-selection')).toBe('auto');
    expect(migrateProviderBackendId('codex', 'adapter', 'explicit-selection')).toBe('adapter');
    expect(migrateProviderBackendId('codex', 'api', 'explicit-selection')).toBe('api');
  });

  it('keeps Gemini and OpenCode backend ids provider-specific', () => {
    expect(migrateProviderBackendId('gemini', 'api')).toBe('api');
    expect(migrateProviderBackendId('gemini', 'cli-sdk')).toBe('cli-sdk');
    expect(migrateProviderBackendId('gemini', 'codex-native')).toBeUndefined();
    expect(migrateProviderBackendId('opencode', 'opencode-cli')).toBe('opencode-cli');
    expect(migrateProviderBackendId('opencode', 'adapter')).toBe('adapter');
    expect(migrateProviderBackendId('opencode', 'codex-native')).toBeUndefined();
    expect(migrateProviderBackendId(undefined, 'codex-native')).toBeUndefined();
    expect(getDefaultProviderBackendId('opencode')).toBe('opencode-cli');
  });
});
