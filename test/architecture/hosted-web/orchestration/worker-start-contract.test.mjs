import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  PHASE_AUTHORITY_CATALOG,
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

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' });
  } catch (error) {
    if (error.status === 0 && typeof error.stdout === 'string') return error.stdout;
    throw error;
  }
}

const sourceHead = git(repoRoot, ['rev-parse', 'HEAD']).trim();
const defaultJobRoot = mkdtempSync(path.join(tmpdir(), 'hosted-web-worker-job-'));
writeFileSync(path.join(defaultJobRoot, 'worker-prompt.md'), 'bounded worker prompt\n');
process.on('exit', () => rmSync(defaultJobRoot, { recursive: true, force: true }));

function validContract() {
  const template = JSON.parse(
    readFileSync(templatePath, 'utf8')
      .replaceAll('$JOB_ROOT', defaultJobRoot)
      .replaceAll('$WORKSPACE_ROOT', repoRoot)
      .replaceAll('$PHASE_START_SHA', sourceHead)
  );
  template.workKey = computeWorkKey(template);
  return template;
}

function setAuthority(contract, phaseId, laneId, packetRevision) {
  const authority = PHASE_AUTHORITY_CATALOG[phaseId];
  const priorPackets = new Set([contract.controllerPacket, contract.lanePacket]);
  contract.mandatoryDocs = contract.mandatoryDocs.filter((item) => !priorPackets.has(item));
  contract.phaseId = phaseId;
  contract.laneId = laneId;
  contract.packetRevision = packetRevision;
  contract.controllerPacket = authority.controllerPacket;
  contract.lanePacket = authority.lanes[laneId];
  contract.mandatoryDocs.push(contract.controllerPacket, contract.lanePacket);
  contract.workKey = computeWorkKey(contract);
  return contract;
}

