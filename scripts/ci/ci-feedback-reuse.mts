// Only authenticated GitHub metadata can qualify reuse. No artifacts or PR prose are inputs.
export const REPOSITORY = '777genius/agent-teams-ai';
export const WORKFLOW = '.github/workflows/ci.yml';
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// GitHub reports this exact unevaluated name for the skipped feedback job.
// It is an alias only after workflow/tree provenance is verified, never executed code.
const SKIPPED_FEEDBACK_NAME =
  "github.event_name == 'pull_request' && github.event.action == 'edited' && (needs.plan.result != 'success' || needs.plan.outputs.metadata != 'false') && 'Metadata fast feedback' || 'Fast feedback'";
export type JsonObject = Record<string, unknown>;
export type GitHubRead = (endpoint: string) => Promise<unknown>;
export type ReuseResult = { reuse: boolean; sourceRun: string; reason: string };

export function isRunnerImage(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z][A-Za-z0-9._-]{0,63}@[0-9][A-Za-z0-9._-]{0,63}$/.test(value) &&
    !value.toLowerCase().startsWith('unknown@')
  );
}

export function runnerImage(env: Record<string, string | undefined>): string {
  // These are the standard image build facts, not ImageID or a mutable runner label.
  const image = `${env.ImageOS ?? ''}@${env.ImageVersion ?? ''}`;
  return isRunnerImage(image) ? image : 'unknown';
}

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
  [
    'test (1/2)',
    [
      'Test workspace packages',
      'Test CI scripts and OpenCode proof runner safety',
      'Test root shard',
      'Test feedback policy',
    ],
  ],
  ['test (2/2)', ['Test root shard']],
  ['lint (main)', ['Lint source shard', 'Lint MCP package']],
  ['lint (renderer)', ['Lint source shard']],
  ['lint (features)', ['Lint source shard']],
  [
    'Task change ledger Windows smoke',
    [
      'Test crash-safe app lock publication',
      'Test controller lock compatibility',
      'Test task change ledger',
      'Test startup cleanup deadline and late-response lifecycle',
    ],
  ],
] as const;

// Exact jobs API names from run 37621422796; never evaluated or matched broadly.
const METADATA_SKIPPED_NAMES = [
  "${{ (((github.event_name == 'pull_request') && (github.event.action == 'edited') && (((needs.plan.result != 'success') || (needs.plan.outputs.metadata != 'false'))) && 'Metadata lint') || 'lint') }} (${{ matrix.scope }})",
  "${{ (((github.event_name == 'pull_request') && (github.event.action == 'edited') && (((needs.plan.result != 'success') || (needs.plan.outputs.metadata != 'false'))) && 'Metadata test') || 'test') }} (${{ matrix.shard }}/2)",
  "github.event_name == 'pull_request' && github.event.action == 'edited' && (needs.plan.result != 'success' || needs.plan.outputs.metadata != 'false') && 'Metadata validate' || 'validate'",
  "github.event_name == 'pull_request' && github.event.action == 'edited' && (needs.plan.result != 'success' || needs.plan.outputs.metadata != 'false') && 'Metadata Windows smoke' || 'Task change ledger Windows smoke'",
  SKIPPED_FEEDBACK_NAME,
] as const;

function proveMetadataJobs(jobs: JsonObject[], run: JsonObject, now: number): void {
  const expected = ['Metadata CI plan', 'Metadata CI result', ...METADATA_SKIPPED_NAMES];
  requireProof(jobs.length === expected.length, 'Unexpected metadata job set');
  for (const name of expected) {
    const matching = jobs.filter((job) => job.name === name);
    requireProof(matching.length === 1, 'Missing or duplicate metadata job');
    const job = matching[0];
    const skipped = METADATA_SKIPPED_NAMES.some((value) => value === name);
    requireProof(
      job.run_id === run.id &&
        job.run_attempt === run.run_attempt &&
        job.head_sha === run.head_sha &&
        job.status === 'completed' &&
        job.conclusion === (skipped ? 'skipped' : 'success') &&
        fresh(job.completed_at, now),
      'Unqualified metadata job'
    );
    const steps = array(job.steps).map(object);
    if (skipped) {
      requireProof(steps.length === 0, 'Metadata heavy job executed steps');
      continue;
    }
    const planning = name === 'Metadata CI plan';
    const required = planning
      ? ['Plan feedback and verify reusable evidence']
      : [
          'Preserve existing current-code checks after metadata edits',
          'Require complete current-code qualification',
        ];
    for (const stepName of required) {
      requireProof(
        steps.filter((step) => step.name === stepName).length === 1,
        'Missing metadata decision step'
      );
    }
    const allowed = [
      'Set up job', 'Set up runner', 'Checkout', 'Setup Node.js', 'Post Setup Node.js',
      'Post Checkout', 'Complete runner', 'Complete job', ...required,
    ];
    const names = steps.map((step) => step.name);
    requireProof(
      new Set(names).size === names.length &&
        steps.every((step) =>
          step.status === 'completed' && typeof step.name === 'string' &&
          (allowed.includes(step.name) || (planning && step.name.startsWith('CI source proof:'))) &&
          step.conclusion ===
            (step.name === 'Require complete current-code qualification' ? 'skipped' : 'success')
        ),
      'Unknown, incomplete or unsafe metadata step'
    );
  }
}

