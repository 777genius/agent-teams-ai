import { parse } from 'yaml';

import { canonical, compareNames, digest, requireThat } from './contract.js';
import type { StagePlan } from './contract.js';
import { RELEASE216_EXECUTORS } from './release216ExecutionPins.js';
import { RELEASE220_EXECUTION as pins } from './release220ExecutionPins.js';
import { RELEASE220_MAC_EXECUTION as macPins } from './release220MacExecutionPins.js';
import { RELEASE220_WINDOWS_EXECUTION as windowsPins } from './release220WindowsExecutionPins.js';

type Json = Record<string, unknown>;
interface Row {
  job: string;
  execute: string;
  upload: string;
}

export function object(value: unknown, label: string): Json {
  requireThat(
    value && typeof value === 'object' && !Array.isArray(value),
    `Missing object: ${label}`
  );
  return value as Json;
}
export function list(value: unknown, label: string): unknown[] {
  requireThat(Array.isArray(value), `Missing array: ${label}`);
  return value;
}
export function at(value: unknown, ...keys: string[]): unknown {
  let result = value;
  for (const key of keys) result = object(result, keys.join('.'))[key];
  return result;
}
export function validateWorkflow(source: string, row: Row) {
  const jobs = object(at(parse(source), 'jobs'), 'workflow jobs');
  const producer = object(jobs[row.job], row.job);
  const steps = list(producer.steps, 'workflow steps').map((item) => object(item, 'workflow step'));
  const native = steps.filter((item) => item.name === row.execute);
  const upload = steps.filter((item) => item.name === row.upload);
  requireThat(
    native.length === 1 && typeof native[0]?.run === 'string',
    'Untrusted native execution step'
  );
  requireThat(
    upload.length === 1 && String(upload[0]?.uses).startsWith('actions/upload-artifact@'),
    'Untrusted native upload step'
  );
  requireThat(native[0] && upload[0], 'Missing native execution/upload steps');
  const order = steps.indexOf(native[0]) < steps.indexOf(upload[0]);
  requireThat(order, 'Upload must follow native execution');
}

export const RELEASE216_TOOLING = '80ad7936b6d602c89f712e14771911098277ec44';
export interface ExecutionTree {
  sha: string;
  truncated: boolean;
  tree: { path: string; mode: string; type: string; sha: string }[];
}
export interface ExecutionProof {
  repository: string;
  commit: { sha: string; tree: { sha: string }; parents: { sha: string }[] };
  comparison: { status: string; base_commit: { sha: string }; merge_base_commit: { sha: string } };
  baseTree: ExecutionTree;
  executionTree: ExecutionTree;
}
function treeRecords(tree: ExecutionTree, expectedDigest: string) {
  requireThat(tree.truncated === false && Array.isArray(tree.tree), 'Incomplete execution tree');
  const records = new Map<string, string[]>();
  for (const entry of tree.tree) {
    requireThat(
      typeof entry.path === 'string' &&
        entry.path.length > 0 &&
        !records.has(entry.path) &&
        /^[a-f0-9]{40}$/.test(entry.sha) &&
        /^(040000:tree|160000:commit|(100644|100755|120000):blob)$/.test(
          `${entry.mode}:${entry.type}`
        ),
      'Invalid execution tree entry'
    );
    records.set(entry.path, [entry.mode, entry.type, entry.sha]);
  }
  const snapshot = [...records]
    .sort(([a], [b]) => compareNames(a, b))
    .map(([name, values]) => [name, ...values]);
  requireThat(
    digest(canonical(snapshot)) === expectedDigest,
    'Complete execution tree records changed'
  );
  return records;
}
export function release216Execution(kind: string, plan: StagePlan, planSha: string, input: string) {
  requireThat(
    planSha === '87207cedd0bf2a8a7fcee0ea44c876a04acea0873c30553b9da26bafa62f4c91' &&
      input === '66dae8c8ce3ebd607408d19c29ba7c01041d1e72a0406de5e57ba7e677cf0839' &&
      plan.input.repository === '777genius/agent-teams-ai' &&
      plan.input.toolingSha === RELEASE216_TOOLING,
    'Schema2 requires the original closed release216 plan'
  );
  if (kind === 'windows' || kind === 'mac-old') return RELEASE216_EXECUTORS[kind].head;
  return RELEASE216_TOOLING;
}
/** Closed reviewed Windows/Mac roles share the same complete Git proof checks. */
export function verifyRelease216Execution(
  proof: ExecutionProof,
  kind: 'windows' | 'mac-old'
): void {
  const { head, tree, records, delta: expectedDelta } = RELEASE216_EXECUTORS[kind];
  requireThat(proof.repository === '777genius/agent-teams-ai', 'Wrong execution repository');
  requireThat(
    proof.commit.sha === head &&
      proof.commit.tree.sha === tree &&
      proof.executionTree.sha === tree &&
      canonical(proof.commit.parents.map((parent) => parent.sha)) ===
        canonical([RELEASE216_TOOLING]) &&
      proof.comparison.status === 'ahead' &&
      proof.comparison.base_commit.sha === RELEASE216_TOOLING &&
      proof.comparison.merge_base_commit.sha === RELEASE216_TOOLING &&
      proof.baseTree.sha === 'cb7c434ebe9aae6a631f64292746af75e48a753d',
    'Unapproved execution ancestry or tree'
  );
  const original = treeRecords(
    proof.baseTree,
    'd6f44bdec81a1b8ca1354bc4d3f2bb78caca38ddc4de0bfe5bb8846e9707d2b8'
  );
  const actual = treeRecords(proof.executionTree, records);
  const delta = [...new Set([...original.keys(), ...actual.keys()])]
    .sort(compareNames)
    .map((name) => [name, original.get(name) ?? null, actual.get(name) ?? null])
    .filter((item) => canonical(item[1]) !== canonical(item[2]));
  requireThat(
    digest(canonical(delta)) === expectedDelta,
    'Execution differs from reviewed complete Git tree delta'
  );
}
export function verifyRelease216MacExecution(proof: ExecutionProof): void {
  verifyRelease216Execution(proof, 'mac-old');
}