function validate(contract, options = {}) {
  return validateWorkerStartContract(contract, { gitHead: sourceHead, ...options });
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

test('runtime and schema preserve every exact Phase 0 lane and revision authority', () => {
  const authority = PHASE_AUTHORITY_CATALOG['phase-00'];
  for (const revision of authority.packetRevisions) {
    for (const laneId of Object.keys(authority.lanes)) {
      const contract = setAuthority(validContract(), 'phase-00', laneId, revision);
      assert.deepEqual(validate(contract), { ok: true, issues: [] }, `${revision}/${laneId}`);
      assert.equal(
        validateWorkerSchema(contract),
        true,
        `${revision}/${laneId}: ${JSON.stringify(validateWorkerSchema.errors)}`
      );
    }
  }
});

test('runtime and schema authorize only the exact P1.S0 bootstrap authority', () => {
  const contract = setAuthority(validContract(), 'phase-01', 'p1-s0', 'phase-01-s0-bootstrap-r1');
  assert.deepEqual(validate(contract), { ok: true, issues: [] });
  assert.equal(validateWorkerSchema(contract), true, JSON.stringify(validateWorkerSchema.errors));
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
  assert.ok(result.issues.some((issue) => issue.startsWith('workspaceRoot:git_head_expected:')));
});

test('requires workspaceRoot as an absolute broker root', () => {
  for (const workspaceRoot of [undefined, 'relative/workspace']) {
    const contract = validContract();
    if (workspaceRoot === undefined) delete contract.workspaceRoot;
    else contract.workspaceRoot = workspaceRoot;
    const result = validate(contract, { checkFilesystem: false });
    assert.equal(result.ok, false);
    assert.ok(result.issues.includes('workspaceRoot:absolute_path_required'));
    assert.equal(validateWorkerSchema(contract), false);
  }
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

test('rejects a prompt in the workspace and a sandbox in the job root', () => {
  const contract = validContract();
  contract.promptPath = path.join(repoRoot, 'AGENTS.md');
  contract.executionPolicy.sandboxRoot = defaultJobRoot;
  const result = validate(contract);
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('promptPath:outside_jobRoot'));
  assert.ok(result.issues.includes('promptPath:inside_workspaceRoot'));
  assert.ok(result.issues.includes('executionPolicy:sandboxRoot_overlaps_jobRoot'));
  assert.ok(result.issues.includes('executionPolicy:sandboxRoot_outside_workspaceRoot'));
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
  assert.ok(result.issues.includes(`workspaceRoot:forbidden_real_project:${repoRoot}`));
  assert.ok(
    result.issues.includes(`executionPolicy:sandboxRoot:forbidden_real_project:${repoRoot}`)
  );
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

test('runtime and schema reject authority cross-products and P1.S1', () => {
  const p1 = setAuthority(validContract(), 'phase-01', 'p1-s0', 'phase-01-s0-bootstrap-r1');
  const cases = [
    {
      name: 'Phase 1 with Phase 0 controller',
      mutate(contract) {
        contract.controllerPacket = PHASE_AUTHORITY_CATALOG['phase-00'].controllerPacket;
      },
      runtimeIssue: 'controllerPacket:not_authoritative_for_phase:phase-01:',
    },
    {
      name: 'Phase 1 with Phase 0 lane',
      mutate(contract) {
        contract.laneId = 'w1';
        contract.lanePacket = PHASE_AUTHORITY_CATALOG['phase-00'].lanes.w1;
      },
      runtimeIssue: 'laneId:not_authorized_for_phase:phase-01:w1',
    },
    {
      name: 'Phase 1 with Phase 0 revision',
      mutate(contract) {
        contract.packetRevision = 'phase-00-r2';
      },
      runtimeIssue: 'packetRevision:not_authorized_for_phase:phase-01:phase-00-r2',
    },
    {
      name: 'blocked P1.S1 lane',
      mutate(contract) {
        contract.laneId = 'p1-s1';
        contract.lanePacket = 'docs/hosted-web-phases/phase-01/lanes/p1-s1-foundations.md';
      },
      runtimeIssue: 'laneId:not_authorized_for_phase:phase-01:p1-s1',
    },
    {
      name: 'blocked P1.S1 revision',
      mutate(contract) {
        contract.packetRevision = 'phase-01-s1-foundations-r1';
      },
      runtimeIssue: 'packetRevision:not_authorized_for_phase:phase-01:phase-01-s1-foundations-r1',
    },
    {
      name: 'Phase 0 with Phase 1 controller',
      base: 'phase-00',
      mutate(contract) {
        contract.controllerPacket = PHASE_AUTHORITY_CATALOG['phase-01'].controllerPacket;
      },
      runtimeIssue: 'controllerPacket:not_authoritative_for_phase:phase-00:',
    },
    {
      name: 'Phase 0 with Phase 1 lane',
      base: 'phase-00',
      mutate(contract) {
        contract.laneId = 'p1-s0';
        contract.lanePacket = PHASE_AUTHORITY_CATALOG['phase-01'].lanes['p1-s0'];
      },
      runtimeIssue: 'laneId:not_authorized_for_phase:phase-00:p1-s0',
    },
    {
      name: 'Phase 0 with Phase 1 revision',
      base: 'phase-00',
      mutate(contract) {
        contract.packetRevision = 'phase-01-s0-bootstrap-r1';
      },
      runtimeIssue: 'packetRevision:not_authorized_for_phase:phase-00:phase-01-s0-bootstrap-r1',
    },
  ];

  for (const testCase of cases) {
    const contract = JSON.parse(
      JSON.stringify(testCase.base === 'phase-00' ? validContract() : p1)
    );
    testCase.mutate(contract);
    contract.workKey = computeWorkKey(contract);
    const result = validate(contract, { checkFilesystem: false });
    assert.equal(result.ok, false, testCase.name);
    assert.ok(
      result.issues.some((issue) => issue.startsWith(testCase.runtimeIssue)),
      `${testCase.name}: ${result.issues.join('\n')}`
    );
    assert.equal(validateWorkerSchema(contract), false, testCase.name);
  }
});

function temporaryContractFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'hosted-web-worker-contract-'));
  const jobRoot = path.join(root, 'job');
  const workspaceRoot = path.join(root, 'workspace');
  mkdirSync(jobRoot);
  mkdirSync(workspaceRoot);
  writeFileSync(path.join(jobRoot, 'worker-prompt.md'), 'bounded worker prompt\n');
  for (const relativePath of [
    'AGENTS.md',
    'docs/hosted-web-phases/START_HERE.md',
    'docs/hosted-web-phases/EVIDENCE_LIFECYCLE.md',
    'docs/hosted-web-phases/README.md',
    'docs/hosted-web-phases/EXECUTION_INDEX.json',
    'docs/hosted-web-phase-0-execution-packet.md',
    'docs/hosted-web-phases/phase-00/lanes/w1-parity-renderer.md',
    'docs/research/hosted-web/phase-0/exact-reference.json',
    'fixtures/input.json',
    'fixtures/required-script.mjs',
  ]) {
    const absolutePath = path.join(workspaceRoot, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, 'fixture\n');
  }
  git(workspaceRoot, ['init', '--quiet']);
  git(workspaceRoot, ['add', '.']);
  git(workspaceRoot, [
    '-c',
    'user.name=Hosted Web Test',
    '-c',
    'user.email=hosted-web-test@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  const phaseStartSha = git(workspaceRoot, ['rev-parse', 'HEAD']).trim();
  const contract = validContract();
  contract.jobRoot = jobRoot;
  contract.workspaceRoot = workspaceRoot;
  contract.promptPath = path.join(jobRoot, 'worker-prompt.md');
  contract.phaseStartSha = phaseStartSha;
  contract.mandatoryDocs = [
    ...contract.mandatoryDocs.filter((item) => !item.includes('test/architecture/')),
  ];
  contract.mandatoryScripts = ['fixtures/required-script.mjs'];
  contract.mandatoryFixtures = ['fixtures/input.json'];
  contract.requiredChecks = [{ id: 'fixture', cwd: 'fixtures', command: 'node --test check.mjs' }];
  contract.executionPolicy.sandboxRoot = path.join(workspaceRoot, 'fixtures');
  contract.workKey = computeWorkKey(contract);
  return { contract, jobRoot, root, workspaceRoot };
}

test('accepts separate runtime job and prompt roots with a Git workspace root', (t) => {
  const { contract, root } = temporaryContractFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(validateWorkerStartContract(contract), { ok: true, issues: [] });
});

test('rejects a prompt inside the Git workspace', (t) => {
  const { contract, root, workspaceRoot } = temporaryContractFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  contract.promptPath = path.join(workspaceRoot, 'AGENTS.md');
  const result = validateWorkerStartContract(contract);
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('promptPath:inside_workspaceRoot'));
});

test('rejects a sandbox rooted in the runtime job directory', (t) => {
  const { contract, jobRoot, root } = temporaryContractFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  contract.executionPolicy.sandboxRoot = jobRoot;
  const result = validateWorkerStartContract(contract);
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('executionPolicy:sandboxRoot_overlaps_jobRoot'));
  assert.ok(result.issues.includes('executionPolicy:sandboxRoot_outside_workspaceRoot'));
});

test('rejects overlapping job and workspace roots', (t) => {
  const { contract, root, workspaceRoot } = temporaryContractFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  contract.jobRoot = workspaceRoot;
  contract.promptPath = path.join(workspaceRoot, 'AGENTS.md');
  const result = validateWorkerStartContract(contract);
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('roots:jobRoot_workspaceRoot_must_not_overlap'));
});

