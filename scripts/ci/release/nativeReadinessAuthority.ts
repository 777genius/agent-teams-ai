import { parse } from 'yaml';

import { canonical, compareNames, digest, requireThat } from './contract.js';
import type { StagePlan } from './contract.js';
import { RELEASE216_EXECUTORS } from './release216ExecutionPins.js';

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