export function verifyRelease220MacExecution(proof: ExecutionProof): void {
  verifyClosed220Executor(proof, macPins, 'Mac');
}
export function verifyRelease220WindowsExecution(proof: ExecutionProof): void {
  verifyClosed220Executor(proof, windowsPins, 'Windows');
}
function verifyClosed220Executor(
  proof: ExecutionProof,
  executor: typeof macPins | typeof windowsPins,
  role: 'Mac' | 'Windows'
): void {
  requireThat(
    proof.repository === executor.repository,
    `Wrong full220 ${role} executor repository`
  );
  requireThat(
    proof.commit.sha === executor.head &&
      proof.commit.tree.sha === executor.tree &&
      proof.executionTree.sha === executor.tree &&
      proof.baseTree.sha === executor.baseTree &&
      canonical(proof.commit.parents.map((parent) => parent.sha)) === canonical([executor.base]) &&
      proof.comparison.status === 'ahead' &&
      proof.comparison.base_commit.sha === executor.base &&
      proof.comparison.merge_base_commit.sha === executor.base,
    `Unapproved full220 ${role} executor ancestry or tree`
  );
  const original = treeRecords(proof.baseTree, executor.baseRecords);
  const actual = treeRecords(proof.executionTree, executor.records);
  const delta = [...new Set([...original.keys(), ...actual.keys()])]
    .sort(compareNames)
    .map((name) => [name, original.get(name) ?? null, actual.get(name) ?? null])
    .filter((item) => canonical(item[1]) !== canonical(item[2]));
  requireThat(
    digest(canonical(delta)) === executor.delta,
    `Unapproved full220 ${role} complete tree delta`
  );
}

/** E13 emits actual execution custody separately from prepared E10 tooling. */
export function verifyRelease220WindowsProvenance(
  value: Json,
  toolingSha: string,
  executionSha: string,
  runId: number,
  attempt: number,
  job: string
): void {
  if (executionSha !== windowsPins.head) return;
  requireThat(
    toolingSha === windowsPins.base &&
      canonical(object(value.execution, 'Windows execution provenance')) ===
        canonical({ toolingSha, executionSha, runId, attempt, job }),
    'Native proof mismatch: Windows execution provenance'
  );
}