test('rejects a phase start SHA that differs from workspace Git HEAD', (t) => {
  const { contract, root } = temporaryContractFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  contract.phaseStartSha = '0'.repeat(40);
  contract.workKey = computeWorkKey(contract);
  const result = validateWorkerStartContract(contract);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.startsWith('workspaceRoot:git_head_expected:')));
});

test('rejects a repository mandatory read that escapes the workspace', (t) => {
  const { contract, root, workspaceRoot } = temporaryContractFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'outside.json'), '{}\n');
  symlinkSync('../../outside.json', path.join(workspaceRoot, 'fixtures/read-escape.json'));
  contract.mandatoryFixtures = ['fixtures/read-escape.json'];
  const result = validateWorkerStartContract(contract);
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('mandatoryFixtures:symlink_escape:fixtures/read-escape.json'));
});

test('accepts an exact research file listed by the lane packet', (t) => {
  const { contract, root, workspaceRoot } = temporaryContractFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const exactReference = 'docs/research/hosted-web/phase-0/exact-reference.json';
  contract.mandatoryDocs.push(exactReference);
  writeFileSync(path.join(workspaceRoot, contract.lanePacket), `- \`${exactReference}\`\n`);
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
  const { contract, root, workspaceRoot } = temporaryContractFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(workspaceRoot, 'fixtures/script-directory'));
  symlinkSync('script-directory', path.join(workspaceRoot, 'fixtures/script-link'));
  contract.mandatoryScripts = ['fixtures/script-link'];
  const result = validate(contract, { checkGitHead: false });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.startsWith('mandatoryScripts:not_file:')));
});

test('rejects a symlink whose resolved target is a file where a directory is mandatory', (t) => {
  const { contract, root, workspaceRoot } = temporaryContractFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  symlinkSync('required-script.mjs', path.join(workspaceRoot, 'fixtures/check-cwd-link'));
  contract.requiredChecks[0].cwd = 'fixtures/check-cwd-link';
  const result = validate(contract, { checkGitHead: false });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.startsWith('requiredChecks:cwd:not_directory:')));
});
