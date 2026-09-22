import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  initializeMainSentry: vi.fn(),
}));

vi.mock('@main/sentry', () => mocks);

describe('main Sentry bootstrap', () => {
  it('initializes Sentry when the early main bootstrap is evaluated', async () => {
    await import('@main/sentryBootstrap');

    expect(mocks.initializeMainSentry).toHaveBeenCalledOnce();
  });
});
