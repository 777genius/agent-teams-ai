import {
  createLoadingMultimodelCliStatus,
  mergeCliStatusPreservingHydratedProviders,
} from '@renderer/store/slices/cliInstallerSlice';
import { describe, expect, it } from 'vitest';

describe('mergeCliStatusPreservingHydratedProviders', () => {
  it('returns the previous status reference when a structurally identical clone arrives', () => {
    // This mirrors the real IPC path: `CliInstallerService.cloneCliInstallationStatus()`
    // (called from `publishStatusSnapshot()`) hands the renderer a fresh
    // `CliInstallationStatus` whose `providers` are also freshly-cloned
    // objects, even when nothing has actually changed. The merge function
    // must compare provider content (not just reference) so that no-op
    // progress ticks do not produce a new `cliStatus` identity and trigger
    // a re-render storm across every consumer.
    const current = createLoadingMultimodelCliStatus();
    const incoming = structuredClone(current);

    const merged = mergeCliStatusPreservingHydratedProviders(current, incoming);

    expect(merged).toBe(current);
  });

  it('returns the previous status reference when an authenticated clone arrives', () => {
    const base = createLoadingMultimodelCliStatus();
    const current = {
      ...base,
      authLoggedIn: true,
      authStatusChecking: false,
      authMethod: 'oauth' as const,
      providers: base.providers.map((provider, index) =>
        index === 0
          ? {
              ...provider,
              authenticated: true,
              authMethod: 'oauth' as const,
              supported: true,
              verificationState: 'verified' as const,
              statusMessage: null,
              models: ['model-a', 'model-b'],
            }
          : provider
      ),
    };
    const incoming = structuredClone(current);

    const merged = mergeCliStatusPreservingHydratedProviders(current, incoming);

    expect(merged).toBe(current);
  });

  it('returns a new status when an incoming provider field actually differs', () => {
    const current = createLoadingMultimodelCliStatus();
    const incoming = structuredClone(current);
    incoming.providers[0] = {
      ...incoming.providers[0],
      statusMessage: 'Verifying credentials...',
    };

    const merged = mergeCliStatusPreservingHydratedProviders(current, incoming);

    expect(merged).not.toBe(current);
    expect(merged.providers[0].statusMessage).toBe('Verifying credentials...');
  });
});
