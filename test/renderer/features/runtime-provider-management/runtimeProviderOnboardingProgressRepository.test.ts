import { describe, expect, it, vi } from 'vitest';

import { createRuntimeProviderOnboardingProgress } from '../../../../src/features/runtime-provider-management/core/domain/runtimeProviderOnboarding';
import { BrowserRuntimeProviderOnboardingProgressRepository } from '../../../../src/features/runtime-provider-management/renderer/adapters/runtimeProviderOnboardingProgressRepository';

describe('BrowserRuntimeProviderOnboardingProgressRepository', () => {
  it('persists only the normalized non-secret onboarding snapshot', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    };
    const repository = new BrowserRuntimeProviderOnboardingProgressRepository(storage);
    const progress = createRuntimeProviderOnboardingProgress(['supergrok']);

    repository.save(progress);

    expect(repository.load()).toEqual(progress);
    expect([...values.values()][0]).not.toContain('apiKey');
    expect([...values.values()][0]).not.toContain('oauthCode');
  });

  it('drops malformed saved progress and tolerates unavailable storage', () => {
    const storage = {
      getItem: vi.fn(() => '{broken'),
      setItem: vi.fn(() => {
        throw new Error('blocked');
      }),
      removeItem: vi.fn(),
    };
    const repository = new BrowserRuntimeProviderOnboardingProgressRepository(storage);

    expect(repository.load()).toBeNull();
    expect(() =>
      repository.save(createRuntimeProviderOnboardingProgress(['supergrok']))
    ).not.toThrow();
    expect(() => repository.clear()).not.toThrow();
  });
});