export interface Release220ExecutionProof extends ExecutionProof {
  comparison: ExecutionProof['comparison'] & {
    ahead_by: number;
    behind_by: number;
    total_commits: number;
    commits: { sha: string }[];
    files: { filename: string; status: string; sha: string }[];
  };
  ci: {
    actor: { login: string };
    id: number;
    run_attempt: number;
    head_sha: string;
    path: string;
    event: string;
    status: string;
    conclusion: string | null;
    repository: { full_name: string };
    head_repository: { full_name: string };
  };
  jobs: {
    id: number;
    run_id: number;
    run_attempt: number;
    head_sha: string;
    name: string;
    status: string;
    conclusion: string | null;
    steps?: { name: string; status: string; conclusion: string | null }[];
  }[];
  baseCi: Release220ExecutionProof['ci'];
  baseJobs: Release220ExecutionProof['jobs'];
}
export function release220Execution(kind: string, plan: StagePlan, planSha: string, input: string) {
  requireThat(
    planSha === pins.plan &&
      input === pins.input &&
      plan.input.repository === pins.repository &&
      plan.input.mode === 'full' &&
      plan.input.toolingSha === pins.base &&
      plan.input.target.applicationSha === pins.application &&
      plan.input.target.tag === 'v2.17.10' &&
      plan.input.macProductMinimum === '13.0' &&
      plan.input.macSource === null,
    'Closed full220 executor requires original P10/D10/E10 application graph'
  );
  return kind === 'package' ? pins.head : pins.base;
}
export function verifyRelease220Execution(proof: Release220ExecutionProof): void {
  requireThat(proof.repository === pins.repository, 'Wrong full220 execution repository');
  requireThat(
    proof.commit.sha === pins.head &&
      proof.commit.tree.sha === pins.tree &&
      proof.executionTree.sha === pins.tree &&
      proof.baseTree.sha === pins.baseTree &&
      canonical(proof.commit.parents.map((parent) => parent.sha)) === canonical([pins.base]) &&
      proof.comparison.status === 'ahead' &&
      proof.comparison.base_commit.sha === pins.base &&
      proof.comparison.merge_base_commit.sha === pins.base &&
      proof.comparison.ahead_by === 1 &&
      proof.comparison.behind_by === 0 &&
      proof.comparison.total_commits === 1 &&
      canonical(proof.comparison.commits.map((commit) => commit.sha)) === canonical([pins.head]),
    'Unapproved full220 execution ancestry or tree'
  );
  const original = treeRecords(proof.baseTree, pins.baseRecords);
  const actual = treeRecords(proof.executionTree, pins.records);
  const delta = [...new Set([...original.keys(), ...actual.keys()])]
    .sort(compareNames)
    .map((name) => [name, original.get(name) ?? null, actual.get(name) ?? null])
    .filter((item) => canonical(item[1]) !== canonical(item[2]));
  requireThat(digest(canonical(delta)) === pins.delta, 'Unapproved full220 complete tree delta');
  requireThat(
    canonical(
      proof.comparison.files
        .map(({ filename, status, sha }) => ({ filename, status, sha }))
        .sort((a, b) => compareNames(a.filename, b.filename))
    ) === canonical(pins.files),
    'Unapproved full220 compared leaf blobs'
  );
  for (const file of pins.files)
    requireThat(
      canonical(actual.get(file.filename)) === canonical(['100644', 'blob', file.sha]),
      'Wrong reviewed full220 blob'
    );
  // Closed E11 targeted harness quality plus cryptographically unchanged E10 full CI.
  // Full E11 CI failed its unrelated development dependency audit; it is not reused.
  verify220QualityRun(
    proof.ci,
    pins.ciRun,
    pins.head,
    '.github/workflows/stage-existing-partial-draft.yml'
  );
  verify220QualityJobs(proof.jobs, proof.ci, ['assemble-draft']);
  const steps = proof.jobs[0]?.steps ?? [];
  requireThat(
    pins.ciSteps.every((name) => {
      const matches = steps.filter((step) => step.name === name);
      return (
        matches.length === 1 &&
        matches[0]?.status === 'completed' &&
        matches[0].conclusion === 'success'
      );
    }),
    'Missing successful reviewed E11 typed quality or immutable input step'
  );
  verify220QualityRun(proof.baseCi, pins.baseCiRun, pins.base, '.github/workflows/ci.yml');
  verify220QualityJobs(proof.baseJobs, proof.baseCi, pins.ciJobs, pins.ciSkippedJob);
}
function verify220QualityRun(
  ci: Release220ExecutionProof['ci'],
  run: number,
  head: string,
  path: string
): void {
  requireThat(
    ci.id === run &&
      ci.run_attempt === pins.ciAttempt &&
      ci.actor.login === '777genius' &&
      ci.repository.full_name === pins.repository &&
      ci.head_repository.full_name === pins.repository &&
      ci.head_sha === head &&
      ci.path === path &&
      ci.event === 'workflow_dispatch' &&
      ci.status === 'completed' &&
      ci.conclusion === 'success',
    'Missing exact closed full220 quality whole run success'
  );
}
function verify220QualityJobs(
  jobs: Release220ExecutionProof['jobs'],
  ci: Release220ExecutionProof['ci'],
  names: readonly string[],
  skipped?: string
): void {
  requireThat(
    canonical(jobs.map((job) => job.name).sort(compareNames)) ===
      canonical([...names].sort(compareNames)) &&
      new Set(jobs.map((job) => job.id)).size === jobs.length &&
      jobs.every(
        (job) =>
          Number.isSafeInteger(job.id) &&
          job.id > 0 &&
          job.run_id === ci.id &&
          job.run_attempt === ci.run_attempt &&
          job.head_sha === ci.head_sha &&
          job.status === 'completed' &&
          job.conclusion === (job.name === skipped ? 'skipped' : 'success')
      ),
    'Incomplete or unsuccessful current closed full220 quality jobs'
  );
}
