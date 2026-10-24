// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { resolveSentryBuildIdentity } from '../../scripts/build/sentryBuildIdentity.js';
import { parseSentryArtifactInventory } from '../../src/shared/utils/sentryArtifactInventory.js';

const SHA = '6e0036ec004c85c49c6da6d9ca0b80d8793bac63';
const OTHER_SHA = '1234567890abcdef1234567890abcdef12345678';

function acceptedUncoveredIdentity(identity: { gitSha: string; buildId: string }) {
  const expected = { release: 'agent-teams-ai@2.17.1', ...identity };
  return parseSentryArtifactInventory(JSON.stringify({
    schemaVersion: 1,
    ...expected,
    artifacts: [],
    coverage: { main: 'uncovered', renderer: 'uncovered', preload: 'uncovered' },
  }), expected);
}

describe('build identity before inventory plugin registration', () => {
  it('canonicalizes a valid uppercase SHA and preserves valid environment precedence', () => {
    const readGitSha = vi.fn(() => OTHER_SHA);
    const identity = resolveSentryBuildIdentity({
      env: { GIT_SHA: ` ${SHA.toUpperCase()} `, BUILD_ID: ' official-build.1 ' },
      localEnv: { GIT_SHA: OTHER_SHA, BUILD_ID: 'local-build' },
      readGitSha,
      covered: true,
    });
    expect(identity).toEqual({ gitSha: SHA, buildId: 'official-build.1' });
    expect(readGitSha).not.toHaveBeenCalled();
    expect(acceptedUncoveredIdentity(identity)).not.toBeNull();
  });

  it('skips malformed candidates in favor of the next valid configured values', () => {
    const identity = resolveSentryBuildIdentity({
      env: { GIT_SHA: 'not-a-sha', BUILD_ID: 'private/path', VITE_BUILD_ID: 'next-build' },
      localEnv: { GIT_SHA: ` ${OTHER_SHA.toUpperCase()} `, BUILD_ID: 'also invalid' },
      readGitSha: () => SHA,
      covered: false,
    });
    expect(identity).toEqual({ gitSha: OTHER_SHA, buildId: 'next-build' });
    expect(acceptedUncoveredIdentity(identity)).not.toBeNull();
  });

  it('uses actual Git fallback and its short SHA when optional identity env is malformed', () => {
    const identity = resolveSentryBuildIdentity({
      env: { GIT_SHA: 'short-sha', GITHUB_SHA: '../private', BUILD_ID: 'release/private' },
      localEnv: { COMMIT_SHA: 'not-hex', VITE_BUILD_ID: 'x'.repeat(161) },
      readGitSha: () => `${SHA.toUpperCase()}\n`,
      covered: true,
    });
    expect(identity).toEqual({ gitSha: SHA, buildId: '6e0036ec004c' });
    expect(acceptedUncoveredIdentity(identity)).not.toBeNull();
  });

  it.each(['missing', 'invalid'] as const)('keeps no-auth builds admissible when Git is %s', (git) => {
    const identity = resolveSentryBuildIdentity({
      env: { GIT_SHA: 'malformed', BUILD_ID: 'private/path' },
      localEnv: {},
      readGitSha: () => {
        if (git === 'missing') throw new Error('Git unavailable');
        return 'invalid-git-output';
      },
      covered: false,
    });
    expect(identity).toEqual({ gitSha: '', buildId: '' });
    expect(acceptedUncoveredIdentity(identity)).not.toBeNull();
  });

  it('retains a valid build ID without Git for an uncovered build only', () => {
    const options = {
      env: { GIT_SHA: 'invalid', BUILD_ID: 'valid-build' },
      localEnv: {},
      readGitSha: () => '',
    };
    const identity = resolveSentryBuildIdentity({ ...options, covered: false });
    expect(identity).toEqual({ gitSha: '', buildId: 'valid-build' });
    expect(acceptedUncoveredIdentity(identity)).not.toBeNull();
    expect(() => resolveSentryBuildIdentity({ ...options, covered: true })).toThrow(
      'Sentry upload requires a valid 40-character Git SHA and build ID'
    );
  });

  it('rejects incomplete covered identity synchronously without exposing malformed values', () => {
    expect(() => resolveSentryBuildIdentity({
      env: { GIT_SHA: '/private/git-secret', BUILD_ID: '/private/build-secret' },
      localEnv: {},
      readGitSha: () => { throw new Error('private-git-error'); },
      covered: true,
    })).toThrow(new Error('Sentry upload requires a valid 40-character Git SHA and build ID'));
  });
});
