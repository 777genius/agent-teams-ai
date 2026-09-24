import { resolve } from 'node:path';

// eslint-disable-next-line no-restricted-imports -- Standalone composes the hosted Node adapter before storage startup.
import { createNodeHostedStateCompatibilityAdmission } from '@features/hosted-state-compatibility/main/hosted';

/** Runs before the hosted storage worker, auth secret preparation or either listener exists. */
export async function admitStandaloneHostedState(
  environment: Readonly<Record<string, string | undefined>>,
  builtServerDirectory: string,
  stateDirectory: string,
  prepareCanonicalFirstBoot = false
): Promise<{
  readonly pendingCanonicalFirstBoot: boolean;
  completeCanonicalFirstBoot(): Promise<void>;
}> {
  const deploymentId = environment.AUTH_DEPLOYMENT_ID;
  if (!deploymentId || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(deploymentId)) {
    throw new Error('hosted_state_deployment_id_invalid');
  }
  const generationText = environment.AUTH_RESTORE_GENERATION;
  const expectedRestoreGeneration = Number(generationText);
  if (
    generationText === undefined ||
    !/^(0|[1-9][0-9]*)$/.test(generationText) ||
    !Number.isSafeInteger(expectedRestoreGeneration)
  ) {
    throw new Error('hosted_state_restore_generation_invalid');
  }
  const admission = createNodeHostedStateCompatibilityAdmission({
    artifactDirectory: resolve(builtServerDirectory, 'state-compatibility'),
    stateDirectory,
    expectedDeploymentId: deploymentId,
    expectedRestoreGeneration,
    prepareCanonicalFirstBoot,
  });
  await admission.admitBeforeListenerExposure();
  const pendingCanonicalFirstBoot = await admission.hasPendingCanonicalFirstBoot();
  if (pendingCanonicalFirstBoot && !prepareCanonicalFirstBoot) {
    throw new Error('hosted_canonical_first_boot_owner_required');
  }
  return Object.freeze({
    pendingCanonicalFirstBoot,
    completeCanonicalFirstBoot: () => admission.completeCanonicalFirstBoot(),
  });
}
