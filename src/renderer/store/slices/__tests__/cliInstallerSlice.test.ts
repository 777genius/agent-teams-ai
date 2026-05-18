import {
  createLoadingMultimodelCliStatus,
  mergeCliStatusPreservingHydratedProviders,
} from '@renderer/store/slices/cliInstallerSlice';
import { describe, expect, it } from 'vitest';

import type { CliProviderReasoningEffort } from '@shared/types/cliInstaller';

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

  it('returns current when a structurally identical populated provider clone arrives', () => {
    // Mirrors the real IPC flow with a fully-populated provider: ChatGPT-Codex
    // authenticated, with a model catalog, model availability records,
    // runtime capabilities, available backends, and a selected backend.
    // None of these fields are reference-stable across IPC clones, so the
    // equality guard must compare them by content, not reference.
    const base = createLoadingMultimodelCliStatus();
    const populatedProvider = {
      ...base.providers[1],
      authenticated: true,
      authMethod: 'codex_chatgpt' as const,
      supported: true,
      verificationState: 'verified' as const,
      statusMessage: null,
      models: ['gpt-5.2'],
      modelAvailability: [
        {
          modelId: 'gpt-5.2',
          status: 'available' as const,
          checkedAt: '2026-05-14T00:00:00.000Z',
        },
      ],
      runtimeCapabilities: {
        reasoningEffort: {
          supported: true,
          values: ['low', 'medium', 'high'] as CliProviderReasoningEffort[],
        },
      },
      availableBackends: [
        {
          id: 'codex-native',
          label: 'Codex native',
          description: 'App-managed Codex runtime',
          selectable: true,
          recommended: true,
          available: true,
        },
      ],
      backend: { kind: 'codex-cli' as const, label: 'Codex CLI' },
    };
    const current = {
      ...base,
      authLoggedIn: true,
      authStatusChecking: false,
      authMethod: 'codex_chatgpt' as const,
      providers: base.providers.map((provider, index) =>
        index === 1 ? populatedProvider : provider
      ),
    };
    const incoming = structuredClone(current);

    const merged = mergeCliStatusPreservingHydratedProviders(current, incoming);

    expect(merged).toBe(current);
    expect(merged.providers[1]).toBe(current.providers[1]);
  });

  it('produces a new status when a cloned populated field actually changed', () => {
    // Negative companion to the populated-clone test: confirms that when a
    // cloned DTO field really differs, the merge does NOT preserve the
    // previous reference (i.e. we never let stale data through).
    const base = createLoadingMultimodelCliStatus();
    const populatedProvider = {
      ...base.providers[1],
      authenticated: true,
      authMethod: 'codex_chatgpt' as const,
      supported: true,
      verificationState: 'verified' as const,
      models: ['gpt-5.2'],
      availableBackends: [
        {
          id: 'codex-native',
          label: 'Codex native',
          description: 'App-managed Codex runtime',
          selectable: true,
          recommended: true,
          available: true,
        },
      ],
    };
    const current = {
      ...base,
      providers: base.providers.map((provider, index) =>
        index === 1 ? populatedProvider : provider
      ),
    };
    const incoming = structuredClone(current);
    // Flip a nested DTO field on the cloned snapshot.
    incoming.providers[1].availableBackends![0].available = false;

    const merged = mergeCliStatusPreservingHydratedProviders(current, incoming);

    expect(merged).not.toBe(current);
    expect(merged.providers[1]).not.toBe(current.providers[1]);
    expect(merged.providers[1].availableBackends?.[0].available).toBe(false);
  });
});
