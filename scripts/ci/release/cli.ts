import { parseArgs } from 'node:util';

import { loadPlan, prepareDraft, stageDraft, verifyDraftBytes } from './assembly.js';
import { canonical, digest, requireThat } from './contract.js';
import { GitHubReleasePort } from './github.js';
import { verifyPublished } from './validation.js';

export async function runReleaseCommand(
  operation: 'prepare' | 'stage-draft' | 'verify',
  args = process.argv.slice(2)
): Promise<void> {
  const { values } = parseArgs({
    args,
    options: Object.fromEntries(
      [
        'repository',
        'release-tag',
        'application-sha',
        'tooling-sha',
        'mode',
        'mac-source-tag',
        'output',
        'build-run-id',
        'build-attempt',
        'build-job-ids',
        'plan',
        'plan-digest',
        'state',
        'release-id',
      ].map((name) => [name, { type: 'string' as const }])
    ),
  });
  const port = new GitHubReleasePort();
  const required = (name: string): string => {
    const value = values[name];
    requireThat(typeof value === 'string' && value.length > 0, `--${name} required`);
    return value;
  };
  if (operation === 'prepare') {
    const mode = values.mode ?? 'full';
    requireThat(mode === 'full' || mode === 'carry-mac', '--mode must be full or carry-mac');
    const toolingSha = required('tooling-sha');
    if (process.env.GITHUB_SHA)
      requireThat(
        process.env.GITHUB_SHA === toolingSha,
        'Workflow SHA differs from reviewed tooling SHA'
      );
    const result = await prepareDraft(port, {
      repository: required('repository'),
      tag: required('release-tag'),
      applicationSha: required('application-sha'),
      toolingSha,
      mode,
      macSourceTag: values['mac-source-tag'],
      output: required('output'),
      build: {
        runId: Number(required('build-run-id')),
        attempt: Number(required('build-attempt')),
        jobIds: required('build-job-ids').split(',').map(Number),
      },
    });
    process.stdout.write(
      `${JSON.stringify({ phase: 'prepared', planDigest: result.planDigest, inputDigest: digest(canonical(result.plan.input)) })}\n`
    );
    return;
  }
  if (operation === 'verify' && values.state === 'published') {
    const result = await verifyPublished(
      port,
      required('repository'),
      required('release-tag'),
      values['release-id'] ? Number(values['release-id']) : undefined
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  requireThat(
    operation === 'stage-draft' || values.state === 'draft',
    '--state must be draft or published'
  );
  const plan = await loadPlan(required('plan'), required('plan-digest'));
  if (operation === 'stage-draft')
    process.stdout.write(`${JSON.stringify(await stageDraft(port, plan))}\n`);
  else {
    await verifyDraftBytes(port, plan);
    process.stdout.write('{"phase":"assembled","verified":true}\n');
  }
}

export function releaseMain(operation: 'prepare' | 'stage-draft' | 'verify'): void {
  runReleaseCommand(operation).catch((error: unknown) => {
    const details = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${details}\n`);
    process.exitCode = /HTTP 5\d\d|ECONN|ETIMEDOUT|fetch failed|timed out/i.test(details) ? 75 : 1;
  });
}
