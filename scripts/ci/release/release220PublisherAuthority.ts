import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { canonical, digest, requireThat } from './contract.js';
import { RELEASE220_EXECUTION as pins } from './release220ExecutionPins.js';

export const RELEASE220_PUBLISHER = {
  workflow: '.github/workflows/publish-carried-release.yml',
  tag: 'release-tooling-v2.17.10-qualified-publication',
  normalizedWorkflowSha256: '3fcd6f5917d6a14a287a42d5a5386b5e159797f039b40b04c220192938e1efa8',
  preparedRunId: 37831798849,
  preparedArtifactId: 11573044289,
  preparedArtifactSha256: '3cfb885531d263866c3a40653b7a6995d9f324144c75ab6e0d6777e1e37d3bc7',
} as const;

export interface PublisherRun {
  id: number;
  run_attempt: number;
  head_sha: string;
  head_branch: string;
  path: string;
  event: string;
  status: string;
  conclusion: string | null;
  repository: { full_name: string };
  head_repository: { full_name: string };
  actor: { login: string };
  triggering_actor: { login: string };
}
export interface PublisherAuthorityPort {
  run(runId: number): Promise<PublisherRun>;
  workflow(sha: string): Promise<string>;
}
export interface PublisherContext {
  checkoutSha: string;
  workflowSha: string;
  repository: string;
  runId: number;
  runAttempt: number;
  planSha256: string;
  nativeReceiptBytes: string;
  publish: boolean;
  planFile?: string;
}

/** The publisher pins G; only those two literals normalize, avoiding a hash cycle. */
export function verifyPublisherWorkflow(source: string, checkoutSha: string): void {
  requireThat(/^[a-f0-9]{40}$/.test(checkoutSha), 'Invalid publisher checkout SHA');
  requireThat(
    source.split(checkoutSha).length === 3 &&
      source.includes(`      CHECKOUT_SHA: ${checkoutSha}\n`) &&
      source.includes(`          ref: ${checkoutSha}\n`) &&
      digest(source.replaceAll(checkoutSha, 'INVALID_G')) ===
        RELEASE220_PUBLISHER.normalizedWorkflowSha256,
    'Publisher workflow differs from reviewed immutable publication template/checkout'
  );
}

export async function authenticateRelease220Publisher(
  port: PublisherAuthorityPort,
  identity: unknown,
  context: PublisherContext
): Promise<void> {
  requireThat(
    typeof context.publish === 'boolean' &&
      context.planFile === undefined &&
      context.planSha256 === pins.plan &&
      context.repository === pins.repository &&
      /^[a-f0-9]{40}$/.test(context.workflowSha) &&
      context.checkoutSha !== pins.base &&
      Number.isSafeInteger(context.runId) &&
      context.runId > 0 &&
      Number.isSafeInteger(context.runAttempt) &&
      context.runAttempt > 0,
    'Closed full220 publisher bridge requires original prepared P10'
  );
  const run = await port.run(context.runId);
  requireThat(
    run.id === context.runId &&
      run.run_attempt === context.runAttempt &&
      run.head_sha === context.workflowSha &&
      run.head_branch === RELEASE220_PUBLISHER.tag &&
      run.repository.full_name === pins.repository &&
      run.head_repository.full_name === pins.repository &&
      run.actor.login === '777genius' &&
      run.triggering_actor.login === '777genius' &&
      run.path === RELEASE220_PUBLISHER.workflow &&
      run.event === 'workflow_dispatch' &&
      run.status === 'in_progress' &&
      run.conclusion === null,
    'Publisher origin/current run attempt is not the reviewed publication dispatch'
  );
  requireThat(
    canonical(identity) ===
      canonical({
        schemaVersion: 1,
        workflowSha: run.head_sha,
        checkoutSha: context.checkoutSha,
        applicationSha: pins.application,
        workflowRef: `${pins.repository}/${RELEASE220_PUBLISHER.workflow}@refs/tags/${RELEASE220_PUBLISHER.tag}`,
        repository: pins.repository,
        tag: 'v2.17.10',
        planSha256: pins.plan,
        nativeReceiptSha256: digest(context.nativeReceiptBytes),
        preparedRunId: RELEASE220_PUBLISHER.preparedRunId,
        preparedRunAttempt: 1,
        preparedArtifactId: RELEASE220_PUBLISHER.preparedArtifactId,
        preparedArtifactSha256: RELEASE220_PUBLISHER.preparedArtifactSha256,
        runId: run.id,
        runAttempt: run.run_attempt,
        publicationRequested: context.publish,
      }),
    'Publisher execution sidecar does not match actual origin/checkout/prepared source'
  );
  verifyPublisherWorkflow(await port.workflow(run.head_sha), context.checkoutSha);
}

const execute = promisify(execFile);
async function api<T>(endpoint: string): Promise<T> {
  const result = await execute('gh', ['api', `repos/${pins.repository}/${endpoint}`], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(result.stdout) as T;
}
/** Read-only provenance; gh owns all credentials. */
export class GitHubPublisherAuthorityPort implements PublisherAuthorityPort {
  run(runId: number): Promise<PublisherRun> {
    return api(`actions/runs/${runId}`);
  }
  async workflow(sha: string): Promise<string> {
    const content = await api<{ encoding: string; content: string }>(
      `contents/${RELEASE220_PUBLISHER.workflow}?ref=${sha}`
    );
    requireThat(
      content.encoding === 'base64' && typeof content.content === 'string',
      'Missing U11 workflow source'
    );
    return Buffer.from(content.content, 'base64').toString('utf8');
  }
}
