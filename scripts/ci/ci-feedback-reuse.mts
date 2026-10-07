// Only authenticated GitHub metadata can qualify reuse. No artifacts or PR prose are inputs.
export const REPOSITORY = '777genius/agent-teams-ai';
export const WORKFLOW = '.github/workflows/ci.yml';
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
export type JsonObject = Record<string, unknown>;
export type GitHubRead = (endpoint: string) => Promise<unknown>;
export type ReuseResult = { reuse: boolean; sourceRun: string; reason: string };

export function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Missing object');
  return value as JsonObject;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Missing array');
  return value;
}

function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Missing positive integer');
  }
  return value;
}

export function sha(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) throw new Error('Invalid SHA');
  return value;
}

function requireProof(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

function fresh(value: unknown, now: number): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value))
    return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= MAX_AGE_MS;
}

function sameRepository(value: unknown, id: number): boolean {
  const repo = object(value);
  return repo.full_name === REPOSITORY && repo.id === id;
}

const ELIGIBLE = [
  ['test (1/2)', 'Test root shard'],
  ['test (2/2)', 'Test root shard'],
  ['lint (main)', 'Lint source shard'],
  ['lint (renderer)', 'Lint source shard'],
  ['lint (features)', 'Lint source shard'],
  ['Task change ledger Windows smoke', 'Test task change ledger'],
] as const;

export type ReuseContext = {
  repository: string;
  currentSha: string;
  linuxRunner: string;
  linuxArch: string;
  now: number;
};

