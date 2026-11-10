import { describe, expect, it } from 'vitest';

import { buildProviderPrepareModelCacheKey } from '@renderer/components/team/dialogs/providerPrepareCacheKey';

describe('buildProviderPrepareModelCacheKey', () => {
  it('separates limit-context variants for the same provider runtime', () => {
    const sharedInput = {
      cwd: '/tmp/project',
      providerId: 'anthropic' as const,
      backendSummary: 'Claude Code',
      runtimeStatusSignature: 'status:v1',
    };

    expect(
      buildProviderPrepareModelCacheKey({
        ...sharedInput,
        limitContext: false,
      })
    ).not.toBe(
      buildProviderPrepareModelCacheKey({
        ...sharedInput,
        limitContext: true,
      })
    );
  });

  it('still reuses cache for identical runtime conditions', () => {
    const input = {
      cwd: '/tmp/project',
      providerId: 'codex' as const,
      backendSummary: 'Codex native',
      limitContext: false,
      runtimeStatusSignature: 'status:v1',
    };

    expect(buildProviderPrepareModelCacheKey(input)).toBe(buildProviderPrepareModelCacheKey(input));
  });

  it('separates runtime-status variants for the same provider runtime', () => {
    const sharedInput = {
      cwd: '/tmp/project',
      providerId: 'codex' as const,
      backendSummary: 'Codex native',
      limitContext: false,
    };

    expect(
      buildProviderPrepareModelCacheKey({
        ...sharedInput,
        runtimeStatusSignature: 'status:v1',
      })
    ).not.toBe(
      buildProviderPrepareModelCacheKey({
        ...sharedInput,
        runtimeStatusSignature: 'status:v2',
      })
    );
  });
});
