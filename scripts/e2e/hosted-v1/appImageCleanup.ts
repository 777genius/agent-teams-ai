export interface HostedV1SharedAppImageLifecycleInput {
  readonly appImage: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly removeImage: (appImage: string, environment: NodeJS.ProcessEnv) => Promise<void>;
}

/** Probes, removes, and re-probes only the run's unique image tag. */
export async function removeHostedV1AppImage(
  appImage: string,
  environment: NodeJS.ProcessEnv,
  runDocker: (args: readonly string[], environment: NodeJS.ProcessEnv) => Promise<string>
): Promise<void> {
  const inspect = () =>
    runDocker(
      ['image', 'ls', '--quiet', '--no-trunc', '--filter', `reference=${appImage}`],
      environment
    );
  const observedIds = await inspect();
  if (observedIds === '') return;
  const imageIds = observedIds.split(/\r?\n/u);
  if (imageIds.length !== 1 || !/^sha256:[0-9a-f]{64}$/u.test(imageIds[0] ?? '')) {
    throw new Error('hosted_e2e_app_image_cleanup_probe_invalid');
  }
  await runDocker(['image', 'rm', '--force', appImage], environment);
  if ((await inspect()) !== '') throw new Error('hosted_e2e_app_image_cleanup_incomplete');
}

/**
 * Marks cleanup eligibility before the Docker build client starts. A terminated build can publish
 * its tag before the client reports success, so waiting for a successful return would leak it.
 */
export function createHostedV1SharedAppImageLifecycle(
  input: HostedV1SharedAppImageLifecycleInput
): {
  readonly markBuildAttempted: () => void;
  readonly cleanup: (runnerError: unknown) => Promise<{ readonly runnerError: unknown }>;
} {
  let buildAttempted = false;
  return {
    markBuildAttempted: () => {
      buildAttempted = true;
    },
    cleanup: async (runnerError) => {
      if (!buildAttempted) return { runnerError };
      try {
        await input.removeImage(input.appImage, input.environment);
        return { runnerError };
      } catch (cleanupError) {
        return {
          runnerError: new AggregateError(
            [runnerError, cleanupError].filter((value) => value !== null),
            'hosted_e2e_image_cleanup_failed'
          ),
        };
      }
    },
  };
}
