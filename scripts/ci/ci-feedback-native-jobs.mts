import type { JsonObject } from './ci-feedback-reuse.mts';

export type NativeProofMode = 'full' | 'draft' | 'metadata';
export type NativeJobExpectation = {
  name: string;
  conclusion: 'success' | 'skipped';
  requiredSteps: readonly string[];
};

const retained = 'Retained OpenCode V1 and Host V2 original Desktop';
const codex = 'Codex login Desktop (Linux x64)';
// Observed skipped matrix name: run 45673538867, job 139414915868.
const desktopSkipped = 'Stage 1 source Desktop (${{ matrix.label }})';
const processQualification = 'Stage 1 current-tuple process and packed qualification';
const diagnostic = 'Stage 1 process tuple diagnostic (unqualified)';
export const NATIVE_QUALIFICATION_GATE_STEPS = [
  'Require selected retained V1 and Host V2 native Desktop qualification',
  'Require selected Codex login and protocol-peer schedule qualification',
] as const;
const desktopNames = [
  'mixed Create and Launch',
  'mixed Create and Launch with OpenCode V2',
  'Create with native launch',
  'solo Create and native persistent teammate',
  'saved legacy import only',
  'stopped legacy import and native Launch',
  'active input Quit and cold readback',
  'pending open Quit and cold readback',
  'OpenCode V2 active input Quit and cold readback',
  'OpenCode V2 pending open Quit and cold readback',
  'cold selected Resume',
  'cold selected Codex Resume',
  'cold selected OpenCode V2 Resume',
  'native review and cold readback',
  'OpenCode V2 native Review and cold readback',
  'OpenCode V2 original PNG Composer and cold readback',
  'existing Task board and cross-Team controls',
].map((label) => `Stage 1 source Desktop (${label})`);
const knownNames = new Set([
  retained,
  codex,
  desktopSkipped,
  ...desktopNames,
  processQualification,
  diagnostic,
]);

function requireProof(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(reason);
}
function object(value: unknown): JsonObject {
  requireProof(
    value && typeof value === 'object' && !Array.isArray(value),
    'Missing native qualification identity'
  );
  return value as JsonObject;
}

/** The existing PR selectors only; dispatch never enters a PR provenance proof. */
export function supplementalNativeJobs(
  pr: JsonObject,
  repository: string,
  mode: NativeProofMode
): NativeJobExpectation[] {
  const head = object(pr.head),
    base = object(pr.base);
  const headRepository = object(head.repo).full_name;
  requireProof(
    typeof pr.draft === 'boolean' &&
      Number.isSafeInteger(pr.number) &&
      Number(pr.number) > 0 &&
      typeof head.ref === 'string' &&
      head.ref.length > 0 &&
      typeof base.ref === 'string' &&
      base.ref.length > 0 &&
      typeof headRepository === 'string' &&
      headRepository.length > 0,
    'Incomplete native qualification selection'
  );
  requireProof(
    mode === 'metadata' || (mode === 'full' && !pr.draft) || (mode === 'draft' && pr.draft),
    'Native qualification mode differs from PR state'
  );
  const sameRepository = headRepository === repository;
  const stage1Base = base.ref === 'feat/provider-migration-stage-1';
  const stage1Head = head.ref === 'feat/provider-migration-stage-1';
  const main = base.ref === 'main';
  const frontend = 'feat/provider-host-frontend-parity-20261112';
  const full = mode === 'full';
  // Keep the existing integration-base arm, including its distinct fork policy.
  const stage1Selected = full && (stage1Base || (main && stage1Head && sameRepository));
  const retainedSelected =
    (full && sameRepository && (stage1Base || (main && stage1Head))) ||
    (mode === 'draft' &&
      sameRepository &&
      pr.number === 1192 &&
      base.ref === frontend &&
      head.ref === 'fix/frontend-parity-completion-20261113');
  const codexSelected =
    full &&
    sameRepository &&
    (base.ref === frontend ||
      stage1Base ||
      head.ref === frontend ||
      (pr.number === 982 && stage1Head));
  const job = (
    name: string,
    selected: boolean,
    requiredSteps: readonly string[]
  ): NativeJobExpectation => ({
    name,
    conclusion: selected ? 'success' : 'skipped',
    requiredSteps: selected ? requiredSteps : [],
  });
  return [
    job(retained, retainedSelected, [
      'Require original V2 source owners Repair member selection and cold history',
      'Require original source publication active-session isolation and cold readback',
      'Require complete same-source business, Stop, cold and cleanup evidence',
    ]),
    job(codex, codexSelected, [
      'Verify finite native Claude and Codex scheduled runs',
      'Exercise original login and schedule controls through protocol peers',
    ]),
    ...(stage1Selected
      ? desktopNames.map((name) =>
          job(name, true, [
            'Check existing UI fixtures and run original Desktop controls once',
            'Require the original retained receipt to report PASS',
          ])
        )
      : [job(desktopSkipped, false, [])]),
    job(processQualification, stage1Selected, [
      'Run the two existing native proofs and original packed controls once',
      'Qualify controlled native child cold Host and existing Processes UI Stop separately',
    ]),
    job(diagnostic, false, []),
  ];
}

