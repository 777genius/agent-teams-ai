import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  type EnvironmentSemanticsFixture,
  type ProviderModeIngressFixture,
  resolvePerKeyEnvironmentEvidence,
  type SurfaceFixture,
  validateArtifactDocument,
  validateCredentialExposureLinks,
  validateEnvironmentSemanticsFixture,
  validateFakeRuntimeMatrix,
  validatePerKeyEnvironmentEvidenceCoverage,
  validateProviderModeIngressFixture,
  validateSurfaceFixture,
} from '../../../../../scripts/hosted-web/phase-0/provider-runtime/scan-runtime-surfaces';

const ROOT = process.cwd();
const EVIDENCE_ROOT = 'docs/research/hosted-web/phase-0/provider-runtime';
const ARTIFACT_NAMES = [
  'execution-topology.json',
  'runtime-ingress-inventory.json',
  'environment-provenance.json',
  'credential-exposure-matrix.json',
  'fake-runtime-fixture-matrix.json',
  'estimate-input.json',
] as const;
type JsonRecord = Record<string, unknown>;

function readJson(path: string): JsonRecord {
  return JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) as JsonRecord;
}

function artifact(name: string): JsonRecord {
  return readJson(`${EVIDENCE_ROOT}/${name}`);
}

function fixture(name: string): SurfaceFixture {
  return readJson(
    `test/architecture/hosted-web/phase-0/provider-runtime/fixtures/${name}`
  ) as unknown as SurfaceFixture;
}

function providerModeFixture(name: string): ProviderModeIngressFixture {
  return readJson(
    `test/architecture/hosted-web/phase-0/provider-runtime/fixtures/${name}`
  ) as unknown as ProviderModeIngressFixture;
}

function environmentSemanticsFixture(): EnvironmentSemanticsFixture {
  return readJson(
    'test/architecture/hosted-web/phase-0/provider-runtime/fixtures/environment-semantics.json'
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
const HISTORICAL_SURFACE_FIXTURE: SurfaceFixture = {
  routes: [
    '/api/teams/:teamName/opencode/runtime/bootstrap-checkin',
    '/api/teams/:teamName/opencode/runtime/deliver-message',
    '/api/teams/:teamName/opencode/runtime/task-event',
    '/api/teams/:teamName/opencode/runtime/heartbeat',
    '/api/teams/:teamName/opencode/runtime/permission-answer',
  ],
  commands: [
    'runtime.bootstrap-checkin',
    'runtime.deliver-message',
    'runtime.task-event',
    'runtime.heartbeat',
    'runtime.permission-answer',
  ],
  providers: ['anthropic', 'codex', 'gemini', 'opencode'],
  modes: [
    'primary_only',
    'pure_opencode',
    'pure_opencode_solo',
    'pure_opencode_worktree_root_lanes',
    'mixed_opencode_side_lanes',
    'unsupported_opencode_led_mixed_team',
  ],
};

function createHistoricalFixtureRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'phase0-w2-historical-'));
  const files = new Map<string, string>();
  const add = (path: string, content: string): void => {
    files.set(path, `${files.get(path) ?? ''}${content}\n`);
  };

  add('README.md', 'Installation');

  for (const name of ARTIFACT_NAMES) {
    add(`${EVIDENCE_ROOT}/${name}`, JSON.stringify(artifact(name)));
  }

  const environmentFixture = environmentSemanticsFixture();
  for (const entry of environmentFixture.entries) add(entry.authority.path, entry.authority.token);

  const providerMode = providerModeFixture('provider-mode-ingress-positive.json');
  for (const disposition of providerMode.dispositions) {
    for (const authority of disposition.authorityRefs) add(authority.path, authority.token);
  }

  const matrix = artifact('fake-runtime-fixture-matrix.json');
  for (const row of matrix.records as JsonRecord[]) {
    const proof = row.executableProof as JsonRecord;
    const authority = proof.authority as JsonRecord;
    add(String(authority.path), String(authority.token));
    add(String(proof.testFile), `it('${String(proof.positiveTestId)}'`);
    add(String(proof.testFile), `it('${String(proof.failingNegativeTestId)}'`);
  }

  const credentialMatrix = artifact('credential-exposure-matrix.json');
  for (const set of credentialMatrix.exposureSets as JsonRecord[]) {
    add(String(set.provenanceArtifact), 'historical provenance artifact');
    add(String(set.probeTest).split('#')[0], 'historical probe test');
  }
  for (const unit of credentialMatrix.records as JsonRecord[]) {
    add(String(unit.source), 'historical source');
    add(String(unit.probeTest), 'historical probe test');
  }

  for (const [path, content] of files) {
    const absolutePath = resolve(root, path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
  }
  return root;
}

