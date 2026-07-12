import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  applyConfiguredRuntimeBackendsEnv,
  applyProviderRuntimeEnv,
} from '@main/services/runtime/providerRuntimeEnv';
import {
  buildProvisioningEnv,
  type TeamProvisioningEnvBuilderPorts,
} from '@main/services/team/provisioning/TeamProvisioningEnvBuilder';
import { describe, expect, it } from 'vitest';

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
  validateEnvironmentSemanticsFixture,
  validateFakeRuntimeMatrix,
  validatePerKeyEnvironmentEvidenceCoverage,
  validateProviderModeIngressFixture,
  validateProviderRuntimeRoutingSemantics,
  validateSurfaceFixture,
} from '../../../../../scripts/hosted-web/phase-0/provider-runtime/scan-runtime-surfaces';

import type { ProviderAwareCliEnvOptions } from '@main/services/runtime/providerAwareCliEnv';

const ROOT = process.cwd();
const EVIDENCE_ROOT = 'docs/research/hosted-web/phase-0/provider-runtime';
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

const ROUTING_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_ENTRY_PROVIDER',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_CODEX_BACKEND',
  'CLAUDE_CODE_GEMINI_BACKEND',
] as const;

const ROUTING_SCENARIOS = [
  { providerId: 'anthropic', runtimeBackend: 'anthropic_default' },
  { providerId: 'anthropic', runtimeBackend: 'anthropic_bedrock' },
  { providerId: 'anthropic', runtimeBackend: 'anthropic_vertex' },
  { providerId: 'anthropic', runtimeBackend: 'anthropic_foundry' },
  { providerId: 'anthropic', runtimeBackend: 'anthropic_claude_platform_aws' },
  { providerId: 'codex', runtimeBackend: 'codex_configured' },
  { providerId: 'gemini', runtimeBackend: 'gemini_configured' },
] as const;

function routingProvisioningPorts(customConfig: boolean): TeamProvisioningEnvBuilderPorts {
  return {
    providerConnectionService: {
      augmentConfiguredConnectionEnv: async (env) => env,
      getConfiguredAnthropicApiKeyForTeamRuntime: async () => null,
    },
    buildRuntimeTurnSettledEnvironment: async () => ({}),
    resolveControlApiBaseUrl: async () => null,
    logger: { warn: () => undefined, error: () => undefined },
    processEnv: { PATH: '/usr/bin', SHELL: '/bin/sh', USER: 'fixture-user' },
    platform: 'linux',
    resolveInteractiveShellEnvBestEffort: async () => ({ PATH: '/usr/bin', SHELL: '/bin/sh' }),
    getHomeDir: () => '/fixture/home',
    getClaudeBasePath: () => (customConfig ? '/fixture/custom-claude' : '/fixture/home/.claude'),
    getAutoDetectedClaudeBasePath: () => '/fixture/home/.claude',
    getOsUsername: () => 'fixture-user',
    buildProviderAwareCliEnv: async (options: ProviderAwareCliEnvOptions = {}) => ({
      env: options.env ?? {},
      connectionIssues: {},
      providerArgs: [],
    }),
    prepareAgentChildProcessWritableEnv: async () => ({ applied: false }),
    resolveGeminiRuntimeAuth: async () => ({
      authenticated: false,
      authMethod: null,
      resolvedBackend: 'auto',
      projectId: null,
      statusMessage: 'fixture-no-auth',
    }),
  };
}

