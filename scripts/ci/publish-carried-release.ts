import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { loadPlan } from './release/assembly.js';
import { canonical, requireThat } from './release/contract.js';
import { GitHubReleasePort } from './release/github.js';
import type { NativeReadinessReceipt } from './release/nativeReadiness.js';
import { GitHubNativeReadinessPort } from './release/nativeReadinessGithub.js';
import { checkPublisherExecution } from './release/publisherExecution.js';
import { publishCarriedRelease, verifyCarryReadiness } from './release/publication.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      plan: { type: 'string' },
      'plan-digest': { type: 'string' },
      'execution-sha': { type: 'string' },
      'native-receipt': { type: 'string' },
      output: { type: 'string' },
      publish: { type: 'boolean', default: false },
    },
  });
  requireThat(
    values.plan && values['plan-digest'] && values.output,
    '--plan, --plan-digest and --output are required'
  );
  const plan = await loadPlan(values.plan, values['plan-digest']);
  checkPublisherExecution(
    plan.input.toolingSha,
    values['execution-sha'] ?? plan.input.toolingSha,
    process.env.GITHUB_SHA,
    execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 30_000,
    }).trim(),
    values['plan-digest']
  );
  const bytes = values['native-receipt']
    ? await readFile(values['native-receipt'], 'utf8')
    : process.env.NATIVE_RECEIPT_JSON;
  requireThat(bytes && Buffer.byteLength(bytes) <= 100_000, 'Bounded native receipt JSON required');
  const receipt = JSON.parse(bytes) as NativeReadinessReceipt;
  const port = new GitHubReleasePort();
  const nativePort = new GitHubNativeReadinessPort();
  const result = values.publish
    ? await publishCarriedRelease(port, nativePort, plan, values['plan-digest'], receipt)
    : await verifyCarryReadiness(port, nativePort, plan, values['plan-digest'], receipt);
  Object.assign(result, { executionSha: values['execution-sha'] ?? plan.input.toolingSha });
  await writeFile(values.output, `${canonical(result)}\n`, { flag: 'wx' });
  process.stdout.write(`${canonical(result)}\n`);
}
void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
