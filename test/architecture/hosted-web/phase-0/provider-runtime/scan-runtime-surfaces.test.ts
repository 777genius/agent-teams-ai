import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  discoverEnvironmentKeys,
  type EnvironmentSemanticsFixture,
  type ProviderModeIngressFixture,
  type ProviderRuntimeRoutingObservation,
  resolvePerKeyEnvironmentEvidence,
  scanRepository,
  type SurfaceFixture,
  validateArtifactDocument,
  validateCredentialExposureLinks,
  validateEnvironmentCompleteness,
  validateEnvironmentSemanticsFixture,
  validateFakeRuntimeMatrix,
  validatePerKeyEnvironmentEvidenceCoverage,
  validateProviderModeIngressFixture,
  validateProviderRuntimeRoutingSemantics,
  validateSurfaceFixture,
} from '../../../../../scripts/hosted-web/phase-0/provider-runtime/scan-runtime-surfaces';

const WORKTREE_ROOT = process.cwd();
const EVIDENCE_ROOT = 'docs/research/hosted-web/phase-0/provider-runtime';
const FIXTURE_ROOT = 'test/architecture/hosted-web/phase-0/provider-runtime/fixtures';
let root = '';
type JsonRecord = Record<string, unknown>;

interface HistoricalSourceFile {
  path: string;
  tokens: string[];
  environmentKeys: string[];
  environmentPrefixes: string[];
}

interface HistoricalSourceSnapshot {
  schemaVersion: number;
  historicalCommit: string;
  canonicalBaseSha: string;
  sourceFiles: HistoricalSourceFile[];
  routingObservations: ProviderRuntimeRoutingObservation[];
}

const historicalSourceSnapshot = JSON.parse(
  readFileSync(resolve(WORKTREE_ROOT, FIXTURE_ROOT, 'historical-source-snapshot.json'), 'utf8')
) as HistoricalSourceSnapshot;

