import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL_SHA,
  computeWorkKey,
} from '../../../../scripts/hosted-web/orchestration/contract-lib.mjs';
import {
  MAX_MANDATORY_READS_PER_LIST,
  REQUIRED_WORKER_DOCS,
  validateWorkerStartContract,
} from '../../../../scripts/hosted-web/orchestration/validate-worker-start.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const templatePath = path.join(
  repoRoot,
  'test/architecture/hosted-web/orchestration/fixtures/valid-worker-start.template.json'
);
const localRequire = createRequire(import.meta.url);
const requireFromFastify = createRequire(localRequire.resolve('fastify/package.json'));
const requireFromAjvCompiler = createRequire(
  requireFromFastify.resolve('@fastify/ajv-compiler/package.json')
);
const Ajv2020 = requireFromAjvCompiler('ajv/dist/2020').default;
const workerSchema = JSON.parse(
  readFileSync(path.join(repoRoot, 'docs/hosted-web-phases/worker-start-contract.schema.json'))
);
const validateWorkerSchema = new Ajv2020({ allErrors: true, strict: false }).compile(workerSchema);

function validContract() {
  const template = JSON.parse(
    readFileSync(templatePath, 'utf8')
      .replaceAll('$JOB_ROOT', repoRoot)
      .replaceAll('$PHASE_START_SHA', CANONICAL_SHA)
  );
  template.workKey = computeWorkKey(template);
  return template;
}

function validate(contract, options = {}) {
  return validateWorkerStartContract(contract, { gitHead: CANONICAL_SHA, ...options });
}