function readSourceBase(
  jobs: JsonObject[],
  run: JsonObject,
  prNumber: number,
  headSha: string,
  repoId: number,
  planName: string
): string {
  // GitHub can drop run.pull_requests after merge. Preserve the trusted event's
  // immutable base/head in a workflow-defined step name, read through the jobs API.
  const planJobs = jobs.filter((job) => job.name === planName);
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
    sourceProof && Number(sourceProof[1]) === prNumber && sourceProof[3] === headSha,
    'Immutable source event proof mismatch'
  );
  const testedBase = sha(sourceProof[2]);
  const links = array(run.pull_requests).map(object);
  requireProof(links.length <= 1, 'Ambiguous source PR linkage');
  if (links.length === 1) {
    const sourceHead = object(links[0].head);
    const sourceBase = object(links[0].base);
    requireProof(
      links[0].number === prNumber &&
        sourceHead.sha === headSha &&
        sourceBase.sha === testedBase &&
        object(sourceHead.repo).id === repoId &&
        object(sourceBase.repo).id === repoId,
      'Source PR linkage disagrees with immutable event'
    );
  }
  return testedBase;
}

export type ReuseContext = {
  repository: string;
  currentSha: string;
  linuxRunner: string;
  linuxArch: string;
  linuxImage: string;
  windowsImage?: string;
  sourceRun?: string;
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
    requireProof(isRunnerImage(context.linuxImage), 'Unknown current Linux image');
    if (context.windowsImage !== undefined) {
      requireProof(isRunnerImage(context.windowsImage), 'Unknown current Windows image');
    }
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
    const prNumber = positive(pr.number);
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
    // Only proven harmless metadata can be crossed. The closest other run must
    // qualify in full; failure/unknown evidence never falls back to an older pass.
    runs.sort((a, b) => positive(b.id) - positive(a.id));
    requireProof(
      new Set(runs.map((item) => positive(item.id))).size === runs.length,
      'Duplicate source runs'
    );
    const sameRun = (candidate: JsonObject, expected: JsonObject): boolean =>
      candidate.id === expected.id && candidate.workflow_id === workflowId &&
      candidate.path === WORKFLOW && candidate.event === 'pull_request' &&
      candidate.head_sha === headSha && candidate.run_attempt === expected.run_attempt &&
      candidate.status === 'completed' && candidate.conclusion === 'success' &&
      candidate.created_at === expected.created_at && candidate.updated_at === expected.updated_at &&
      fresh(candidate.created_at, context.now) && fresh(candidate.updated_at, context.now) &&
      sameRepository(candidate.repository, repoId) && sameRepository(candidate.head_repository, repoId);
    const metadata: { run: JsonObject; jobs: JsonObject[]; base: string }[] = [];
    let selected: { run: JsonObject; jobs: JsonObject[] } | undefined;
    for (const candidate of runs.slice(0, 8)) {
      const id = positive(candidate.id);
      const candidateRun = object(await read(`${prefix}/actions/runs/${id}`));
      const attempt = positive(candidateRun.run_attempt);
      requireProof(
        sameRun(candidateRun, candidateRun) && sameRun(candidate, candidateRun),
        'Latest candidate is not a fresh authenticated successful run'
      );
      const response = object(
        await read(`${prefix}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`)
      );
      const candidateJobs = array(response.jobs).map(object);
      requireProof(
        response.total_count === candidateJobs.length && candidateJobs.length < 100,
        'Incomplete job list'
      );
      // The plan name is assigned before strict event classification. Only the
      // result names a metadata decision, and its complete job proof must pass.
      if (candidateJobs.some((job) => job.name === 'Metadata CI result')) {
        proveMetadataJobs(candidateJobs, candidateRun, context.now);
        const metadataBase = readSourceBase(
          candidateJobs, candidateRun, prNumber, headSha, repoId, 'Metadata CI plan'
        );
        metadata.push({ run: candidateRun, jobs: candidateJobs, base: metadataBase });
        continue;
      }
      selected = { run: candidateRun, jobs: candidateJobs };
      break;
    }
    requireProof(selected, 'No full source within eight newest runs');
    const { run, jobs } = selected;
    const runId = positive(run.id);
    const attempt = positive(run.run_attempt);
    requireProof(
      context.sourceRun === undefined || context.sourceRun === String(runId),
      'Windows source run differs from verified Linux source run'
    );
    // A conservatively classified edited event can run every canonical full job
    // under this exact successful preclassification plan name.
    const fullPlanName = jobs.some((job) =>
      job.name === 'Metadata CI plan' && job.conclusion === 'success'
    ) ? 'Metadata CI plan' : 'plan';
    const testedBase = readSourceBase(jobs, run, prNumber, headSha, repoId, fullPlanName);
    requireProof(
      metadata.every((item) => item.base === testedBase),
      'Metadata base differs from full source'
    );
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
    const parents = array(currentCommit.parents).map(object);
    requireProof(
      parents.length === 1 && parents[0].sha === testedBase,
      'Current commit is not an ordinary squash onto the exact tested base'
    );
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
      const matching = jobs.filter(
        (job) =>
          job.name === name ||
          (name === 'plan' && job.name === fullPlanName && job.conclusion === 'success') ||
          (name === 'Fast feedback' &&
            job.name === SKIPPED_FEEDBACK_NAME &&
            job.conclusion === 'skipped')
      );
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
      const imageProofs = steps.filter(
        (step) => typeof step.name === 'string' && step.name.startsWith('CI image proof:')
      );
      requireProof(
        imageProofs.length === 1 &&
          imageProofs[0].status === 'completed' &&
          imageProofs[0].conclusion === 'success',
        `Missing immutable runner image proof: ${name}`
      );
      const image = String(imageProofs[0].name).slice('CI image proof: '.length);
      requireProof(
        isRunnerImage(image) && imageProofs[0].name === `CI image proof: ${image}`,
        `Unknown or malformed source image: ${name}`
      );
      const currentImage = windows ? context.windowsImage : context.linuxImage;
      requireProof(
        currentImage === undefined || image === currentImage,
        `Runner image changed: ${name}`
      );
      const runnerProof = `CI runner proof: ${os} | ${arch} | ${runnerClass}`;
      const runnerSteps = steps.filter((step) => step.name === runnerProof);
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
      const commands = ELIGIBLE.find(([eligible]) => eligible === name)![1];
      for (const command of commands) {
        const commandSteps = steps.filter(
          (step) =>
            step.name === command && step.status === 'completed' && step.conclusion === 'success'
        );
        requireProof(commandSteps.length === 1, `Missing or skipped command: ${name}: ${command}`);
        requireProof(
          positive(imageProofs[0].number) < positive(commandSteps[0].number) &&
            positive(runnerSteps[0].number) < positive(commandSteps[0].number),
          `Runner proof was recorded after commands: ${name}`
        );
      }
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
    // Re-read every selected/crossed attempt, then bind the unchanged listing.
    for (const item of [{ run, jobs, base: testedBase }, ...metadata]) {
      const finalRun = object(await read(`${prefix}/actions/runs/${positive(item.run.id)}`));
      requireProof(sameRun(finalRun, item.run), 'Source attempt changed during proof');
      const planName = item.run.id === runId ? fullPlanName : 'Metadata CI plan';
      requireProof(
        readSourceBase(item.jobs, finalRun, prNumber, headSha, repoId, planName) === item.base,
        'Source base changed during proof'
      );
    }
    const finalListing = object(await read(
      `${prefix}/actions/workflows/${workflowId}/runs?event=pull_request&head_sha=${headSha}&per_page=100`
    ));
    const finalRuns = array(finalListing.workflow_runs).map(object);
    finalRuns.sort((a, b) => positive(b.id) - positive(a.id));
    const listingIdentity = (item: JsonObject): string => JSON.stringify([
      item.id, item.run_attempt, item.workflow_id, item.path, item.event, item.head_sha,
      item.status, item.conclusion, item.created_at, item.updated_at,
      object(item.repository).id, object(item.repository).full_name,
      object(item.head_repository).id, object(item.head_repository).full_name,
      item.pull_requests,
    ]);
    requireProof(
      finalListing.total_count === finalRuns.length && finalRuns.length === runs.length &&
        finalRuns.every((item, index) => listingIdentity(item) === listingIdentity(runs[index])),
      'Latest source run changed during proof'
    );
    for (const item of [{ run }, ...metadata]) {
      const listed = finalRuns.find((candidate) => candidate.id === item.run.id);
      requireProof(listed && sameRun(listed, item.run), 'Selected listing attempt changed during proof');
    }
    return { reuse: true, sourceRun: String(runId), reason: 'Verified identical-input full CI' };
  } catch (error) {
    return {
      reuse: false,
      sourceRun: '',
      reason: error instanceof Error ? error.message : 'Invalid provenance',
    };
  }
}
