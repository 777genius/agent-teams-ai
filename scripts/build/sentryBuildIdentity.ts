import type { SentryBuildIdentity } from '../../src/shared/utils/sentryArtifactInventory.js';

type BuildEnvironment = Readonly<Record<string, string | undefined>>;
type BuildIdentityOptions = Readonly<{
  env: BuildEnvironment;
  localEnv: BuildEnvironment;
  readGitSha: () => string;
  covered: boolean;
}>;

function canonicalGitSha(value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
  return /^[0-9a-f]{40}$/i.test(trimmed) ? trimmed.toLowerCase() : '';
}

function validBuildId(value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
  return /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,159}$/.test(trimmed) ? trimmed : '';
}

/** Resolve before plugin registration so malformed optional env never reaches inventory admission. */
export function resolveSentryBuildIdentity({
  env,
  localEnv,
  readGitSha,
  covered,
}: BuildIdentityOptions): Readonly<Pick<SentryBuildIdentity, 'gitSha' | 'buildId'>> {
  let gitSha = ['GIT_SHA', 'GITHUB_SHA', 'VERCEL_GIT_COMMIT_SHA', 'COMMIT_SHA']
    .flatMap((name) => [env[name], localEnv[name]])
    .map(canonicalGitSha)
    .find(Boolean) ?? '';

  if (!gitSha) {
    try {
      gitSha = canonicalGitSha(readGitSha());
    } catch {
      // Self-builds without Git can remain uncovered with empty identity.
    }
  }

  const buildId = ['BUILD_ID', 'VITE_BUILD_ID']
    .flatMap((name) => [env[name], localEnv[name]])
    .map(validBuildId)
    .find(Boolean) ?? gitSha.slice(0, 12);

  if (covered && (!gitSha || !buildId)) {
    throw new Error('Sentry upload requires a valid 40-character Git SHA and build ID');
  }

  return Object.freeze({ gitSha, buildId });
}