/** Remove only the complete, authenticated supplemental set; unknown names remain for exactJobs. */
export function withoutProvenNativeJobs(
  jobs: JsonObject[],
  run: JsonObject,
  pr: JsonObject,
  repository: string,
  mode: NativeProofMode,
  allowSelected: boolean
): JsonObject[] {
  const expected = supplementalNativeJobs(pr, repository, mode);
  requireProof(
    allowSelected || expected.every((job) => job.conclusion === 'skipped'),
    'Selected native qualification is outside postmerge reuse'
  );
  const present = jobs.filter((job) => knownNames.has(String(job.name)));
  requireProof(
    present.length === expected.length,
    'Incomplete or extra native qualification job set'
  );
  for (const selected of expected) {
    const matching = present.filter((job) => job.name === selected.name);
    requireProof(matching.length === 1, 'Missing or duplicate native qualification job');
    const job = matching[0]!;
    requireProof(
      job.run_id === run.id &&
        job.run_attempt === run.run_attempt &&
        job.head_sha === run.head_sha &&
        job.status === 'completed',
      'Native qualification attempt mismatch'
    );
    requireProof(
      job.conclusion === selected.conclusion && Array.isArray(job.steps),
      'Native qualification outcome mismatch'
    );
    const steps = job.steps.map(object);
    if (selected.conclusion === 'skipped') {
      requireProof(steps.length === 0, 'Skipped native qualification executed steps');
    } else {
      for (const name of selected.requiredSteps) {
        const matchingSteps = steps.filter((step) => step.name === name);
        requireProof(
          matchingSteps.length === 1 &&
            matchingSteps[0]!.status === 'completed' &&
            matchingSteps[0]!.conclusion === 'success',
          'Missing successful native qualification receipt step'
        );
      }
    }
  }
  const gates = jobs.filter((job) =>
    ['Full qualification', 'Metadata qualification', 'Metadata CI result'].includes(
      String(job.name)
    )
  );
  requireProof(gates.length === 1, 'Missing native qualification result gate');
  const gate = gates[0]!;
  requireProof(Array.isArray(gate.steps), 'Missing native qualification result steps');
  const gateSteps = gate.steps.map(object);
  for (const [index, name] of [retained, codex].entries()) {
    const gateName = NATIVE_QUALIFICATION_GATE_STEPS[index]!;
    const matching = gateSteps.filter((step) => step.name === gateName);
    requireProof(
      matching.length === 1 &&
        matching[0]!.status === 'completed' &&
        matching[0]!.conclusion === expected.find((job) => job.name === name)!.conclusion,
      'Native qualification result step does not match selection'
    );
  }
  return jobs.filter((job) => !knownNames.has(String(job.name)));
}
