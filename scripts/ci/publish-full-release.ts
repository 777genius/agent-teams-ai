import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { downloadPreparedStageArtifact } from '../e2e/release-updater/prepared-stage-download.mts';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { loadPlan } from './release/assembly.js';
import { canonical, requireThat } from './release/contract.js';
import { GitHubReleasePort } from './release/github.js';
import type { NativeReadinessReceipt } from './release/nativeReadiness.js';
import { GitHubNativeReadinessPort } from './release/nativeReadinessGithub.js';
import { publishFullRelease, verifyFullReadiness } from './release/publication.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      'plan-digest': { type: 'string' },
      'native-receipt': { type: 'string' },
      output: { type: 'string' },
      publish: { type: 'boolean', default: false },
    },
  });
  requireThat(values['plan-digest'] && values.output, '--plan-digest and --output are required');
  const directory = await mkdtemp(path.join(tmpdir(), 'TEST-full-publication-'));
  try {
    const planFile =
      values.plan ??
      (
        await downloadPreparedStageArtifact(directory, {
          runId: Number(process.env.PREPARED_RUN_ID),
          attempt: Number(process.env.PREPARED_RUN_ATTEMPT),
          artifactId: Number(process.env.PREPARED_ARTIFACT_ID),
          artifactSha256: process.env.PREPARED_ARTIFACT_SHA256 ?? '',
          toolingSha: process.env.GITHUB_SHA ?? '',
          planDigest: values['plan-digest'],
        })
      ).planFile;
    const plan = await loadPlan(planFile, values['plan-digest']);
    requireThat(
      process.env.RELEASE_TAG === plan.input.target.tag,
      'Publication dispatch target mismatch'
    );
    requireThat(
      process.env.GITHUB_SHA === plan.input.toolingSha &&
        execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
          encoding: 'utf8',
          timeout: 30_000,
        }).trim() === plan.input.toolingSha,
      'Publication workflow must execute at immutable reviewed tooling SHA'
    );
    const bytes = values['native-receipt']
      ? await readFile(values['native-receipt'], 'utf8')
      : process.env.NATIVE_RECEIPT_JSON;
    requireThat(
      bytes && Buffer.byteLength(bytes) <= 100_000,
      'Bounded native receipt JSON required'
    );
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
