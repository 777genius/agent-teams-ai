import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  compareSet,
  compareUnique,
  EVIDENCE_ROOT,
  EXPECTED_FAKE_RUNTIME_SEAMS,
  EXPECTED_MATRIX_CASES,
  PHASE_START_SHA,
  PROVIDER_RUNTIME_ROUTING_KEYS,
  readJson,
  type EnvironmentSemanticsFixture,
  type JsonRecord,
  type ProviderModeIngressFixture,
  type ProviderRuntimeRoutingObservation,
} from './provider-runtime-shared';

export function validatePerKeyEnvironmentEvidenceCoverage(document: JsonRecord): string[] {
  const classified = (document.records as JsonRecord[]).flatMap(
    (row) => (row.keys as string[]) ?? []
  );
  const keyEvidence = resolvePerKeyEnvironmentEvidence(document);
  return [
    ...compareSet(
      'per-key environment evidence',
      keyEvidence.map((entry) => String(entry.key)),
      classified
    ),
    ...compareUnique(
      'per-key environment evidence ids',
      keyEvidence.map((entry) => String(entry.id))
    ),
  ];
}

export function resolvePerKeyEnvironmentEvidence(document: JsonRecord): JsonRecord[] {
  const profiles = document.keyPolicyProfiles as JsonRecord[];
  const profileById = new Map(profiles.map((profile) => [String(profile.id), profile]));
  const groupById = new Map(
    (document.records as JsonRecord[]).map((group) => [String(group.id), group])
  );
  const table = document.keyEvidence as JsonRecord;
  const paths = table.probePaths as JsonRecord[];
  const pathById = new Map(paths.map((entry) => [String(entry.id), String(entry.path)]));
  return (table.rows as unknown[][]).map((row) => {
    const [key, groupId, policyProfileId, probePathId] = row.map(String);
    const profile = profileById.get(policyProfileId) ?? {};
    const group = groupById.get(groupId) ?? {};
    const sourceClass = String(profile.sourceClass);
    const exactKeyProbe = ['production_source_census', 'checked_fixture_binding'].includes(
      sourceClass
    );
    const targetProbe = sourceClass === 'target_contract_prohibition';
    return {
      ...profile,
      id: `env-key:${key}`,
      key,
      groupId,
      policyProfileId,
      probe: {
        kind: exactKeyProbe
          ? sourceClass === 'production_source_census'
            ? 'source_census'
            : 'fixture_binding'
          : targetProbe
            ? 'target_contract'
            : 'source_anchor',
        path: pathById.get(probePathId) ?? '',
        token: exactKeyProbe
          ? key.endsWith('*')
            ? key.slice(0, -1)
            : key
          : String(group.sourceToken ?? ''),
        assertion: exactKeyProbe
          ? 'path_contains_exact_key'
          : targetProbe
            ? 'contract_contains_prohibition'
            : 'source_contains_anchor',
      },
    };
  });
}

export function validateCredentialExposureLinks(
  root: string,
  environment: JsonRecord,
  credentialMatrix: JsonRecord
): string[] {
  const errors: string[] = [];
  const keys = resolvePerKeyEnvironmentEvidence(environment);
  const sets = credentialMatrix.exposureSets as JsonRecord[];
  errors.push(
    ...compareUnique(
      'credential exposure set ids',
      sets.map((set) => String(set.id))
    )
  );
  const memberships = new Map<string, string[]>();
  for (const set of sets) {
    const setId = String(set.id);
    readFileSync(resolve(root, String(set.provenanceArtifact)), 'utf8');
    readFileSync(resolve(root, String(set.probeTest).split('#')[0]), 'utf8');
    for (const keyId of set.memberKeyEvidenceIds as string[]) {
      const current = memberships.get(keyId) ?? [];
      current.push(setId);
      memberships.set(keyId, current);
    }
  }
  errors.push(
    ...compareSet(
      'credential exposure key membership',
      [...memberships.keys()],
      keys.map((entry) => String(entry.id))
    )
  );
  for (const key of keys) {
    const keyId = String(key.id);
    const declared = key.credentialExposureSetIds as string[];
    const linked = memberships.get(keyId) ?? [];
    errors.push(...compareSet(`credential exposure membership ${keyId}`, linked, declared));
  }
  const units = credentialMatrix.records as JsonRecord[];
  const knownSets = new Set(sets.map((set) => String(set.id)));
  for (const unit of units) {
    readFileSync(resolve(root, String(unit.source)), 'utf8');
    readFileSync(resolve(root, String(unit.probeTest)), 'utf8');
    for (const setId of unit.exposureSetIds as string[])
      if (!knownSets.has(setId))
        errors.push(`credential-exposure-matrix.json: unknown set ${setId} on ${String(unit.id)}`);
  }
  return errors;
}