function currentPhaseNavigationIssues(executionIndex, phaseReadme) {
  const issues = [];
  const controllerPacket = executionIndex.currentRoute?.controllerPacket;
  const lanePackets = executionIndex.currentRoute?.lanePackets ?? [];
  const routeMatch = phaseReadme.match(/## Validated worker route\n(?<route>[\s\S]*?)(?=\n## |$)/);
  const route = routeMatch?.groups?.route ?? '';
  const routedPaths = [...route.matchAll(/`(docs\/hosted-web-phases\/[^`]+)`/g)].map(
    (match) => match[1]
  );
  const routedLanePaths = routedPaths.filter((item) => item.includes('/lanes/'));

  if (lanePackets.length !== 1) {
    issues.push(`currentRoute:expected_one_lane:${lanePackets.length}`);
  }

  const expectedRoute = lanePackets.length === 1 ? [controllerPacket, lanePackets[0].path] : [];
  if (!controllerPacket || !routeMatch) {
    issues.push('currentRoute:missing_controller_or_route_section');
  } else if (JSON.stringify(routedPaths.slice(0, 2)) !== JSON.stringify(expectedRoute)) {
    issues.push(`currentRoute:packet_order:${routedPaths.slice(0, 2).join(',')}`);
  }
  if (routedLanePaths.length !== 1) {
    issues.push(`currentRoute:readme_expected_one_lane:${routedLanePaths.length}`);
  }

  const controllerPosition = phaseReadme.indexOf(controllerPacket);
  for (const reference of executionIndex.authorityTiers?.['reference-on-demand'] ?? []) {
    const referencePosition = phaseReadme.indexOf(reference.path);
    if (
      referencePosition !== -1 &&
      (controllerPosition === -1 || referencePosition < controllerPosition)
    ) {
      issues.push(`currentRoute:reference_before_controller:${reference.path}`);
    }
  }

  return issues;
}

test('current Phase README routes controller then exactly one lane before on-demand references', () => {
  const executionIndex = JSON.parse(
    readFileSync(path.join(repoRoot, 'docs/hosted-web-phases/EXECUTION_INDEX.json'), 'utf8')
  );
  const phaseReadme = readFileSync(
    path.join(repoRoot, 'docs/hosted-web-phases/phase-01/README.md'),
    'utf8'
  );
  assert.deepEqual(currentPhaseNavigationIssues(executionIndex, phaseReadme), []);

  const referenceFirst = phaseReadme.replace(
    '## Validated worker route',
    'docs/hosted-web-phases/phase-01/packet-inputs.md\n\n## Validated worker route'
  );
  assert.ok(
    currentPhaseNavigationIssues(executionIndex, referenceFirst).includes(
      'currentRoute:reference_before_controller:docs/hosted-web-phases/phase-01/packet-inputs.md'
    )
  );

  const missingLane = JSON.parse(JSON.stringify(executionIndex));
  missingLane.currentRoute.lanePackets = [];
  assert.ok(
    currentPhaseNavigationIssues(missingLane, phaseReadme).includes(
      'currentRoute:expected_one_lane:0'
    )
  );

  const multipleLanes = JSON.parse(JSON.stringify(executionIndex));
  multipleLanes.currentRoute.lanePackets.push({
    subphase: 'P1.S1',
    path: 'docs/hosted-web-phases/phase-01/lanes/p1-s1-invalid-concurrent-lane.md',
  });
  assert.equal(multipleLanes.currentRoute.lanePackets.length, 2);
  assert.ok(
    currentPhaseNavigationIssues(multipleLanes, phaseReadme).includes(
      'currentRoute:expected_one_lane:2'
    )
  );
});

test('accepts the exact canonical, sandbox-only worker-start contract', () => {
  const result = validate(validContract());
  assert.deepEqual(result, { ok: true, issues: [] });
});

test('separates canonical provenance from the contract-bound phase start', () => {
  const contract = validContract();
  contract.canonicalSha = '0'.repeat(40);
  contract.baseSha = '1'.repeat(40);
  contract.phaseStartSha = '2'.repeat(40);
  const result = validate(contract);
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes(`canonicalSha:expected:${CANONICAL_SHA}`));
  assert.ok(result.issues.includes(`baseSha:expected:${CANONICAL_SHA}`));
  assert.ok(result.issues.includes('workKey:mismatch'));
  assert.ok(result.issues.some((issue) => issue.startsWith('jobRoot:git_head_expected:')));
});

test('rejects missing mandatory inputs and non-exact paths', () => {
  const contract = validContract();
  contract.mandatoryFixtures = ['test/architecture/hosted-web/orchestration/fixtures/missing.json'];
  contract.ownedPaths = ['./docs/hosted-web-phases/*.md'];
  const result = validate(contract);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.startsWith('mandatoryFixtures:missing:')));
  assert.ok(result.issues.includes('ownedPaths:invalid_exact_path:./docs/hosted-web-phases/*.md'));
});

test('rejects prompt and sandbox paths outside jobRoot', () => {
  const contract = validContract();
  contract.promptPath = process.execPath;
  contract.executionPolicy.sandboxRoot = path.parse(repoRoot).root;
  const result = validate(contract);
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('promptPath:outside_jobRoot'));
  assert.ok(result.issues.includes('executionPolicy:sandboxRoot_outside_jobRoot'));
});

test('rejects a weakened sandbox policy or missing forbidden real-project rule', () => {
  const contract = validContract();
  contract.executionPolicy.mode = 'allow-real-projects';
  contract.executionPolicy.forbiddenRealProjects = ['~/somewhere-else'];
  const result = validate(contract);
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('executionPolicy:mode_must_be_sandbox-only'));
  assert.ok(
    result.issues.includes(
      'executionPolicy:missing_forbidden_project:~/dev/projects/ai/claude-runtime'
    )
  );
});

test('rejects a job rooted in any explicitly forbidden real project', () => {
  const contract = validContract();
  contract.executionPolicy.forbiddenRealProjects.push(repoRoot);
  const result = validate(contract);
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes(`jobRoot:forbidden_real_project:${repoRoot}`));
});

test('rejects incomplete mandatory check contracts', () => {
  const contract = validContract();
  contract.requiredChecks = [];
  const result = validate(contract);
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('requiredChecks:non_empty_array_required'));
});

test('requires both authoritative packet paths as mandatory worker reads', () => {
  const contract = validContract();
  contract.mandatoryDocs = contract.mandatoryDocs.filter(
    (item) => item !== contract.controllerPacket
  );
  const result = validate(contract);
  assert.equal(result.ok, false);
  assert.ok(
    result.issues.includes(
      'mandatoryDocs:missing_packet_reference:docs/hosted-web-phase-0-execution-packet.md'
    )
  );
});

test('requires the compact navigation baseline as mandatory worker reads', () => {
  for (const requiredPath of REQUIRED_WORKER_DOCS) {
    const contract = validContract();
    contract.mandatoryDocs = contract.mandatoryDocs.filter((item) => item !== requiredPath);
    const result = validate(contract);
    assert.equal(result.ok, false, requiredPath);
    assert.ok(
      result.issues.includes(`mandatoryDocs:missing_required:${requiredPath}`),
      requiredPath
    );
  }
});

test('rejects recursive, globbed, and numerically unbounded mandatory reads', () => {
  const recursive = validContract();
  recursive.mandatoryDocs.push('docs/research/hosted-web');
  const recursiveResult = validate(recursive);
  assert.equal(recursiveResult.ok, false);
  assert.ok(
    recursiveResult.issues.includes('mandatoryDocs:unbounded_read_root:docs/research/hosted-web')
  );

  const globbed = validContract();
  globbed.mandatoryScripts = ['docs/research/hosted-web/**/*.json'];
  const globbedResult = validate(globbed);
  assert.equal(globbedResult.ok, false);
  assert.ok(
    globbedResult.issues.includes(
      'mandatoryScripts:invalid_exact_path:docs/research/hosted-web/**/*.json'
    )
  );

  const oversized = validContract();
  oversized.mandatoryFixtures = Array.from(
    { length: MAX_MANDATORY_READS_PER_LIST + 1 },
    (_, index) => `fixtures/reference-${index}.json`
  );
  const oversizedResult = validate(oversized);
  assert.equal(oversizedResult.ok, false);
  assert.ok(
    oversizedResult.issues.includes(
      `mandatoryFixtures:exceeds_max_items:${MAX_MANDATORY_READS_PER_LIST + 1}:${MAX_MANDATORY_READS_PER_LIST}`
    )
  );
});

test('Draft 2020-12 schema enforces bounded exact mandatory reads', () => {
  assert.equal(
    validateWorkerSchema(validContract()),
    true,
    JSON.stringify(validateWorkerSchema.errors)
  );
  const mutations = [
    (contract) => contract.mandatoryDocs.push('docs/research/hosted-web'),
    (contract) => {
      contract.mandatoryScripts = ['docs/research/hosted-web/**/*.json'];
    },
    (contract) => {
      contract.mandatoryFixtures = Array.from(
        { length: MAX_MANDATORY_READS_PER_LIST + 1 },
        (_, index) => `fixtures/reference-${index}.json`
      );
    },
    (contract) => {
      contract.mandatoryDocs = contract.mandatoryDocs.filter(
        (item) => item !== 'docs/hosted-web-phases/EXECUTION_INDEX.json'
      );
    },
  ];

  for (const mutate of mutations) {
    const contract = validContract();
    mutate(contract);
    assert.equal(validateWorkerSchema(contract), false);
  }
});

test('rejects the blocked Phase 1 proposal as worker authority', () => {
  const contract = validContract();
  contract.phaseId = 'phase-01';
  contract.packetRevision = 'phase-01-r1';
  contract.controllerPacket = 'docs/hosted-web-phases/phase-01/controller-packet.md';
  contract.lanePacket = 'docs/hosted-web-phases/phase-01/packet-inputs.md';
  contract.workKey = computeWorkKey(contract);
  const result = validate(contract);
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('phaseId:not_authorized:phase-01'));
  assert.ok(
    result.issues.includes(
      'controllerPacket:not_authoritative:docs/hosted-web-phases/phase-01/controller-packet.md'
    )
  );
});

function temporaryContractFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'hosted-web-worker-contract-'));
  for (const relativePath of [
    'AGENTS.md',
    'docs/hosted-web-phases/START_HERE.md',
    'docs/hosted-web-phases/EVIDENCE_LIFECYCLE.md',
    'docs/hosted-web-phases/README.md',
    'docs/hosted-web-phases/EXECUTION_INDEX.json',
    'docs/hosted-web-phase-0-execution-packet.md',
    'docs/hosted-web-phases/phase-00/lanes/w1-parity-renderer.md',
    'docs/research/hosted-web/phase-0/exact-reference.json',
    'fixtures/prompt.md',
    'fixtures/input.json',
    'fixtures/required-script.mjs',
  ]) {
    const absolutePath = path.join(root, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, 'fixture\n');
  }
  const contract = validContract();
  contract.jobRoot = root;
  contract.promptPath = path.join(root, 'fixtures/prompt.md');
  contract.mandatoryDocs = [
    ...contract.mandatoryDocs.filter((item) => !item.includes('test/architecture/')),
  ];
  contract.mandatoryScripts = ['fixtures/required-script.mjs'];
  contract.mandatoryFixtures = ['fixtures/input.json'];
  contract.requiredChecks = [{ id: 'fixture', cwd: 'fixtures', command: 'node --test check.mjs' }];
  contract.executionPolicy.sandboxRoot = path.join(root, 'fixtures');
  return { contract, root };
}

test('accepts an exact research file listed by the lane packet', (t) => {
  const { contract, root } = temporaryContractFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const exactReference = 'docs/research/hosted-web/phase-0/exact-reference.json';
  contract.mandatoryDocs.push(exactReference);
  writeFileSync(path.join(root, contract.lanePacket), `- \`${exactReference}\`\n`);
  const result = validate(contract, { checkGitHead: false });
  assert.deepEqual(result, { ok: true, issues: [] });
});

