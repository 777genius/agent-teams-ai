import {
  ensureMinimumNodeOldSpaceEnv,
  ensureMinimumNodeOldSpaceOptions,
} from '@main/utils/nodeOptions';
import { describe, expect, it } from 'vitest';

describe('nodeOptions', () => {
  it('raises a low equals-form max-old-space-size', () => {
    expect(ensureMinimumNodeOldSpaceOptions('--max-old-space-size=64 --trace-warnings')).toBe(
      '--max-old-space-size=2048 --trace-warnings'
    );
  });

  it('raises a low split-form max-old-space-size', () => {
    expect(ensureMinimumNodeOldSpaceOptions('--trace-warnings --max-old-space-size 128')).toBe(
      '--trace-warnings --max-old-space-size 2048'
    );
  });

  it('does not skip a later valid old-space flag after a malformed split flag', () => {
    expect(
      ensureMinimumNodeOldSpaceOptions('--max-old-space-size --max-old-space-size=128')
    ).toBe('--max-old-space-size --max-old-space-size=2048');
  });

  it('preserves an already sufficient max-old-space-size', () => {
    expect(ensureMinimumNodeOldSpaceOptions('--max-old-space-size=4096')).toBe(
      '--max-old-space-size=4096'
    );
  });

  it('does not add NODE_OPTIONS when it was unset', () => {
    const env: NodeJS.ProcessEnv = {};

    ensureMinimumNodeOldSpaceEnv(env);

    expect(env.NODE_OPTIONS).toBeUndefined();
  });
});