export function validateFakeRuntimeMatrix(root: string, matrix: JsonRecord): string[] {
  const errors: string[] = [];
  errors.push(
    ...compareSet(
      'fake-runtime cases',
      (matrix.records as JsonRecord[]).map((row) => String(row.case)),
      EXPECTED_MATRIX_CASES
    )
  );
  for (const row of matrix.records as JsonRecord[]) {
    const caseName = String(row.case);
    const expectedSeam =
      EXPECTED_FAKE_RUNTIME_SEAMS[caseName as (typeof EXPECTED_MATRIX_CASES)[number]];
    const proof = row.executableProof as JsonRecord;
    const authority = proof.authority as JsonRecord;
    const authorityPath = String(authority.path);
    const authorityToken = String(authority.token);
    const authoritySource = readFileSync(resolve(root, authorityPath), 'utf8');
    if (!authoritySource.includes(authorityToken)) {
      errors.push(
        `fake-runtime ${caseName}: stale canonical seam ${authorityPath}#${authorityToken}`
      );
    }
    if (
      !expectedSeam ||
      proof.seam !== expectedSeam.seam ||
      authorityPath !== expectedSeam.path ||
      authorityToken !== expectedSeam.token
    ) {
      errors.push(`fake-runtime ${caseName}: wrong canonical seam binding`);
    }
    if (proof.runner !== 'vitest_canonical_runtime_seams_v1') {
      errors.push(`fake-runtime ${caseName}: wrong runner`);
    }
    const expectedPositive = `w2.fake-runtime.${caseName}.positive`;
    const expectedNegative = `w2.fake-runtime.${caseName}.failing-negative`;
    if (proof.positiveTestId !== expectedPositive) {
      errors.push(`fake-runtime ${caseName}: wrong positive test id`);
    }
    if (proof.failingNegativeTestId !== expectedNegative) {
      errors.push(`fake-runtime ${caseName}: wrong failing-negative test id`);
    }
    const testFile = String(proof.testFile);
    const testSource = readFileSync(resolve(root, testFile), 'utf8');
    for (const testId of [expectedPositive, expectedNegative]) {
      if (!testSource.includes(`it('${testId}'`)) {
        errors.push(`fake-runtime ${caseName}: missing independently addressable test ${testId}`);
      }
    }
    if (row.proofLevel !== 'fixture_characterized') {
      errors.push(`fake-runtime ${caseName}: unproved rows must remain explicit_gap`);
    }
  }
  return errors;
}