function materializeHistoricalSourceFile(file: HistoricalSourceFile): void {
  const path = resolve(root, file.path);
  mkdirSync(dirname(path), { recursive: true });
  const lines = [
    ...file.tokens.map((token) => `// ${token}`),
    ...file.environmentKeys.map((key) => `process.env['${key}'];`),
  ];
  if (file.environmentPrefixes.length > 0) {
    lines.push(
      `const HISTORICAL_ENV_PREFIXES = ${JSON.stringify(file.environmentPrefixes)} as const;`
    );
  }
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

function installHistoricalFixture(source: string, target: string): void {
  copyFileSync(
    resolve(WORKTREE_ROOT, FIXTURE_ROOT, 'historical', source),
    resolve(root, target)
  );
}

beforeAll(() => {
  root = mkdtempSync(resolve(tmpdir(), 'phase-00-w2-historical-source-'));
  historicalSourceSnapshot.sourceFiles.forEach(materializeHistoricalSourceFile);
  cpSync(resolve(WORKTREE_ROOT, EVIDENCE_ROOT), resolve(root, EVIDENCE_ROOT), {
    recursive: true,
  });
  cpSync(resolve(WORKTREE_ROOT, FIXTURE_ROOT), resolve(root, FIXTURE_ROOT), {
    recursive: true,
  });
  installHistoricalFixture(
    'evidence/execution-topology.json',
    `${EVIDENCE_ROOT}/execution-topology.json`
  );
  installHistoricalFixture(
    'evidence/runtime-ingress-inventory.json',
    `${EVIDENCE_ROOT}/runtime-ingress-inventory.json`
  );
  installHistoricalFixture(
    'schemas/execution-topology.schema.json',
    `${EVIDENCE_ROOT}/schemas/execution-topology.schema.json`
  );
  installHistoricalFixture(
    'schemas/runtime-ingress-inventory.schema.json',
    `${EVIDENCE_ROOT}/schemas/runtime-ingress-inventory.schema.json`
  );
  installHistoricalFixture(
    'surfaces-positive.json',
    `${FIXTURE_ROOT}/surfaces-positive.json`
  );
  installHistoricalFixture(
    'provider-mode-ingress-positive.json',
    `${FIXTURE_ROOT}/provider-mode-ingress-positive.json`
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function readJson(path: string): JsonRecord {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8')) as JsonRecord;
}

function artifact(name: string): JsonRecord {
  return readJson(`${EVIDENCE_ROOT}/${name}`);
}

function fixture(name: string): SurfaceFixture {
  return readJson(
    `${FIXTURE_ROOT}/${name}`
  ) as unknown as SurfaceFixture;
}

function providerModeFixture(name: string): ProviderModeIngressFixture {
  return readJson(
    `${FIXTURE_ROOT}/${name}`
  ) as unknown as ProviderModeIngressFixture;
}

function environmentSemanticsFixture(): EnvironmentSemanticsFixture {
  return readJson(
    `${FIXTURE_ROOT}/environment-semantics.json`
  ) as unknown as EnvironmentSemanticsFixture;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

const WORKSPACE_TRUST_PROHIBITIONS = [
  'CLAUDE_TEAM_ANTHROPIC_AUTH_MODE_API_KEY_HELPER',
  'AGENT_TEAMS_RUNTIME_TURN_SETTLED_*',
  'AGENT_TEAMS_MCP_*',
  'CLAUDE_TEAM_BOOTSTRAP_*',
] as const;
const WORKSPACE_TRUST_ENV_PATH =
  'src/features/workspace-trust/main/infrastructure/workspaceTrustPreflightEnv.ts';

describe('Phase 0 W2 runtime surface scanner', () => {
  it('binds the deterministic source snapshot to the reviewed historical freeze', () => {
    expect(historicalSourceSnapshot.schemaVersion).toBe(1);
    expect(historicalSourceSnapshot.historicalCommit).toBe(
      '6d54e7c60d29812de5b96e471761486fbbc0842c'
    );
    expect(historicalSourceSnapshot.canonicalBaseSha).toBe(
      environmentSemanticsFixture().canonicalBaseSha
    );
    expect(new Set(historicalSourceSnapshot.sourceFiles.map((file) => file.path)).size).toBe(
      historicalSourceSnapshot.sourceFiles.length
    );
  });

  it('accepts the complete unique surface fixture', () => {
    expect(validateSurfaceFixture(fixture('surfaces-positive.json'))).toEqual([]);
  });

  it('rejects a missing and duplicated route', () => {
    expect(validateSurfaceFixture(fixture('surfaces-negative.json'))).toEqual(
      expect.arrayContaining([
        expect.stringContaining('duplicate'),
        expect.stringContaining('missing /api/teams/:teamName/opencode/runtime/heartbeat'),
      ])
    );
  });

  it('rejects every missing runtime-ingress operation field family', () => {
    const fields = [
      'operation',
      'commandKind',
      'currentRoute',
      'direction',
      'caller',
      'currentAuthority',
      'idempotency',
      'bodyIds',
      'persistedEvidence',
      'targetDisposition',
      'source',
    ];
    for (const field of fields) {
      const document = clone(artifact('runtime-ingress-inventory.json'));
      delete (document.records as JsonRecord[])[0][field];
      expect(
        validateArtifactDocument(root, 'runtime-ingress-inventory.json', document).join('\n')
      ).toContain(`missing required ${field}`);
    }
  });

  it('rejects missing environment discovery/classification fields and every omitted source key', () => {
    const document = clone(artifact('environment-provenance.json'));
    const row = (document.records as JsonRecord[])[1];
    delete row.provenance;
    expect(
      validateArtifactDocument(root, 'environment-provenance.json', document).join('\n')
    ).toContain('missing required provenance');

    const invalidClass = clone(artifact('environment-provenance.json'));
    (invalidClass.records as JsonRecord[])[1].classification = 'ambient';
    expect(
      validateArtifactDocument(root, 'environment-provenance.json', invalidClass).join('\n')
    ).toContain('violates enum');

    const environment = artifact('environment-provenance.json');
    const discovered = discoverEnvironmentKeys(root);
    const rows = environment.records as JsonRecord[];
    const sourceClassifiedKeys = rows
      .filter((candidate) => candidate.discoveryDisposition === 'source_discovered')
      .flatMap((candidate) => candidate.keys as string[]);
    expect([...discovered.keys()].sort()).toEqual([...sourceClassifiedKeys].sort());
    const explicitKeys = rows
      .filter((candidate) =>
        ['source_discovered', 'fixture_bound'].includes(String(candidate.discoveryDisposition))
      )
      .flatMap((candidate) => candidate.keys as string[]);
    for (const key of explicitKeys) {
      const omitted = clone(environment);
      const omittedRow = (omitted.records as JsonRecord[]).find((candidate) =>
        (candidate.keys as string[]).includes(key)
      );
      if (!omittedRow) throw new Error(`missing environment fixture row for ${key}`);
      omittedRow.keys = (omittedRow.keys as string[]).filter((candidate) => candidate !== key);
      expect(validatePerKeyEnvironmentEvidenceCoverage(omitted).join('\n')).toContain(key);
    }
  });

  it('rejects omission of the workspace-trust provider-child sanitizer from the census', () => {
    const environment = artifact('environment-provenance.json');
    const discovered = discoverEnvironmentKeys(root);
    for (const policy of WORKSPACE_TRUST_PROHIBITIONS) {
      expect(discovered.get(policy)).toContain(WORKSPACE_TRUST_ENV_PATH);
    }

    const withoutWorkspaceTrust = new Map(
      [...discovered.entries()]
        .map(
          ([key, paths]) =>
            [key, paths.filter((path) => path !== WORKSPACE_TRUST_ENV_PATH)] as const
        )
        .filter(([, paths]) => paths.length > 0)
    );
    const errors = validateEnvironmentCompleteness(root, environment, withoutWorkspaceTrust).join(
      '\n'
    );
    for (const policy of WORKSPACE_TRUST_PROHIBITIONS) {
      expect(errors).toContain(`classified key has no source occurrence ${policy}`);
    }
  });

  it('rejects omission of each workspace-trust exact and prefix prohibition', () => {
    const environment = artifact('environment-provenance.json');
    for (const policy of WORKSPACE_TRUST_PROHIBITIONS) {
      const omitted = clone(environment);
      const row = (omitted.records as JsonRecord[]).find((candidate) =>
        (candidate.keys as string[]).includes(policy)
      );
      if (!row) throw new Error(`missing workspace-trust policy row for ${policy}`);
      row.keys = (row.keys as string[]).filter((candidate) => candidate !== policy);
      expect(validateEnvironmentCompleteness(root, omitted).join('\n')).toContain(
        `discovered unclassified key ${policy}`
      );
    }
  });

  it('rejects unknown top-level and nested fields in every evidence schema', () => {
    const artifacts = [
      'execution-topology.json',
      'runtime-ingress-inventory.json',
      'environment-provenance.json',
      'credential-exposure-matrix.json',
      'fake-runtime-fixture-matrix.json',
      'estimate-input.json',
    ];
    for (const name of artifacts) {
      const topLevel = clone(artifact(name));
      topLevel.unreviewedField = true;
      expect(validateArtifactDocument(root, name, topLevel).join('\n')).toContain(
        'unknown property unreviewedField'
      );

      const nested = clone(artifact(name));
      const nestedTarget =
        name === 'runtime-ingress-inventory.json'
          ? (nested.trustSurfaceProof as JsonRecord)
          : name === 'environment-provenance.json'
            ? (nested.sourceDiscovery as JsonRecord)
            : name === 'credential-exposure-matrix.json'
              ? (nested.canonicalOwnership as JsonRecord)
              : name === 'estimate-input.json'
                ? ((nested.ranges as JsonRecord).productionLines as JsonRecord)
                : (nested.records as JsonRecord[])[0];
      nestedTarget.unreviewedField = true;
      expect(validateArtifactDocument(root, name, nested).join('\n')).toContain(
        'unknown property unreviewedField'
      );
    }
  });

  it('rejects missing credential exposure and ownership fields', () => {
    const document = clone(artifact('credential-exposure-matrix.json'));
    delete (document.records as JsonRecord[])[0].targetRule;
    expect(
      validateArtifactDocument(root, 'credential-exposure-matrix.json', document).join('\n')
    ).toContain('missing required targetRule');
    const ownership = clone(artifact('credential-exposure-matrix.json'));
    delete (ownership.canonicalOwnership as JsonRecord).runtimeIngress;
    expect(
      validateArtifactDocument(root, 'credential-exposure-matrix.json', ownership).join('\n')
    ).toContain('missing required runtimeIngress');
  });

  it('proves every per-key provenance field and exact credential exposure link', () => {
    const environment = artifact('environment-provenance.json');
    const credentialMatrix = artifact('credential-exposure-matrix.json');
    expect(validateCredentialExposureLinks(root, environment, credentialMatrix)).toEqual([]);

    const requiredFields = [
      'sourceClass',
      'owner',
      'platformScope',
      'executionUnitIds',
      'providerBindings',
      'credentialExposureSetIds',
      'secretClass',
      'childVisibility',
      'redactionRule',
      'claimStatus',
      'semanticRole',
    ];
    for (const field of requiredFields) {
      const missing = clone(environment);
      delete ((missing.keyPolicyProfiles as JsonRecord[])[0] as JsonRecord)[field];
      expect(
        validateArtifactDocument(root, 'environment-provenance.json', missing).join('\n')
      ).toContain(`missing required ${field}`);
    }

    const emptyAssignedBindings = clone(environment);
    const assignedProfile = (emptyAssignedBindings.keyPolicyProfiles as JsonRecord[]).find(
      (candidate) => candidate.id === 'kp-31'
    );
    if (!assignedProfile) throw new Error('missing assigned provider routing profile');
    assignedProfile.providerBindings = [];
    expect(
      validateArtifactDocument(root, 'environment-provenance.json', emptyAssignedBindings).join(
        '\n'
      )
    ).toContain('below minItems');

    const implicitProviderless = clone(environment);
    const providerlessProfile = (implicitProviderless.keyPolicyProfiles as JsonRecord[]).find(
      (candidate) => candidate.id === 'kp-22'
    );
    if (!providerlessProfile) throw new Error('missing providerless target prohibition');
    delete providerlessProfile.providerlessProhibition;
    expect(
      validateArtifactDocument(root, 'environment-provenance.json', implicitProviderless).join('\n')
    ).toContain('oneOf');

    for (let fieldIndex = 0; fieldIndex < 4; fieldIndex += 1) {
      const missingTupleField = clone(environment);
      const table = missingTupleField.keyEvidence as JsonRecord;
      const firstRow = (table.rows as unknown[][])[0];
      if (!firstRow) throw new Error('missing per-key evidence row');
      firstRow.splice(fieldIndex, 1);
      expect(
        validateArtifactDocument(root, 'environment-provenance.json', missingTupleField).join('\n')
      ).toContain('below minItems');
    }

    for (const entry of resolvePerKeyEnvironmentEvidence(environment)) {
      const omitted = clone(environment);
      const table = omitted.keyEvidence as JsonRecord;
      table.rows = (table.rows as unknown[][]).filter(
        (candidate) => String(candidate[0]) !== entry.key
      );
      expect(validatePerKeyEnvironmentEvidenceCoverage(omitted).join('\n')).toContain(
        String(entry.key)
      );
    }

    const brokenMembership = clone(credentialMatrix);
    const firstSet = (brokenMembership.exposureSets as JsonRecord[])[0];
    firstSet.memberKeyEvidenceIds = (firstSet.memberKeyEvidenceIds as string[]).slice(1);
    expect(
      validateCredentialExposureLinks(root, environment, brokenMembership).join('\n')
    ).toContain('credential exposure key membership');
  });

  it('validates the frozen provider-routing observations and rejects drift', () => {
    const observations = historicalSourceSnapshot.routingObservations.map((observation) => ({
      key: observation.key,
      providerId: observation.providerId,
      backendFamily: observation.backendFamily,
      runtimeBackend: observation.runtimeBackend,
      targetDisposition: observation.targetDisposition,
      emissionDisposition: observation.emissionDisposition,
    }));
    expect(
      validateProviderRuntimeRoutingSemantics(artifact('environment-provenance.json'), observations)
    ).toEqual([]);

    const drifted = clone(observations);
    drifted[0].targetDisposition =
      drifted[0].targetDisposition === 'required' ? 'forbidden' : 'required';
    expect(
      validateProviderRuntimeRoutingSemantics(
        artifact('environment-provenance.json'),
        drifted
      ).join('\n')
    ).toContain('wrong source-derived bindings');

    expect(
      validateProviderRuntimeRoutingSemantics(
        artifact('environment-provenance.json'),
        observations.slice(1)
      ).join('\n')
    ).toContain('provider routing source observations: missing');
  });

  it('binds every fake-runtime row to canonical seams and addressable proof tests', () => {
    const matrix = artifact('fake-runtime-fixture-matrix.json');
    expect(validateFakeRuntimeMatrix(root, matrix)).toEqual([]);

    const arbitraryProse = clone(matrix);
    const firstProof = (arbitraryProse.records as JsonRecord[])[0].executableProof as JsonRecord;
    firstProof.authority = {
      path: 'docs/hosted-web-e2e-completion-plan.md',
      token: 'provider/agent process receives',
    };
    expect(validateFakeRuntimeMatrix(root, arbitraryProse).join('\n')).toContain(
      'wrong canonical seam binding'
    );

    const missingCaseTest = clone(matrix);
    const secondProof = (missingCaseTest.records as JsonRecord[])[1].executableProof as JsonRecord;
    secondProof.positiveTestId = 'w2.fake-runtime.not-a-real-case.positive';
    expect(validateFakeRuntimeMatrix(root, missingCaseTest).join('\n')).toContain(
      'wrong positive test id'
    );
  });

  it('rejects every wrong per-key semantic dimension against source-bound expectations', () => {
    const environment = artifact('environment-provenance.json');
    const fixture = environmentSemanticsFixture();
    expect(validateEnvironmentSemanticsFixture(root, environment, fixture)).toEqual([]);

    const profile = (document: JsonRecord, id: string): JsonRecord => {
      const match = (document.keyPolicyProfiles as JsonRecord[]).find(
        (candidate) => candidate.id === id
      );
      if (!match) throw new Error(`missing profile ${id}`);
      return match;
    };
    const mutations: Array<[string, (document: JsonRecord) => void]> = [
      [
        'provider/backend/disposition bindings',
        (document) => {
          const binding = (profile(document, 'kp-28').providerBindings as JsonRecord[])[0];
          binding.providerId = 'anthropic';
        },
      ],
      [
        'provider/backend/disposition bindings',
        (document) => {
          const binding = (profile(document, 'kp-28').providerBindings as JsonRecord[])[0];
          binding.backendFamily = 'invented_noncanonical_backend';
        },
      ],
      [
        'provider/backend/disposition bindings',
        (document) => {
          const binding = (profile(document, 'kp-28').providerBindings as JsonRecord[])[0];
          binding.targetDisposition = 'optional';
        },
      ],
      ['platform', (document) => (profile(document, 'kp-28').platformScope = 'windows_only')],
      [
        'child visibility',
        (document) => (profile(document, 'kp-28').childVisibility = 'absent_current_and_target'),
      ],
      [
        'credential exposure',
        (document) =>
          (profile(document, 'kp-28').credentialExposureSetIds = ['ces-runtime-metadata']),
      ],
      [
        'semantic role',
        (document) => (profile(document, 'kp-28').semanticRole = 'emitted_child_key'),
      ],
      [
        'policy profile',
        (document) => {
          const table = document.keyEvidence as JsonRecord;
          const row = (table.rows as unknown[][]).find(
            (candidate) => candidate[0] === 'CLAUDE_TEAM_OPENCODE_ALLOW_AUTOUPDATE'
          );
          if (!row) throw new Error('missing auto-update policy row');
          row[2] = 'kp-27';
        },
      ],
    ];
    for (const [expectedError, mutate] of mutations) {
      const invalid = clone(environment);
      mutate(invalid);
      expect(validateEnvironmentSemanticsFixture(root, invalid, fixture).join('\n')).toContain(
        expectedError
      );
    }

    const invalidBackend = clone(environment);
    const binding = (profile(invalidBackend, 'kp-28').providerBindings as JsonRecord[])[0];
    binding.backendFamily = 'invented_noncanonical_backend';
    expect(
      validateArtifactDocument(root, 'environment-provenance.json', invalidBackend).join('\n')
    ).toContain('violates enum');
  });

  it('rejects incomplete provider cases and estimate bucket fields', () => {
    const matrix = clone(artifact('fake-runtime-fixture-matrix.json'));
    delete (matrix.records as JsonRecord[])[7].negativeControl;
    expect(
      validateArtifactDocument(root, 'fake-runtime-fixture-matrix.json', matrix).join('\n')
    ).toContain('missing required negativeControl');

    const estimate = clone(artifact('estimate-input.json'));
    estimate.canonicalBucketId = 'runtime-ingress-relay-and-protocol';
    expect(validateArtifactDocument(root, 'estimate-input.json', estimate).join('\n')).toContain(
      'violates const'
    );
    delete ((estimate.ranges as JsonRecord).productionLines as JsonRecord).low;
    expect(validateArtifactDocument(root, 'estimate-input.json', estimate).join('\n')).toContain(
      'missing required low'
    );
  });

  it('proves independently sourced provider/mode/operation dispositions', () => {
    const positive = providerModeFixture('provider-mode-ingress-positive.json');
    expect(validateProviderModeIngressFixture(root, positive)).toEqual([]);

    for (const disposition of positive.dispositions) {
      const omitted = clone(positive);
      omitted.dispositions = omitted.dispositions.filter(
        (candidate) =>
          candidate.provider !== disposition.provider || candidate.mode !== disposition.mode
      );
      expect(validateProviderModeIngressFixture(root, omitted).join('\n')).toContain(
        `missing ${disposition.provider}:${disposition.mode}`
      );
    }

    const negative = providerModeFixture('provider-mode-ingress-negative.json');
    const errors = validateProviderModeIngressFixture(root, negative).join('\n');
    expect(errors).toContain('duplicate anthropic:primary_only');
    expect(errors).toContain('anthropic:primary_only: operations: unexpected runtime.heartbeat');
    expect(errors).toContain(
      'opencode:pure_opencode: operations: missing runtime.permission-answer'
    );
    expect(errors).toContain('stale authority');
  });

  it('rejects a topology record with no provider compatibility', () => {
    const document = clone(artifact('execution-topology.json'));
    delete (document.records as JsonRecord[])[0].compatibility;
    expect(
      validateArtifactDocument(root, 'execution-topology.json', document).join('\n')
    ).toContain('violates anyOf');
  });

  it('matches the deterministic historical source snapshot and W2 evidence', () => {
    expect(scanRepository(root)).toEqual([]);
  });
});