const HISTORICAL_FIXTURE_ROOT = createHistoricalFixtureRoot();
afterAll(() => rmSync(HISTORICAL_FIXTURE_ROOT, { recursive: true, force: true }));

describe('Phase 0 W2 runtime surface scanner', () => {
  it('accepts the complete unique historical surface fixture', () => {
    expect(validateSurfaceFixture(HISTORICAL_SURFACE_FIXTURE)).toEqual([]);
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
        validateArtifactDocument(ROOT, 'runtime-ingress-inventory.json', document).join('\n')
      ).toContain(`missing required ${field}`);
    }
  });

  it('rejects missing environment discovery/classification fields and every omitted source key', () => {
    const document = clone(artifact('environment-provenance.json'));
    const row = (document.records as JsonRecord[])[1];
    delete row.provenance;
    expect(
      validateArtifactDocument(ROOT, 'environment-provenance.json', document).join('\n')
    ).toContain('missing required provenance');

    const invalidClass = clone(artifact('environment-provenance.json'));
    (invalidClass.records as JsonRecord[])[1].classification = 'ambient';
    expect(
      validateArtifactDocument(ROOT, 'environment-provenance.json', invalidClass).join('\n')
    ).toContain('violates enum');

    const environment = artifact('environment-provenance.json');
    const rows = environment.records as JsonRecord[];
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
    const withoutWorkspaceTrust = clone(environment);
    withoutWorkspaceTrust.records = (withoutWorkspaceTrust.records as JsonRecord[]).filter(
      (row) => row.source !== WORKSPACE_TRUST_ENV_PATH
    );
    const errors = validatePerKeyEnvironmentEvidenceCoverage(withoutWorkspaceTrust).join('\n');
    for (const policy of WORKSPACE_TRUST_PROHIBITIONS) {
      expect(errors).toContain(policy);
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
      expect(validatePerKeyEnvironmentEvidenceCoverage(omitted).join('\n')).toContain(policy);
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
      expect(validateArtifactDocument(ROOT, name, topLevel).join('\n')).toContain(
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
      expect(validateArtifactDocument(ROOT, name, nested).join('\n')).toContain(
        'unknown property unreviewedField'
      );
    }
  });

  it('rejects missing credential exposure and ownership fields', () => {
    const document = clone(artifact('credential-exposure-matrix.json'));
    delete (document.records as JsonRecord[])[0].targetRule;
    expect(
      validateArtifactDocument(ROOT, 'credential-exposure-matrix.json', document).join('\n')
    ).toContain('missing required targetRule');
    const ownership = clone(artifact('credential-exposure-matrix.json'));
    delete (ownership.canonicalOwnership as JsonRecord).runtimeIngress;
    expect(
      validateArtifactDocument(ROOT, 'credential-exposure-matrix.json', ownership).join('\n')
    ).toContain('missing required runtimeIngress');
  });

  it('proves every per-key provenance field and exact credential exposure link', () => {
    const environment = artifact('environment-provenance.json');
    const credentialMatrix = artifact('credential-exposure-matrix.json');
    expect(
      validateCredentialExposureLinks(HISTORICAL_FIXTURE_ROOT, environment, credentialMatrix)
    ).toEqual([]);

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
        validateArtifactDocument(ROOT, 'environment-provenance.json', missing).join('\n')
      ).toContain(`missing required ${field}`);
    }

    const emptyAssignedBindings = clone(environment);
    const assignedProfile = (emptyAssignedBindings.keyPolicyProfiles as JsonRecord[]).find(
      (candidate) => candidate.id === 'kp-31'
    );
    if (!assignedProfile) throw new Error('missing assigned provider routing profile');
    assignedProfile.providerBindings = [];
    expect(
      validateArtifactDocument(ROOT, 'environment-provenance.json', emptyAssignedBindings).join(
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
      validateArtifactDocument(ROOT, 'environment-provenance.json', implicitProviderless).join('\n')
    ).toContain('oneOf');

    for (let fieldIndex = 0; fieldIndex < 4; fieldIndex += 1) {
      const missingTupleField = clone(environment);
      const table = missingTupleField.keyEvidence as JsonRecord;
      const firstRow = (table.rows as unknown[][])[0];
      if (!firstRow) throw new Error('missing per-key evidence row');
      firstRow.splice(fieldIndex, 1);
      expect(
        validateArtifactDocument(ROOT, 'environment-provenance.json', missingTupleField).join('\n')
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
      validateCredentialExposureLinks(HISTORICAL_FIXTURE_ROOT, environment, brokenMembership).join(
        '\n'
      )
    ).toContain('credential exposure key membership');
  });

  it('binds every fake-runtime row to canonical seams and addressable proof tests', () => {
    const matrix = artifact('fake-runtime-fixture-matrix.json');
    expect(validateFakeRuntimeMatrix(HISTORICAL_FIXTURE_ROOT, matrix)).toEqual([]);

    const arbitraryProse = clone(matrix);
    const firstProof = (arbitraryProse.records as JsonRecord[])[0].executableProof as JsonRecord;
    firstProof.authority = { path: 'README.md', token: 'Installation' };
    expect(validateFakeRuntimeMatrix(HISTORICAL_FIXTURE_ROOT, arbitraryProse).join('\n')).toContain(
      'wrong canonical seam binding'
    );

    const missingCaseTest = clone(matrix);
    const secondProof = (missingCaseTest.records as JsonRecord[])[1].executableProof as JsonRecord;
    secondProof.positiveTestId = 'w2.fake-runtime.not-a-real-case.positive';
    expect(
      validateFakeRuntimeMatrix(HISTORICAL_FIXTURE_ROOT, missingCaseTest).join('\n')
    ).toContain('wrong positive test id');
  });

  it('rejects every wrong per-key semantic dimension against source-bound expectations', () => {
    const environment = artifact('environment-provenance.json');
    const fixture = environmentSemanticsFixture();
    expect(
      validateEnvironmentSemanticsFixture(HISTORICAL_FIXTURE_ROOT, environment, fixture)
    ).toEqual([]);

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
      expect(
        validateEnvironmentSemanticsFixture(HISTORICAL_FIXTURE_ROOT, invalid, fixture).join('\n')
      ).toContain(expectedError);
    }

    const invalidBackend = clone(environment);
    const binding = (profile(invalidBackend, 'kp-28').providerBindings as JsonRecord[])[0];
    binding.backendFamily = 'invented_noncanonical_backend';
    expect(
      validateArtifactDocument(ROOT, 'environment-provenance.json', invalidBackend).join('\n')
    ).toContain('violates enum');
  });

  it('rejects incomplete provider cases and estimate bucket fields', () => {
    const matrix = clone(artifact('fake-runtime-fixture-matrix.json'));
    delete (matrix.records as JsonRecord[])[7].negativeControl;
    expect(
      validateArtifactDocument(ROOT, 'fake-runtime-fixture-matrix.json', matrix).join('\n')
    ).toContain('missing required negativeControl');

    const estimate = clone(artifact('estimate-input.json'));
    estimate.canonicalBucketId = 'runtime-ingress-relay-and-protocol';
    expect(validateArtifactDocument(ROOT, 'estimate-input.json', estimate).join('\n')).toContain(
      'violates const'
    );
    delete ((estimate.ranges as JsonRecord).productionLines as JsonRecord).low;
    expect(validateArtifactDocument(ROOT, 'estimate-input.json', estimate).join('\n')).toContain(
      'missing required low'
    );
  });

  it('proves independently sourced provider/mode/operation dispositions', () => {
    const positive = providerModeFixture('provider-mode-ingress-positive.json');
    expect(validateProviderModeIngressFixture(HISTORICAL_FIXTURE_ROOT, positive)).toEqual([]);

    for (const disposition of positive.dispositions) {
      const omitted = clone(positive);
      omitted.dispositions = omitted.dispositions.filter(
        (candidate) =>
          candidate.provider !== disposition.provider || candidate.mode !== disposition.mode
      );
      expect(
        validateProviderModeIngressFixture(HISTORICAL_FIXTURE_ROOT, omitted).join('\n')
      ).toContain(`missing ${disposition.provider}:${disposition.mode}`);
    }

    const negative = providerModeFixture('provider-mode-ingress-negative.json');
    const errors = validateProviderModeIngressFixture(HISTORICAL_FIXTURE_ROOT, negative).join('\n');
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
      validateArtifactDocument(ROOT, 'execution-topology.json', document).join('\n')
    ).toContain('violates anyOf');
  });

  it('accepts every checked-in W2 evidence schema without rescanning mutable HEAD', () => {
    for (const name of ARTIFACT_NAMES) {
      expect(validateArtifactDocument(ROOT, name, artifact(name))).toEqual([]);
    }
  });
});