export function validateEnvironmentSemanticsFixture(
  root: string,
  environment: JsonRecord,
  fixture: EnvironmentSemanticsFixture
): string[] {
  const errors: string[] = [];
  if (fixture.schemaVersion !== 2)
    errors.push('environment semantics fixture: wrong schemaVersion');
  if (fixture.canonicalBaseSha !== PHASE_START_SHA) {
    errors.push('environment semantics fixture: wrong canonicalBaseSha');
  }
  const resolved = resolvePerKeyEnvironmentEvidence(environment);
  errors.push(
    ...compareSet(
      'environment semantics delegated executable keys',
      fixture.delegatedExecutableSemantics.keys,
      PROVIDER_RUNTIME_ROUTING_KEYS
    ),
    ...compareSet(
      'environment semantics delegated authority paths',
      fixture.delegatedExecutableSemantics.authorityPaths,
      [
        'src/main/services/runtime/providerRuntimeEnv.ts',
        'src/main/services/runtime/buildRuntimeBaseEnv.ts',
        'src/main/services/team/provisioning/TeamProvisioningEnvBuilder.ts',
      ]
    )
  );
  if (
    fixture.delegatedExecutableSemantics.proofTestId !==
    'w2.environment.provider-routing.source-seam'
  ) {
    errors.push('environment semantics fixture: wrong delegated executable proof test');
  }
  const fixtureResolved = resolved.filter(
    (entry) => !PROVIDER_RUNTIME_ROUTING_KEYS.includes(String(entry.key) as never)
  );
  errors.push(
    ...compareSet(
      'environment semantics keys',
      fixture.entries.map((entry) => entry.key),
      fixtureResolved.map((entry) => String(entry.key))
    )
  );
  const expectedByKey = new Map(fixture.entries.map((entry) => [entry.key, entry]));
  for (const actual of fixtureResolved) {
    const key = String(actual.key);
    const expected = expectedByKey.get(key);
    if (!expected) continue;
    const actualBindings = (actual.providerBindings as JsonRecord[]).map((binding) => ({
      providerId: String(binding.providerId),
      backendFamily: String(binding.backendFamily),
      targetDisposition: String(binding.targetDisposition),
    }));
    const dimensions: Array<[string, unknown, unknown]> = [
      ['policy profile', actual.policyProfileId, expected.policyProfileId],
      ['semantic role', actual.semanticRole, expected.semanticRole],
      ['provider/backend/disposition bindings', actualBindings, expected.providerBindings],
      ['platform', actual.platformScope, expected.platformScope],
      ['child visibility', actual.childVisibility, expected.childVisibility],
      [
        'providerless prohibition',
        actual.providerlessProhibition,
        expected.providerlessProhibition,
      ],
      [
        'credential exposure',
        (actual.credentialExposureSetIds as string[])[0],
        expected.credentialExposureSetId,
      ],
      ['authority path', (actual.probe as JsonRecord).path, expected.authority.path],
      ['authority token', (actual.probe as JsonRecord).token, expected.authority.token],
    ];
    for (const [label, actualValue, expectedValue] of dimensions) {
      if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
        errors.push(`environment semantics ${key}: wrong ${label}`);
      }
    }
    const source = readFileSync(resolve(root, expected.authority.path), 'utf8');
    if (!source.includes(expected.authority.token)) {
      errors.push(
        `environment semantics ${key}: stale source authority ${expected.authority.path}#${expected.authority.token}`
      );
    }
  }
  return errors;
}

