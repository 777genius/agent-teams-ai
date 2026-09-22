type BuildEnvironment = Readonly<Record<string, string | undefined>>;

function firstNonEmptyEnv(...values: Array<string | undefined>): string {
  return values.map((value) => value?.trim() ?? '').find(Boolean) ?? '';
}

export function isOfficialPostHogReleaseBuild(env: BuildEnvironment): boolean {
  return (
    String(env.IS_RELEASE_BUILD ?? '').toLowerCase() === 'true' ||
    Boolean(firstNonEmptyEnv(env.RELEASE_TAG)) ||
    env.GITHUB_EVENT_NAME === 'workflow_dispatch'
  );
}

export function resolvePostHogBuildKey(env: BuildEnvironment, localEnv: BuildEnvironment): string {
  if (!isOfficialPostHogReleaseBuild(env)) {
    return '';
  }

  return firstNonEmptyEnv(
    env.POSTHOG_KEY,
    localEnv.POSTHOG_KEY,
    env.VITE_POSTHOG_KEY,
    localEnv.VITE_POSTHOG_KEY
  );
}