async function observeProviderRuntimeRouting(): Promise<ProviderRuntimeRoutingObservation[]> {
  const observations: ProviderRuntimeRoutingObservation[] = [];
  for (const scenario of ROUTING_SCENARIOS) {
    const custom = await buildProvisioningEnv({
      providerId: scenario.providerId,
      ports: routingProvisioningPorts(true),
    });
    const defaults = await buildProvisioningEnv({
      providerId: scenario.providerId,
      ports: routingProvisioningPorts(false),
    });
    expect(custom.env.CLAUDE_CONFIG_DIR).toBe('/fixture/custom-claude');
    expect(defaults.env.CLAUDE_CONFIG_DIR).toBeUndefined();

    const env: NodeJS.ProcessEnv = {
      CLAUDE_CONFIG_DIR: custom.env.CLAUDE_CONFIG_DIR,
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: 'legacy',
      CLAUDE_CODE_ENTRY_PROVIDER: 'legacy',
      CLAUDE_CODE_USE_OPENAI: 'legacy',
      CLAUDE_CODE_USE_GEMINI: 'legacy',
      CLAUDE_CODE_CODEX_BACKEND: 'legacy',
      CLAUDE_CODE_GEMINI_BACKEND: 'legacy',
    };
    if (scenario.runtimeBackend === 'anthropic_bedrock') env.CLAUDE_CODE_USE_BEDROCK = '1';
    if (scenario.runtimeBackend === 'anthropic_vertex') env.CLAUDE_CODE_USE_VERTEX = '1';
    if (scenario.runtimeBackend === 'anthropic_foundry') env.CLAUDE_CODE_USE_FOUNDRY = '1';
    if (scenario.runtimeBackend === 'anthropic_claude_platform_aws') {
      env.ANTHROPIC_AWS_WORKSPACE_ID = 'fixture-workspace';
    }
    applyConfiguredRuntimeBackendsEnv(env, {
      providerBackends: { codex: 'fixture-codex', gemini: 'fixture-gemini' },
    } as Parameters<typeof applyConfiguredRuntimeBackendsEnv>[1]);
    applyProviderRuntimeEnv(env, scenario.providerId);

    for (const key of ROUTING_KEYS) {
      const emitted = env[key] !== undefined;
      const isConfig = key === 'CLAUDE_CONFIG_DIR';
      const isPin =
        key === 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST' || key === 'CLAUDE_CODE_ENTRY_PROVIDER';
      const isConfiguredBackend =
        key === 'CLAUDE_CODE_CODEX_BACKEND' || key === 'CLAUDE_CODE_GEMINI_BACKEND';
      const isBackendFlag = [
        'CLAUDE_CODE_USE_BEDROCK',
        'CLAUDE_CODE_USE_VERTEX',
        'CLAUDE_CODE_USE_FOUNDRY',
      ].includes(key);
      observations.push({
        key,
        providerId: scenario.providerId,
        backendFamily: 'provisioning_cli_primary',
        runtimeBackend: scenario.runtimeBackend,
        targetDisposition:
          isConfig || (isBackendFlag && emitted) ? 'optional' : emitted ? 'required' : 'forbidden',
        emissionDisposition: isConfig
          ? 'preserved_when_custom_configuration'
          : isPin
            ? 'emitted_always'
            : isConfiguredBackend
              ? 'emitted_configured_backend'
              : isBackendFlag && emitted
                ? 'emitted_when_backend_selected'
                : 'removed_before_spawn',
      });
    }
  }
  const dirtyNonAnthropicEnv: NodeJS.ProcessEnv = {
    CLAUDE_CODE_USE_OPENAI: '1',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CODE_USE_FOUNDRY: '1',
    CLAUDE_CODE_USE_GEMINI: '1',
  };
  applyProviderRuntimeEnv(dirtyNonAnthropicEnv, 'codex');
  for (const key of [
    'CLAUDE_CODE_USE_OPENAI',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_GEMINI',
  ]) {
    expect(dirtyNonAnthropicEnv[key]).toBeUndefined();
  }
  return observations;
}

describe('Phase 0 W2 runtime surface scanner', () => {
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
    const discovered = discoverEnvironmentKeys(ROOT);
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
    expect(validateCredentialExposureLinks(ROOT, environment, credentialMatrix)).toEqual([]);

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
      validateCredentialExposureLinks(ROOT, environment, brokenMembership).join('\n')
    ).toContain('credential exposure key membership');
  });

  it('w2.environment.provider-routing.source-seam', async () => {
    const observations = await observeProviderRuntimeRouting();
    expect(
      validateProviderRuntimeRoutingSemantics(artifact('environment-provenance.json'), observations)
    ).toEqual([]);
  });

  it('binds every fake-runtime row to canonical seams and addressable proof tests', () => {
    const matrix = artifact('fake-runtime-fixture-matrix.json');
    expect(validateFakeRuntimeMatrix(ROOT, matrix)).toEqual([]);

    const arbitraryProse = clone(matrix);
    const firstProof = (arbitraryProse.records as JsonRecord[])[0].executableProof as JsonRecord;
    firstProof.authority = { path: 'README.md', token: 'Installation' };
    expect(validateFakeRuntimeMatrix(ROOT, arbitraryProse).join('\n')).toContain(
      'wrong canonical seam binding'
    );

    const missingCaseTest = clone(matrix);
    const secondProof = (missingCaseTest.records as JsonRecord[])[1].executableProof as JsonRecord;
    secondProof.positiveTestId = 'w2.fake-runtime.not-a-real-case.positive';
    expect(validateFakeRuntimeMatrix(ROOT, missingCaseTest).join('\n')).toContain(
      'wrong positive test id'
    );
  });

  it('rejects every wrong per-key semantic dimension against source-bound expectations', () => {
    const environment = artifact('environment-provenance.json');
    const fixture = environmentSemanticsFixture();
    expect(validateEnvironmentSemanticsFixture(ROOT, environment, fixture)).toEqual([]);

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
      expect(validateEnvironmentSemanticsFixture(ROOT, invalid, fixture).join('\n')).toContain(
        expectedError
      );
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
    expect(validateProviderModeIngressFixture(ROOT, positive)).toEqual([]);

    for (const disposition of positive.dispositions) {
      const omitted = clone(positive);
      omitted.dispositions = omitted.dispositions.filter(
        (candidate) =>
          candidate.provider !== disposition.provider || candidate.mode !== disposition.mode
      );
      expect(validateProviderModeIngressFixture(ROOT, omitted).join('\n')).toContain(
        `missing ${disposition.provider}:${disposition.mode}`
      );
    }

    const negative = providerModeFixture('provider-mode-ingress-negative.json');
    const errors = validateProviderModeIngressFixture(ROOT, negative).join('\n');
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

  it('matches pinned source and all checked-in W2 evidence', () => {
    expect(scanRepository(ROOT)).toEqual([]);
  });
});