export function validateProviderRuntimeRoutingSemantics(
  environment: JsonRecord,
  observations: ProviderRuntimeRoutingObservation[]
): string[] {
  const errors: string[] = [];
  const scenarioIds = observations.map(
    (row) => `${row.key}:${row.providerId}:${row.runtimeBackend}`
  );
  const expectedScenarioIds = PROVIDER_RUNTIME_ROUTING_KEYS.flatMap((key) =>
    [
      ['anthropic', 'anthropic_default'],
      ['anthropic', 'anthropic_bedrock'],
      ['anthropic', 'anthropic_vertex'],
      ['anthropic', 'anthropic_foundry'],
      ['anthropic', 'anthropic_claude_platform_aws'],
      ['codex', 'codex_configured'],
      ['gemini', 'gemini_configured'],
    ].map(([providerId, runtimeBackend]) => `${key}:${providerId}:${runtimeBackend}`)
  );
  errors.push(
    ...compareSet('provider routing source observations', scenarioIds, expectedScenarioIds)
  );

  const resolved = resolvePerKeyEnvironmentEvidence(environment);
  const byKey = new Map(resolved.map((entry) => [String(entry.key), entry]));
  const authorityPathByKey = new Map<string, string>([
    ['CLAUDE_CONFIG_DIR', 'src/main/services/team/provisioning/TeamProvisioningEnvBuilder.ts'],
    ['CLAUDE_CODE_CODEX_BACKEND', 'src/main/services/runtime/buildRuntimeBaseEnv.ts'],
    ['CLAUDE_CODE_GEMINI_BACKEND', 'src/main/services/runtime/buildRuntimeBaseEnv.ts'],
  ]);
  const expectedRoleByKey = new Map<string, string>([
    ['CLAUDE_CONFIG_DIR', 'selected_child_input'],
    ['CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'emitted_child_key'],
    ['CLAUDE_CODE_ENTRY_PROVIDER', 'emitted_child_key'],
    ['CLAUDE_CODE_USE_OPENAI', 'removed_child_key'],
    ['CLAUDE_CODE_USE_BEDROCK', 'host_policy_input_and_emitted_child_key'],
    ['CLAUDE_CODE_USE_VERTEX', 'host_policy_input_and_emitted_child_key'],
    ['CLAUDE_CODE_USE_FOUNDRY', 'host_policy_input_and_emitted_child_key'],
    ['CLAUDE_CODE_USE_GEMINI', 'removed_child_key'],
    ['CLAUDE_CODE_CODEX_BACKEND', 'emitted_child_key'],
    ['CLAUDE_CODE_GEMINI_BACKEND', 'emitted_child_key'],
  ]);

  for (const key of PROVIDER_RUNTIME_ROUTING_KEYS) {
    const actual = byKey.get(key);
    if (!actual) {
      errors.push(`provider routing semantics ${key}: missing per-key evidence`);
      continue;
    }
    const expectedBindings = observations
      .filter((row) => row.key === key)
      .map(({ key: _key, ...binding }) => binding);
    const actualBindings = (actual.providerBindings as JsonRecord[]).map((binding) => ({
      providerId: binding.providerId,
      backendFamily: binding.backendFamily,
      runtimeBackend: binding.runtimeBackend,
      targetDisposition: binding.targetDisposition,
      emissionDisposition: binding.emissionDisposition,
    }));
    if (JSON.stringify(actualBindings) !== JSON.stringify(expectedBindings)) {
      errors.push(`provider routing semantics ${key}: wrong source-derived bindings`);
    }
    const expectedRole = expectedRoleByKey.get(key);
    if (actual.semanticRole !== expectedRole) {
      errors.push(`provider routing semantics ${key}: wrong semantic role`);
    }
    const onlyRemoved = expectedBindings.every(
      (binding) => binding.emissionDisposition === 'removed_before_spawn'
    );
    const expectedVisibility = onlyRemoved
      ? 'absent_current_and_target'
      : 'provider_child_visible_when_selected';
    if (actual.childVisibility !== expectedVisibility) {
      errors.push(`provider routing semantics ${key}: wrong child visibility`);
    }
    const expectedAuthority =
      authorityPathByKey.get(key) ?? 'src/main/services/runtime/providerRuntimeEnv.ts';
    if ((actual.probe as JsonRecord).path !== expectedAuthority) {
      errors.push(`provider routing semantics ${key}: wrong source branch authority`);
    }
  }

  const profileGroups = [
    ['CLAUDE_CONFIG_DIR'],
    ['CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_ENTRY_PROVIDER'],
    ['CLAUDE_CODE_USE_OPENAI', 'CLAUDE_CODE_USE_GEMINI'],
    ['CLAUDE_CODE_USE_BEDROCK'],
    ['CLAUDE_CODE_USE_VERTEX'],
    ['CLAUDE_CODE_USE_FOUNDRY'],
    ['CLAUDE_CODE_CODEX_BACKEND', 'CLAUDE_CODE_GEMINI_BACKEND'],
  ];
  const groupProfileIds = profileGroups.map((keys) => {
    const ids = new Set(keys.map((key) => String(byKey.get(key)?.policyProfileId ?? '')));
    if (ids.size !== 1) errors.push(`provider routing profile group ${keys.join(',')}: split`);
    return [...ids][0];
  });
  errors.push(...compareUnique('provider routing behavior profile ids', groupProfileIds));
  return errors;
}

export function verifyFakeRuntimeProofExecution(root: string, matrix: JsonRecord): string[] {
  const records = matrix.records as JsonRecord[];
  const testFiles = [
    ...new Set(records.map((row) => String((row.executableProof as JsonRecord).testFile))),
  ];
  if (testFiles.length !== 1)
    return ['fake-runtime execution: matrix must bind one focused proof file'];
  const expectedTestIds = records.flatMap((row) => {
    const proof = row.executableProof as JsonRecord;
    return [String(proof.positiveTestId), String(proof.failingNegativeTestId)];
  });
  const outputDir = mkdtempSync(join(tmpdir(), 'phase-00-w2-proof-'));
  const outputFile = join(outputDir, 'vitest-results.json');
  try {
    const result = spawnSync(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        testFiles[0],
        '--reporter=json',
        `--outputFile=${outputFile}`,
        '--testNamePattern',
        'w2\\.fake-runtime\\.',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, W2_FAKE_RUNTIME_PROOF_CHILD: '1' },
      }
    );
    if (result.status !== 0) {
      return [
        `fake-runtime execution failed (exit ${String(result.status)}): ${(result.stderr || result.stdout).trim()}`,
      ];
    }
    const report = readJson(outputFile);
    const assertions = ((report.testResults as JsonRecord[]) ?? []).flatMap(
      (suite) => (suite.assertionResults as JsonRecord[]) ?? []
    );
    const passed = new Set(
      assertions
        .filter((assertion) => assertion.status === 'passed')
        .map((assertion) => String(assertion.title ?? assertion.fullName))
    );
    return compareSet('executed fake-runtime proof ids', [...passed], expectedTestIds);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

export function validateProviderModeIngressFixture(
  root: string,
  fixture: ProviderModeIngressFixture
): string[] {
  const topology = readJson(resolve(root, EVIDENCE_ROOT, 'execution-topology.json'));
  const ingress = readJson(resolve(root, EVIDENCE_ROOT, 'runtime-ingress-inventory.json'));
  const topologyRows = topology.records as JsonRecord[];
  const providers = topologyRows
    .filter((row) => typeof row.providerIdentity === 'string')
    .map((row) => String(row.providerIdentity));
  const opencodeModes = topologyRows
    .filter((row) => typeof row.mode === 'string' && String(row.mode).includes('opencode'))
    .flatMap((row) => String(row.mode).split('|'))
    .filter((mode) => mode !== 'unsupported_opencode_led_mixed_team');
  const expectedPairs = [
    ...providers
      .filter((provider) => provider !== 'opencode')
      .map((provider) => `${provider}:primary_only`),
    ...opencodeModes.map((mode) => `opencode:${mode}`),
  ];
  const actualPairs = fixture.dispositions.map((row) => `${row.provider}:${row.mode}`);
  const errors = compareSet('provider/mode dispositions', actualPairs, expectedPairs);
  const ingressOperations = (ingress.records as JsonRecord[]).map((row) => String(row.commandKind));
  for (const row of fixture.dispositions) {
    const isOpenCode = row.provider === 'opencode';
    const expectedDisposition = isOpenCode
      ? 'current_source_observed_runtime_ingress'
      : 'current_source_observed_no_runtime_ingress';
    if (row.disposition !== expectedDisposition)
      errors.push(`${row.provider}:${row.mode}: wrong disposition ${row.disposition}`);
    errors.push(
      ...compareSet(
        `${row.provider}:${row.mode}: operations`,
        row.operations,
        isOpenCode ? ingressOperations : []
      )
    );
    if (!row.targetStatus.includes('target-unverified'))
      errors.push(`${row.provider}:${row.mode}: target-unverified status missing`);
    if (row.authorityRefs.length === 0)
      errors.push(`${row.provider}:${row.mode}: no independent authority references`);
    for (const authority of row.authorityRefs) {
      const source = readFileSync(resolve(root, authority.path), 'utf8');
      if (!source.includes(authority.token))
        errors.push(
          `${row.provider}:${row.mode}: stale authority ${authority.path}#${authority.token}`
        );
    }
  }
  return errors;
}
