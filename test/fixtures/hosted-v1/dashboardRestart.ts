import { execFile } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';

import { advanceHostedV1MountGeneration, assertHostedV1MarkerOwnedRoot } from './createSandbox';

const execFileAsync = promisify(execFile);
const sourceHeadLabel = 'org.agent-teams.hosted-e2e.source-head-commit';
const sourcePatchLabel = 'org.agent-teams.hosted-e2e.source-patch-sha256';

interface DashboardRestartInput {
  readonly active: boolean;
  readonly composeFile: string;
  readonly composeProject: string;
  readonly image: string;
  readonly marker: string;
  readonly sandboxRoot: string;
  readonly sourceHeadCommit: string;
  readonly sourcePatchSha256: string;
  readonly environment: NodeJS.ProcessEnv;
}

async function assertDashboardRestartContext(input: DashboardRestartInput): Promise<string> {
  await assertHostedV1MarkerOwnedRoot(
    input.sandboxRoot,
    resolve(input.sandboxRoot, '.agent-teams-hosted-v1-e2e-owner.json'),
    input.marker
  );
  if (
    basename(input.composeFile) !== 'docker-compose.e2e.yml' ||
    resolve(input.composeFile) !== input.composeFile ||
    input.composeProject !== `at-hosted-v1-${input.marker.slice(0, 24)}` ||
    !/^at-hosted-v1-[0-9a-f]{24}-app:latest$/u.test(input.image) ||
    input.image !== input.environment.E2E_APP_IMAGE ||
    !/^[0-9a-f]{40}$/u.test(input.sourceHeadCommit) ||
    !/^[0-9a-f]{64}$/u.test(input.sourcePatchSha256)
  ) {
    throw new Error('hosted_dashboard_restart_context_invalid');
  }
  const { stdout } = await execFileAsync(
    'docker',
    [
      'image',
      'inspect',
      input.image,
      '--format',
      `{{.Id}} {{index .Config.Labels "${sourceHeadLabel}"}} {{index .Config.Labels "${sourcePatchLabel}"}}`,
    ],
    { env: input.environment, timeout: 10_000, maxBuffer: 1024 }
  );
  const match = /^(sha256:[0-9a-f]{64}) ([0-9a-f]{40}) ([0-9a-f]{64})$/u.exec(stdout.trim());
  if (!match || match[2] !== input.sourceHeadCommit || match[3] !== input.sourcePatchSha256) {
    throw new Error('hosted_dashboard_restart_image_source_mismatch');
  }
  return match[1];
}

async function assertDashboardControllerImage(
  input: DashboardRestartInput,
  imageId: string,
  environment: NodeJS.ProcessEnv
): Promise<void> {
  const { stdout: containerId } = await execFileAsync(
    'docker',
    [
      'compose',
      '--project-name',
      input.composeProject,
      '--file',
      input.composeFile,
      'ps',
      '--quiet',
      'hosted-controller',
    ],
    { env: environment, timeout: 10_000, maxBuffer: 1024 }
  );
  if (!/^[0-9a-f]{64}\s*$/u.test(containerId)) {
    throw new Error('hosted_dashboard_restart_controller_missing');
  }
  const { stdout: containerImageId } = await execFileAsync(
    'docker',
    ['inspect', containerId.trim(), '--format', '{{.Image}}'],
    { env: environment, timeout: 10_000, maxBuffer: 1024 }
  );
  if (containerImageId.trim() !== imageId) {
    throw new Error('hosted_dashboard_restart_container_image_mismatch');
  }
}

/** Recreates only the Product while the test keeps the original fake-runtime boot. */
export async function restartHostedDashboardController(
  input: DashboardRestartInput
): Promise<void> {
  const imageId = await assertDashboardRestartContext(input);
  await execFileAsync(
    'docker',
    [
      'compose',
      '--project-name',
      input.composeProject,
      '--file',
      input.composeFile,
      'up',
      '--detach',
      '--force-recreate',
      '--no-deps',
      '--wait',
      'hosted-controller',
    ],
    {
      env: { ...input.environment, E2E_DASHBOARD_MULTI_ROOT_ACTIVE: String(input.active) },
      timeout: 120_000,
      maxBuffer: 32 * 1024,
    }
  );
  if ((await assertDashboardRestartContext(input)) !== imageId) {
    throw new Error('hosted_dashboard_restart_image_changed');
  }
  await assertDashboardControllerImage(input, imageId, input.environment);
}

/** Recreates the entire marker-owned stack with a fresh boot ID and mount epoch. */
export async function rebootHostedDashboardStack(
  input: DashboardRestartInput
): Promise<Readonly<{ bootId: string; environment: NodeJS.ProcessEnv; mountGeneration: number }>> {
  const imageId = await assertDashboardRestartContext(input);
  const bootstrap = input.environment.E2E_LIFECYCLE_BOOTSTRAP;
  if (!bootstrap || !input.environment.E2E_BOOT_ID) {
    throw new Error('hosted_dashboard_restart_bootstrap_missing');
  }
  let bootId: unknown;
  try {
    bootId = (JSON.parse(bootstrap) as { bootId?: unknown }).bootId;
  } catch {
    throw new Error('hosted_dashboard_restart_bootstrap_invalid');
  }
  if (bootId !== input.environment.E2E_BOOT_ID) {
    throw new Error('hosted_dashboard_restart_bootstrap_invalid');
  }
  const composeArgs = [
    'compose',
    '--project-name',
    input.composeProject,
    '--file',
    input.composeFile,
  ];
  await execFileAsync('docker', [...composeArgs, 'down', '--timeout', '45', '--remove-orphans'], {
    env: input.environment,
    timeout: 120_000,
    maxBuffer: 32 * 1024,
  });
  const next = await advanceHostedV1MountGeneration({
    bootstrap,
    distinctBoot: true,
    fakeRuntimeStateDir: resolve(input.sandboxRoot, 'fake-runtime'),
    markerPath: resolve(input.sandboxRoot, '.agent-teams-hosted-v1-e2e-owner.json'),
    root: input.sandboxRoot,
  });
  const environment: NodeJS.ProcessEnv = {
    ...input.environment,
    E2E_BOOT_ID: next.bootId,
    E2E_LIFECYCLE_BOOTSTRAP: next.bootstrap,
    E2E_DASHBOARD_MULTI_ROOT_ACTIVE: String(input.active),
  };
  await execFileAsync('docker', [...composeArgs, 'up', '--detach', '--wait', '--no-build'], {
    env: environment,
    timeout: 180_000,
    maxBuffer: 32 * 1024,
  });
  if ((await assertDashboardRestartContext(input)) !== imageId) {
    throw new Error('hosted_dashboard_restart_image_changed');
  }
  await assertDashboardControllerImage(input, imageId, environment);
  return Object.freeze({ bootId: next.bootId, environment, mountGeneration: next.mountGeneration });
}
