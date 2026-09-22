export type SentryBuildEnvironment = 'production' | 'development';

function firstNonEmptyEnv(
  env: Readonly<Record<string, string | undefined>>,
  ...names: string[]
): string {
  return names.map((name) => env[name]?.trim() ?? '').find(Boolean) ?? '';
}

/**
 * Resolve the Sentry environment at build time.
 *
 * Packaged Electron apps do not reliably preserve NODE_ENV at runtime, so
 * official release metadata is the canonical production signal.
 */
export function resolveSentryBuildEnvironment(
  env: Readonly<Record<string, string | undefined>>
): SentryBuildEnvironment {
  const releaseTag = firstNonEmptyEnv(env, 'RELEASE_TAG');
  const githubRef = firstNonEmptyEnv(env, 'GITHUB_REF');
  const isOfficialRelease =
    env.IS_RELEASE_BUILD?.trim().toLowerCase() === 'true' ||
    /^v[0-9]/.test(releaseTag) ||
    /^refs\/tags\/v[0-9]/.test(githubRef);

  return isOfficialRelease || env.NODE_ENV === 'production' ? 'production' : 'development';
}
