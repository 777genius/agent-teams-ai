import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { object, REPOSITORY, rootTestShards, sha, WORKFLOW } from './ci-feedback-reuse.mts';
import type { GitHubRead, JsonObject } from './ci-feedback-reuse.mts';

const lifecycle = ['opened', 'synchronize', 'reopened', 'ready_for_review', 'converted_to_draft'];
// Exact unevaluated jobs API names, also used by the postmerge provenance proof.
const heavySkips = [
  "${{ (((github.event_name == 'pull_request') && (github.event.action == 'edited') && (((needs.plan.result != 'success') || (needs.plan.outputs.metadata != 'false'))) && 'Metadata lint') || 'lint') }} (${{ matrix.scope }})",
  "${{ (((github.event_name == 'pull_request') && (github.event.action == 'edited') && (((needs.plan.result != 'success') || (needs.plan.outputs.metadata != 'false'))) && 'Metadata test') || 'test') }} (${{ matrix.shard }}/2)",
  "github.event_name == 'pull_request' && github.event.action == 'edited' && (needs.plan.result != 'success' || needs.plan.outputs.metadata != 'false') && 'Metadata validate' || 'validate'",
  "github.event_name == 'pull_request' && github.event.action == 'edited' && (needs.plan.result != 'success' || needs.plan.outputs.metadata != 'false') && 'Metadata Windows smoke' || 'Task change ledger Windows smoke'",
];
const feedbackSkip = "github.event_name == 'pull_request' && github.event.action == 'edited' && (needs.plan.result != 'success' || needs.plan.outputs.metadata != 'false') && 'Metadata fast feedback' || 'Fast feedback'";
function configuredHeavySkips(shards: 2 | 4): string[] {
  return heavySkips.map((name) => name.replace('/2)', `/${shards})`));
}
function fullJobs(shards: 2 | 4): string[] {
  return ['validate', 'Full qualification',
    ...Array.from({ length: shards }, (_, index) => `test (${index + 1}/${shards})`),
    'lint (main)', 'lint (renderer)', 'lint (features)', 'Task change ledger Windows smoke'];
}

