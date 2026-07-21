import { describe, expect, it } from 'vitest';

import { resolveSentryBuildEnvironment } from '../sentryBuildPolicy';

describe('resolveSentryBuildEnvironment', () => {
  it.each([
    [{ IS_RELEASE_BUILD: 'true' }, 'production'],
    [{ IS_RELEASE_BUILD: ' TRUE ' }, 'production'],
    [{ RELEASE_TAG: 'v2.10.0' }, 'production'],
    [{ GITHUB_REF: 'refs/tags/v2.10.0' }, 'production'],
    [{ NODE_ENV: 'production' }, 'production'],
    [{ NODE_ENV: 'development' }, 'development'],
    [{}, 'development'],
  ] as const)('resolves %j as %s', (env, expected) => {
    expect(resolveSentryBuildEnvironment(env)).toBe(expected);
  });

  it('does not treat unrelated tags or false release flags as production', () => {
    expect(
      resolveSentryBuildEnvironment({
        IS_RELEASE_BUILD: 'false',
        RELEASE_TAG: 'nightly',
        GITHUB_REF: 'refs/heads/dev',
      })
    ).toBe('development');
  });
});
