import { describe, expect, it } from 'vitest';

import {
  formatProviderBackendLabel,
  migrateProviderBackendId,
} from '../../../src/shared/utils/providerBackend';

describe('providerBackend utils', () => {
  it('does not let Codex backends leak into Anthropic selections', () => {
    expect(migrateProviderBackendId('anthropic', 'codex-native')).toBeUndefined();
    expect(formatProviderBackendLabel('anthropic', 'codex-native')).toBeUndefined();
  });

  it('keeps Codex native defaults and legacy backend migration scoped to Codex', () => {
    expect(migrateProviderBackendId('codex', undefined)).toBe('codex-native');
    expect(migrateProviderBackendId('codex', 'api')).toBe('codex-native');
    expect(migrateProviderBackendId('codex', 'adapter')).toBe('codex-native');
    expect(migrateProviderBackendId('codex', 'opencode-cli')).toBeUndefined();
  });

  it('keeps Gemini and OpenCode backend ids provider-specific', () => {
    expect(migrateProviderBackendId('gemini', 'api')).toBe('api');
    expect(migrateProviderBackendId('gemini', 'cli-sdk')).toBe('cli-sdk');
    expect(migrateProviderBackendId('gemini', 'codex-native')).toBeUndefined();
    expect(migrateProviderBackendId('opencode', 'opencode-cli')).toBe('opencode-cli');
    expect(migrateProviderBackendId('opencode', 'adapter')).toBe('adapter');
    expect(migrateProviderBackendId('opencode', 'codex-native')).toBeUndefined();
    expect(migrateProviderBackendId(undefined, 'codex-native')).toBeUndefined();
  });
});