function requireProof(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(reason);
}
function positive(value: unknown): number {
  requireProof(typeof value === 'number' && Number.isSafeInteger(value) && value > 0, 'Invalid identity');
  return value;
}
function array(value: unknown): JsonObject[] {
  requireProof(Array.isArray(value), 'Missing list');
  return value.map(object);
}
function repoIdentity(value: unknown): string {
  const repo = object(value);
  return JSON.stringify([positive(repo.id), repo.full_name]);
}
function sameLinkedRepository(value: unknown, expected: unknown): boolean {
  // run.pull_requests uses compact {id, name, url}, not the full PR repo shape.
  const linked = object(value);
  const repo = object(expected);
  requireProof(typeof repo.full_name === 'string' &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.full_name), 'Invalid full PR repository');
  return linked.id === positive(repo.id) &&
    linked.name === repo.full_name.split('/')[1] &&
    linked.url === `https://api.github.com/repos/${repo.full_name}` &&
    (linked.full_name === undefined || linked.full_name === repo.full_name);
}
function prIdentity(pr: JsonObject): string {
  const head = object(pr.head);
  const base = object(pr.base);
  return JSON.stringify([pr.id, pr.number, pr.state, pr.draft, pr.title, pr.body,
    head.sha, head.ref, repoIdentity(head.repo), base.sha, base.ref, repoIdentity(base.repo)]);
}
function runIdentity(run: JsonObject): string {
  return JSON.stringify([run.id, run.workflow_id, run.path, run.event, run.head_sha,
    run.run_attempt, run.status, run.conclusion, run.display_title, run.created_at,
    run.updated_at, repoIdentity(run.repository), repoIdentity(run.head_repository), run.pull_requests]);
}
function attestation(run: JsonObject, pr: JsonObject, mergeSha: string): string {
  const title = run.display_title;
  requireProof(typeof title === 'string', 'Missing authenticated run title');
  requireProof(title.startsWith('CI proof:'), 'Missing immutable merge attestation');
  const tuple = /^CI proof: PR=([1-9]\d*) \| head=([a-f0-9]{40}) \| base=([a-f0-9]{40}) \| merge=([a-f0-9]{40}) \| action=([a-z_]+) \| draft=(true|false)$/.exec(title);
  requireProof(tuple && Number(tuple[1]) === pr.number && tuple[2] === object(pr.head).sha &&
    tuple[3] === object(pr.base).sha && tuple[4] === mergeSha && tuple[6] === String(pr.draft), 'Run event attestation mismatch');
  const action = tuple[5];
  requireProof(action === 'edited' || lifecycle.includes(action), 'Unknown producer action');
  requireProof(!(action === 'ready_for_review' && pr.draft) &&
    !(action === 'converted_to_draft' && !pr.draft), 'Contradictory draft action');
  return action;
}
function successfulStep(job: JsonObject, name: string): boolean {
  return array(job.steps).filter((step) => step.name === name &&
    step.status === 'completed' && step.conclusion === 'success').length === 1;
}
function sourceProof(jobs: JsonObject[], run: JsonObject, pr: JsonObject): JsonObject {
  const plans = jobs.filter((job) => job.name === 'plan' || job.name === 'Metadata CI plan');
  requireProof(plans.length === 1, 'Missing or duplicate producer plan');
  const plan = plans[0];
  requireProof(plan.conclusion === 'success' &&
    array(plan.steps).every((step) => step.status === 'completed' && step.conclusion === 'success') &&
    successfulStep(plan, 'Plan feedback and verify reusable evidence'),
    'Producer planning failed');
  const proofs = array(plan.steps).filter((step) => String(step.name).startsWith('CI source proof:'));
  const expected = `CI source proof: PR=${pr.number} | base=${object(pr.base).sha} | head=${object(pr.head).sha}`;
  requireProof(proofs.length === 1 && successfulStep(plan, expected), 'Immutable producer base proof mismatch');
  requireProof(plan.run_id === run.id, 'Plan belongs to another run');
  return plan;
}
function exactJobs(jobs: JsonObject[], expected: string[]): void {
  requireProof(jobs.length === expected.length && expected.every((name) =>
    jobs.filter((job) => job.name === name).length === 1), 'Unexpected producer job set');
}
function skipped(jobs: JsonObject[], names: string[]): void {
  for (const name of names) {
    const job = jobs.find((item) => item.name === name)!;
    requireProof(job.conclusion === 'skipped' && array(job.steps).length === 0,
      'Skipped producer job executed or failed');
  }
}
function skippedDraftNodeCleanup(gate: JsonObject, step: JsonObject): boolean {
  if (step.name !== 'Post Setup Node.js' || step.conclusion !== 'skipped') return false;
  const steps = array(gate.steps);
  const setup = steps.filter((item) => item.name === 'Setup Node.js');
  const failure = steps.filter((item) => item.name === 'Require complete current-code qualification');
  return steps.filter((item) => item.name === 'Post Setup Node.js').length === 1 &&
    setup.length === 1 && setup[0].status === 'completed' && setup[0].conclusion === 'success' &&
    failure.length === 1 && failure[0].status === 'completed' && failure[0].conclusion === 'failure' &&
    positive(step.number) > positive(failure[0].number) && positive(failure[0].number) > positive(setup[0].number);
}
function proveCompleted(jobs: JsonObject[], run: JsonObject, pr: JsonObject, shards: 2 | 4, action?: string): boolean {
  const skippedHeavy = configuredHeavySkips(shards);
  requireProof(jobs.every((job) => job.run_id === run.id && job.run_attempt === run.run_attempt &&
    job.head_sha === run.head_sha && job.status === 'completed'), 'Job attempt mismatch');
  const plan = sourceProof(jobs, run, pr);
  const metadata = jobs.find((job) => job.name === 'Metadata CI result');
  if (metadata) {
    requireProof(action === 'edited' || action === undefined, 'Lifecycle producer claimed metadata');
    exactJobs(jobs, ['Metadata CI plan', 'Metadata CI result', ...skippedHeavy, feedbackSkip]);
    skipped(jobs, [...skippedHeavy, feedbackSkip]);
    requireProof(run.conclusion === 'success' && metadata.conclusion === 'success' &&
      successfulStep(metadata, 'Preserve existing current-code checks after metadata edits') &&
      array(metadata.steps).filter((step) => step.name === 'Require complete current-code qualification' &&
        step.status === 'completed' && step.conclusion === 'skipped').length === 1,
      'Metadata decision failed');
    const infrastructure = ['Set up job', 'Set up runner', 'Checkout', 'Setup Node.js',
      'Post Setup Node.js', 'Post Checkout', 'Complete runner', 'Complete job'];
    for (const job of [plan, metadata]) {
      const allowed = job === plan
        ? [...infrastructure, 'Plan feedback and verify reusable evidence',
            `CI source proof: PR=${pr.number} | base=${object(pr.base).sha} | head=${object(pr.head).sha}`]
        : [...infrastructure, 'Preserve existing current-code checks after metadata edits',
            'Require complete current-code qualification'];
      const steps = array(job.steps);
      requireProof(new Set(steps.map((step) => step.name)).size === steps.length &&
        steps.every((step) => allowed.includes(String(step.name)) && step.status === 'completed' &&
          step.conclusion === (step.name === 'Require complete current-code qualification' ? 'skipped' : 'success')),
        'Unknown or unsafe metadata decision step');
    }
    return false; // Metadata continuity must still reach a canonical producer.
  }
  if (pr.draft && action && action !== 'edited') {
    exactJobs(jobs, ['plan', 'Fast feedback', 'Full qualification', ...skippedHeavy]);
    skipped(jobs, skippedHeavy);
    const feedback = jobs.find((job) => job.name === 'Fast feedback')!;
    const gate = jobs.find((job) => job.name === 'Full qualification')!;
    requireProof(run.conclusion === 'failure' && plan.name === 'plan' &&
      feedback.conclusion === 'success' && ['Test feedback policy', 'Install dependencies',
        'Guard runtime artifacts', 'Guard production source file size', 'Guard Team Provisioning architecture',
        'Typecheck workspace', 'Fast lint'].every((name) => successfulStep(feedback, name)) &&
      array(feedback.steps).every((step) => step.status === 'completed' && step.conclusion === 'success') &&
      gate.conclusion === 'failure' && array(gate.steps).filter((step) =>
        step.name === 'Require complete current-code qualification' && step.status === 'completed' &&
        step.conclusion === 'failure').length === 1 &&
      array(gate.steps).every((step) => step.status === 'completed' &&
        (step.conclusion === 'success' ||
          (step.name === 'Require complete current-code qualification' && step.conclusion === 'failure') ||
          (step.name === 'Preserve existing current-code checks after metadata edits' && step.conclusion === 'skipped') ||
          skippedDraftNodeCleanup(gate, step))),
      'Draft producer failed outside its deliberate qualification gate');
    return true;
  }
  requireProof(!pr.draft, 'Legacy or edited draft producer lacks draft lifecycle proof');
  const feedback = jobs.find((job) => job.name === 'Fast feedback' || job.name === feedbackSkip);
  requireProof(feedback, 'Missing skipped feedback');
  exactJobs(jobs, [String(plan.name), String(feedback.name), ...fullJobs(shards)]);
  skipped(jobs, [String(feedback.name)]);
  requireProof(run.conclusion === 'success' && jobs.every((job) =>
    job === feedback || job.conclusion === 'success') &&
    successfulStep(jobs.find((job) => job.name === 'Full qualification')!, 'Require complete current-code qualification'),
    'Canonical full producer did not succeed');
  return true;
}

