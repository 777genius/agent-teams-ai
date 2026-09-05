import { isOpenCodePassiveStatusReadyForCatalog } from '@renderer/components/team/dialogs/openCodeRuntimeStatusUi';
import { describe, expect, it } from 'vitest';

import type { CliProviderStatus, OpenCodeRuntimeStatus } from '@shared/types';

const runtimeStatus = { source: 'path' } as OpenCodeRuntimeStatus;

function status(
  outcome: CliProviderStatus['statusCheckOutcome'],
  supported: boolean
): CliProviderStatus {
  return {
    providerId: 'opencode',
    statusCheckOutcome: outcome,
    supported,
    models: ['stale/model'],
  } as CliProviderStatus;
}

describe('isOpenCodePassiveStatusReadyForCatalog', () => {
  it('accepts authoritative supported runtime evidence', () => {
    expect(isOpenCodePassiveStatusReadyForCatalog(status('authoritative', true), null)).toBe(true);
  });

  it('allows cached models while passive authority is still unresolved', () => {
    expect(isOpenCodePassiveStatusReadyForCatalog(status('model_only', false), runtimeStatus)).toBe(
      true
    );
  });

  it('rejects stale models after an authoritative unsupported result', () => {
    expect(
      isOpenCodePassiveStatusReadyForCatalog(status('authoritative', false), runtimeStatus)
    ).toBe(false);
  });
});