export async function provePostmergeReuse(
  context: ReuseContext,
  read: GitHubRead
): Promise<ReuseResult> {
  try {
    requireProof(context.repository === REPOSITORY, 'Foreign repository');
    const currentSha = sha(context.currentSha);
    requireProof(Number.isFinite(context.now), 'Missing current time');
    requireProof(/^[A-Za-z0-9._-]+$/.test(context.linuxRunner), 'Invalid runner class');
    requireProof(['X64', 'ARM64'].includes(context.linuxArch), 'Unknown Linux architecture');
    const prefix = `repos/${REPOSITORY}`;
    const repo = object(await read(prefix));
    const repoId = positive(repo.id);
    requireProof(
      repo.full_name === REPOSITORY && repo.default_branch === 'main',
      'Repository identity mismatch'
    );
    const workflow = object(await read(`${prefix}/actions/workflows/ci.yml`));
    const workflowId = positive(workflow.id);
    requireProof(
      workflow.path === WORKFLOW && workflow.state === 'active',
      'Workflow identity mismatch'
    );
    const associated = array(await read(`${prefix}/commits/${currentSha}/pulls?per_page=100`));
    requireProof(associated.length < 100, 'Incomplete associated PR list');
    const merged = associated.map(object).filter((pr) => pr.merge_commit_sha === currentSha);
    requireProof(merged.length === 1, 'No unique merged source PR');
    const pr = object(await read(`${prefix}/pulls/${positive(merged[0].number)}`));
    const head = object(pr.head);
    const base = object(pr.base);
    requireProof(
      pr.merged === true && pr.state === 'closed' && pr.merge_commit_sha === currentSha,
      'PR is not merged at the current commit'
    );
    requireProof(fresh(pr.merged_at, context.now), 'Expired merge');
    requireProof(
      sameRepository(head.repo, repoId) && sameRepository(base.repo, repoId) && base.ref === 'main',
      'Foreign PR repository or base'
    );
    const headSha = sha(head.sha);
    const listing = object(
      await read(
        `${prefix}/actions/workflows/${workflowId}/runs?event=pull_request&head_sha=${headSha}&per_page=100`
      )
    );
    const runs = array(listing.workflow_runs).map(object);
    requireProof(
      typeof listing.total_count === 'number' &&
        listing.total_count === runs.length &&
        runs.length > 0,
      'Missing or incomplete source run list'
    );
    // Never fall back to an older passing run when the newest run failed or was cancelled.
    runs.sort((a, b) => positive(b.id) - positive(a.id));
    const runId = positive(runs[0].id);
    const run = object(await read(`${prefix}/actions/runs/${runId}`));
    const attempt = positive(run.run_attempt);
    requireProof(
      run.id === runId &&
        run.workflow_id === workflowId &&
        run.path === WORKFLOW &&
        run.event === 'pull_request' &&
        run.head_sha === headSha &&
        sameRepository(run.repository, repoId) &&
        sameRepository(run.head_repository, repoId),
      'Run identity mismatch'
    );
    requireProof(
      run.status === 'completed' && run.conclusion === 'success',
      'Latest source run did not pass'
    );
    requireProof(
      fresh(run.created_at, context.now) && fresh(run.updated_at, context.now),
      'Expired source run'
    );
    const response = object(
      await read(`${prefix}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`)
    );
    const jobs = array(response.jobs).map(object);
    requireProof(response.total_count === jobs.length && jobs.length < 100, 'Incomplete job list');
    // GitHub can drop run.pull_requests after merge. Preserve the trusted event's
    // immutable base/head in a workflow-defined step name, read through the jobs API.
    const planJobs = jobs.filter((job) => job.name === 'plan');
    requireProof(planJobs.length === 1, 'Missing source plan job');
    const sourceProofs = array(planJobs[0].steps)
      .map(object)
      .filter((step) => typeof step.name === 'string' && step.name.startsWith('CI source proof:'));
    requireProof(
      sourceProofs.length === 1 &&
        sourceProofs[0].status === 'completed' &&
        sourceProofs[0].conclusion === 'success',
      'Missing immutable source event proof'
    );
    const sourceProof =
      /^CI source proof: PR=([1-9]\d*) \| base=([a-f0-9]{40}) \| head=([a-f0-9]{40})$/.exec(
        String(sourceProofs[0].name)
      );
    requireProof(
      sourceProof && Number(sourceProof[1]) === pr.number && sourceProof[3] === headSha,
      'Immutable source event proof mismatch'
    );
    const testedBase = sha(sourceProof[2]);
    const links = array(run.pull_requests).map(object);
    requireProof(links.length <= 1, 'Ambiguous source PR linkage');
    if (links.length === 1) {
      const sourceHead = object(links[0].head);
      const sourceBase = object(links[0].base);
      requireProof(
        links[0].number === pr.number &&
          sourceHead.sha === headSha &&
          sourceBase.sha === testedBase &&
          object(sourceHead.repo).id === repoId &&
          object(sourceBase.repo).id === repoId,
        'Source PR linkage disagrees with immutable event'
      );
    }
    const comparison = object(await read(`${prefix}/compare/${testedBase}...${headSha}`));
    // The authenticated compare endpoint binds the requested head SHA; its response
    // has no head_commit field. Separate Git commit reads below bind both trees.
    requireProof(
      (comparison.status === 'ahead' || comparison.status === 'identical') &&
        object(comparison.base_commit).sha === testedBase &&
        object(comparison.merge_base_commit).sha === testedBase,
      'Tested base is not an ancestor of source head'
    );
    const currentCommit = object(await read(`${prefix}/git/commits/${currentSha}`));
    const sourceCommit = object(await read(`${prefix}/git/commits/${headSha}`));
    requireProof(
      currentCommit.sha === currentSha && sourceCommit.sha === headSha,
      'Commit identity mismatch'
    );
    const currentTree = sha(object(currentCommit.tree).sha);
    requireProof(
      currentTree === sha(object(sourceCommit.tree).sha),
      'Current and source trees differ'
    );
    // Tree identity includes toolchain pins, patches, lockfile and all test/lint inputs.
    const currentWorkflow = object(await read(`${prefix}/contents/${WORKFLOW}?ref=${currentSha}`));
    const sourceWorkflow = object(await read(`${prefix}/contents/${WORKFLOW}?ref=${headSha}`));
    requireProof(
      currentWorkflow.type === 'file' &&
        sourceWorkflow.type === 'file' &&
        currentWorkflow.path === WORKFLOW &&
        sourceWorkflow.path === WORKFLOW &&
        sha(currentWorkflow.sha) === sha(sourceWorkflow.sha),
      'Workflow bytes differ'
    );
    const expected = [
      'plan',
      'Fast feedback',
      'validate',
      'Full qualification',
      ...ELIGIBLE.map(([name]) => name),
    ];
    requireProof(jobs.length === expected.length, 'Unexpected or partial full job set');
    for (const name of expected) {
      const matching = jobs.filter((job) => job.name === name);
      requireProof(matching.length === 1, `Missing or duplicate job: ${name}`);
      const job = matching[0];
      requireProof(
        job.run_id === runId &&
          job.run_attempt === attempt &&
          job.head_sha === headSha &&
          job.status === 'completed' &&
          job.conclusion === (name === 'Fast feedback' ? 'skipped' : 'success') &&
          fresh(job.completed_at, context.now),
        `Unqualified job: ${name}`
      );
      if (!ELIGIBLE.some(([eligible]) => eligible === name)) continue;
      const windows = name === 'Task change ledger Windows smoke';
      const runnerClass = windows ? 'windows-latest' : context.linuxRunner;
      const os = windows ? 'Windows' : 'Linux';
      const arch = windows ? 'X64' : context.linuxArch;
      requireProof(
        typeof job.runner_name === 'string' &&
          job.runner_name.length > 0 &&
          positive(job.runner_id) > 0 &&
          array(job.labels).includes(runnerClass),
        `Missing runner class proof: ${name}`
      );
      const steps = array(job.steps).map(object);
      const runnerProof = `CI runner proof: ${os} | ${arch} | ${runnerClass}`;
      requireProof(
        steps.filter(
          (step) =>
            step.name === runnerProof &&
            step.status === 'completed' &&
            step.conclusion === 'success'
        ).length === 1,
        `Missing actual OS/architecture proof: ${name}`
      );
      // Success of the job cannot hide conditional/skipped test or lint work.
      const command = ELIGIBLE.find(([eligible]) => eligible === name)?.[1];
      requireProof(
        steps.some(
          (step) =>
            step.name === command && step.status === 'completed' && step.conclusion === 'success'
        ),
        `Skipped command: ${name}`
      );
      const allowedSkips =
        name === 'test (2/2)'
          ? [
              'Test workspace packages',
              'Test CI scripts and OpenCode proof runner safety',
              'Test feedback policy',
            ]
          : name === 'lint (renderer)' || name === 'lint (features)'
            ? ['Lint MCP package']
            : [];
      requireProof(
        steps.every(
          (step) =>
            step.status === 'completed' &&
            (step.conclusion === 'success' ||
              (step.conclusion === 'skipped' &&
                typeof step.name === 'string' &&
                allowedSkips.includes(step.name)))
        ),
        `Incomplete or skipped command evidence: ${name}`
      );
    }
    // Detect a rerun begun while metadata was being collected.
    const finalRun = object(await read(`${prefix}/actions/runs/${runId}`));
    requireProof(
      finalRun.run_attempt === attempt &&
        finalRun.status === 'completed' &&
        finalRun.conclusion === 'success',
      'Source attempt changed during proof'
    );
    const finalListing = object(
      await read(
        `${prefix}/actions/workflows/${workflowId}/runs?event=pull_request&head_sha=${headSha}&per_page=100`
      )
    );
    const finalRuns = array(finalListing.workflow_runs).map(object);
    requireProof(
      finalListing.total_count === finalRuns.length &&
        finalRuns.length > 0 &&
        Math.max(...finalRuns.map((item) => positive(item.id))) === runId,
      'Latest source run changed during proof'
    );
    return { reuse: true, sourceRun: String(runId), reason: 'Verified identical-input full CI' };
  } catch (error) {
    return {
      reuse: false,
      sourceRun: '',
      reason: error instanceof Error ? error.message : 'Invalid provenance',
    };
  }
}