/** Preserve only an authenticated canonical producer for this exact PR head/base. */
export async function proveMetadataProducer(
  env: Record<string, string | undefined>, event: unknown, read: GitHubRead
): Promise<boolean> {
  try {
    const shards = rootTestShards(env.CI_ROOT_TEST_SHARDS);
    const mergeSha = sha(env.GITHUB_SHA);
    const payload = object(event);
    const pr = object(payload.pull_request);
    const number = positive(pr.number);
    const head = sha(object(pr.head).sha);
    const runId = Number(env.GITHUB_RUN_ID);
    positive(runId);
    const attempt = Number(env.GITHUB_RUN_ATTEMPT);
    positive(attempt);
    const workflowSha = sha(env.GITHUB_WORKFLOW_SHA);
    requireProof(env.GITHUB_WORKFLOW_REF === `${REPOSITORY}/${WORKFLOW}@refs/pull/${number}/merge`,
      'Current workflow ref mismatch');
    const prefix = `repos/${REPOSITORY}`;
    const repository = object(await read(prefix));
    requireProof(repoIdentity(repository) === repoIdentity(payload.repository), 'Repository identity mismatch');
    const workflow = object(await read(`${prefix}/actions/workflows/ci.yml`));
    const workflowId = positive(workflow.id);
    requireProof(workflow.path === WORKFLOW && workflow.state === 'active', 'Workflow identity mismatch');
    const currentPr = object(await read(`${prefix}/pulls/${number}`));
    requireProof(prIdentity(currentPr) === prIdentity(pr), 'Current PR inputs changed');
    // The loaded workflow bytes must match both authenticated source refs. A
    // matching filename/id alone cannot authenticate attacker-supplied run names.
    const bytes = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url));
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    for (const ref of [workflowSha, head]) {
      const source = object(await read(`${prefix}/contents/${WORKFLOW}?ref=${ref}`));
      requireProof(source.type === 'file' && source.path === WORKFLOW && sha(source.sha) === blob,
        'Source workflow bytes differ');
    }
    const checkRun = (run: JsonObject): void => {
      positive(run.id);
      positive(run.run_attempt);
      requireProof(run.workflow_id === workflowId && run.path === WORKFLOW && run.event === 'pull_request' &&
        run.head_sha === head && repoIdentity(run.repository) === repoIdentity(repository) &&
        repoIdentity(run.head_repository) === repoIdentity(object(pr.head).repo), 'Run identity mismatch');
      const links = array(run.pull_requests);
      if (links.length === 0) {
        const fork = object(object(pr.head).repo);
        requireProof(fork.id !== repository.id && fork.full_name !== REPOSITORY && attestation(run, pr, mergeSha),
          'Empty linkage requires a true fork and immutable event attestation');
        return;
      }
      requireProof(links.length === 1 && links[0].number === number &&
        object(links[0].head).sha === head && object(links[0].base).sha === object(pr.base).sha &&
        sameLinkedRepository(object(links[0].head).repo, object(pr.head).repo) &&
        sameLinkedRepository(object(links[0].base).repo, object(pr.base).repo), 'Run PR linkage mismatch');
    };
    const current = object(await read(`${prefix}/actions/runs/${runId}`));
    checkRun(current);
    requireProof(current.id === runId && current.run_attempt === attempt && attestation(current, pr, mergeSha) === 'edited',
      'Current run is not the attested metadata event');
    // PR base.sha can retain its old anchor after the branch advances. Bind the
    // actual tested merge object instead; every producer must attest this SHA.
    const merge = object(await read(`${prefix}/git/commits/${mergeSha}`));
    const parents = array(merge.parents);
    requireProof(merge.sha === mergeSha && parents.length === 2 && parents[1].sha === head,
      'Current synthetic merge identity mismatch');
    sha(parents[0].sha);
    sha(object(merge.tree).sha);
    const listEndpoint = `${prefix}/actions/workflows/${workflowId}/runs?event=pull_request&head_sha=${head}&per_page=100`;
    const readList = async (): Promise<JsonObject[]> => {
      const listing = object(await read(listEndpoint));
      const runs = array(listing.workflow_runs);
      requireProof(listing.total_count === runs.length && runs.length > 0 && runs.length < 100 &&
        new Set(runs.map((run) => positive(run.id))).size === runs.length, 'Incomplete or duplicate source listing');
      return runs.sort((a, b) => Number(b.id) - Number(a.id));
    };
    const runs = await readList();
    requireProof(runs.some((run) => runIdentity(run) === runIdentity(current)), 'Current run listing differs');
    const checked: JsonObject[] = [];
    let canonical = false;
    for (const candidate of runs.filter((run) => Number(run.id) !== runId).slice(0, 8)) {
      const run = object(await read(`${prefix}/actions/runs/${positive(candidate.id)}`));
      checkRun(run);
      requireProof(run.id === candidate.id && runIdentity(run) === runIdentity(candidate), 'Producer attempt changed');
      const action = attestation(run, pr, mergeSha);
      checked.push(run);
      if (run.status === 'completed') {
        const response = object(await read(`${prefix}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`));
        const jobs = array(response.jobs);
        requireProof(response.total_count === jobs.length && jobs.length < 100, 'Incomplete producer jobs');
        canonical = proveCompleted(jobs, run, pr, shards, action);
      } else {
        requireProof(['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(String(run.status)) &&
          run.conclusion === null && action, 'Pending producer lacks immutable attestation');
        // Edited runs can carry continuity only; they never replace full/draft CI.
        canonical = action !== 'edited';
      }
      if (canonical) break;
    }
    requireProof(canonical, 'No canonical producer within bounded history');
    for (const expected of [current, ...checked]) {
      const final = object(await read(`${prefix}/actions/runs/${expected.id}`));
      requireProof(runIdentity(final) === runIdentity(expected), 'Run changed during metadata proof');
    }
    const finalRuns = await readList();
    requireProof(JSON.stringify(finalRuns.map(runIdentity)) === JSON.stringify(runs.map(runIdentity)),
      'Source listing changed during metadata proof');
    requireProof(prIdentity(object(await read(`${prefix}/pulls/${number}`))) === prIdentity(pr),
      'Current PR base/head changed during metadata proof');
    return true;
  } catch {
    return false;
  }
}
