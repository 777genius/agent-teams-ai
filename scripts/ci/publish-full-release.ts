import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { downloadPreparedStageArtifact } from '../e2e/release-updater/prepared-stage-download.mts';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { loadPlan } from './release/assembly.js';
import { canonical, digest, requireThat } from './release/contract.js';
import { GitHubReleasePort } from './release/github.js';
import { release220Execution } from './release/nativeReadinessAuthority.js';
import type { NativeReadinessReceipt } from './release/nativeReadiness.js';
import { GitHubNativeReadinessPort } from './release/nativeReadinessGithub.js';
import { publishFullRelease, verifyFullReadiness } from './release/publication.js';
import { RELEASE220_EXECUTION } from './release/release220ExecutionPins.js';
import {
  authenticateRelease220Publisher,
  GitHubPublisherAuthorityPort,
  RELEASE220_PUBLISHER,
} from './release/release220PublisherAuthority.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      'plan-digest': { type: 'string' },
      'native-receipt': { type: 'string' },
      'execution-identity': { type: 'string' },
      output: { type: 'string' },
      publish: { type: 'boolean', default: false },
    },
  });
  requireThat(values['plan-digest'] && values.output, '--plan-digest and --output are required');
  const directory = await mkdtemp(path.join(tmpdir(), 'TEST-full-publication-'));
  try {
    const checkoutSha = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 30_000,
    }).trim();
    const bytes = values['native-receipt']
      ? await readFile(values['native-receipt'], 'utf8')
      : process.env.NATIVE_RECEIPT_JSON;
    requireThat(
      bytes && Buffer.byteLength(bytes) <= 100_000,
      'Bounded native receipt JSON required'
    );
    const bridge = values['execution-identity'] !== undefined;
    if (bridge) {
      const identityBytes = await readFile(values['execution-identity']!, 'utf8');
      requireThat(
        Buffer.byteLength(identityBytes) <= 10_000,
        'Bounded publisher identity required'
      );
      await authenticateRelease220Publisher(
        new GitHubPublisherAuthorityPort(),
        JSON.parse(identityBytes),
        {
          checkoutSha,
          workflowSha: process.env.GITHUB_SHA ?? '',
          repository: process.env.GITHUB_REPOSITORY ?? '',
          runId: Number(process.env.GITHUB_RUN_ID),
          runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
          planSha256: values['plan-digest'],
          nativeReceiptBytes: bytes,
          publish: values.publish,
          planFile: values.plan,
        }
      );
    }
    const planFile =
      values.plan ??
      (
        await downloadPreparedStageArtifact(directory, {
          runId: bridge ? RELEASE220_PUBLISHER.preparedRunId : Number(process.env.PREPARED_RUN_ID),
          attempt: bridge ? 1 : Number(process.env.PREPARED_RUN_ATTEMPT),
          artifactId: bridge
            ? RELEASE220_PUBLISHER.preparedArtifactId
            : Number(process.env.PREPARED_ARTIFACT_ID),
          artifactSha256: bridge
            ? RELEASE220_PUBLISHER.preparedArtifactSha256
            : (process.env.PREPARED_ARTIFACT_SHA256 ?? ''),
          toolingSha: bridge ? RELEASE220_EXECUTION.base : (process.env.GITHUB_SHA ?? ''),
          planDigest: values['plan-digest'],
        })
      ).planFile;
    const plan = await loadPlan(planFile, values['plan-digest']);
    requireThat(
      process.env.RELEASE_TAG === plan.input.target.tag,
      'Publication dispatch target mismatch'
    );
    if (bridge) {
      release220Execution('package', plan, values['plan-digest'], digest(canonical(plan.input)));
    } else {
      requireThat(
        process.env.GITHUB_SHA === plan.input.toolingSha && checkoutSha === plan.input.toolingSha,
        'Publication workflow must execute at immutable reviewed tooling SHA'
      );
    }
    const receipt = JSON.parse(bytes) as NativeReadinessReceipt;
    const port = new GitHubReleasePort();
    const nativePort = new GitHubNativeReadinessPort();
    const result = values.publish
      ? await publishFullRelease(port, nativePort, plan, values['plan-digest'], receipt)
      : await verifyFullReadiness(port, nativePort, plan, values['plan-digest'], receipt);
    await writeFile(values.output, `${canonical(result)}\n`, { flag: 'wx' });
    process.stdout.write(`${canonical(result)}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