test('rejects a research file not listed by the lane packet', (t) => {
  const { contract, root } = temporaryContractFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const exactReference = 'docs/research/hosted-web/phase-0/exact-reference.json';
  contract.mandatoryDocs.push(exactReference);
  const result = validate(contract, { checkGitHead: false });
  assert.equal(result.ok, false);
  assert.ok(
    result.issues.includes(`mandatoryReads:research_reference_not_in_lane_packet:${exactReference}`)
  );
});

test('rejects an existing directory as a recursive mandatory read', (t) => {
  const { contract, root } = temporaryContractFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  contract.mandatoryFixtures = ['fixtures'];
  const result = validate(contract, { checkGitHead: false });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.startsWith('mandatoryFixtures:not_file:')));
});

test('rejects a symlink whose resolved target is a directory where a file is mandatory', (t) => {
  const { contract, root } = temporaryContractFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'fixtures/script-directory'));
  symlinkSync('script-directory', path.join(root, 'fixtures/script-link'));
  contract.mandatoryScripts = ['fixtures/script-link'];
  const result = validate(contract, { checkGitHead: false });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.startsWith('mandatoryScripts:not_file:')));
});

test('rejects a symlink whose resolved target is a file where a directory is mandatory', (t) => {
  const { contract, root } = temporaryContractFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  symlinkSync('required-script.mjs', path.join(root, 'fixtures/check-cwd-link'));
  contract.requiredChecks[0].cwd = 'fixtures/check-cwd-link';
  const result = validate(contract, { checkGitHead: false });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.startsWith('requiredChecks:cwd:not_directory:')));
});
