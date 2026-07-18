import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PHASE_START_SHA = 'c72fd201867b9bcd1ef77d5e0f95ba379adb4fca';
const EVIDENCE_ROOT = 'docs/research/hosted-web/phase-0/provider-runtime';

const ARTIFACTS = [
  'execution-topology.json',
  'runtime-ingress-inventory.json',
  'environment-provenance.json',
  'credential-exposure-matrix.json',
  'fake-runtime-fixture-matrix.json',
  'estimate-input.json',
] as const;

const EXPECTED_ROUTES = [
  '/api/teams/:teamName/opencode/runtime/bootstrap-checkin',
  '/api/teams/:teamName/opencode/runtime/deliver-message',
  '/api/teams/:teamName/opencode/runtime/task-event',
  '/api/teams/:teamName/opencode/runtime/heartbeat',
  '/api/teams/:teamName/opencode/runtime/permission-answer',
] as const;
const EXPECTED_COMMANDS = [
  'runtime.bootstrap-checkin',
  'runtime.deliver-message',
  'runtime.task-event',
  'runtime.heartbeat',
  'runtime.permission-answer',
] as const;
const EXPECTED_PROVIDERS = ['anthropic', 'codex', 'gemini', 'opencode'] as const;
const EXPECTED_MODES = [
  'primary_only',
  'pure_opencode',
  'pure_opencode_solo',
  'pure_opencode_member_lanes',
  'mixed_opencode_side_lanes',
  'unsupported_opencode_led_mixed_team',
] as const;
const EXPECTED_MATRIX_CASES = [
  'homogeneous_anthropic',
  'homogeneous_codex',
  'homogeneous_gemini',
  'homogeneous_opencode',
  'mixed_provider_team',
  'missing_runtime',
  'missing_auth',
  'unsupported_backend',
  'malformed_capability_response',
  'process_timeout',
  'partial_launch',
  'restart_adoption',
  'opencode_secondary_lane_recovery',
] as const;
const EXPECTED_FAKE_RUNTIME_SEAMS: Record<
  (typeof EXPECTED_MATRIX_CASES)[number],
  { seam: string; path: string; token: string }
> = {
  homogeneous_anthropic: {
    seam: 'planner',
    path: 'src/features/team-runtime-lanes/core/domain/planTeamRuntimeLanes.ts',
    token: 'export function planTeamRuntimeLanes',
  },
  homogeneous_codex: {
    seam: 'planner',
    path: 'src/features/team-runtime-lanes/core/domain/planTeamRuntimeLanes.ts',
    token: 'export function planTeamRuntimeLanes',
  },
  homogeneous_gemini: {
    seam: 'planner',
    path: 'src/features/team-runtime-lanes/core/domain/planTeamRuntimeLanes.ts',
    token: 'export function planTeamRuntimeLanes',
  },
  homogeneous_opencode: {
    seam: 'planner',
    path: 'src/features/team-runtime-lanes/core/domain/planTeamRuntimeLanes.ts',
    token: 'export function planTeamRuntimeLanes',
  },
  mixed_provider_team: {
    seam: 'planner',
    path: 'src/features/team-runtime-lanes/core/domain/planTeamRuntimeLanes.ts',
    token: 'export function planTeamRuntimeLanes',
  },
  missing_runtime: {
    seam: 'adapter',
    path: 'src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter.ts',
    token: 'export class OpenCodeTeamRuntimeAdapter',
  },
  missing_auth: {
    seam: 'preflight',
    path: 'src/main/services/team/provisioning/TeamProvisioningProviderPreflight.ts',
    token: 'export function extractAuthStatusReadiness',
  },
  unsupported_backend: {
    seam: 'planner',
    path: 'src/features/team-runtime-lanes/core/domain/planTeamRuntimeLanes.ts',
    token: 'export function planTeamRuntimeLanes',
  },
  malformed_capability_response: {
    seam: 'capability_response_parser',
    path: 'src/main/services/team/opencode/capabilities/OpenCodeApiCapabilities.ts',
    token: 'export async function detectOpenCodeApiCapabilities',
  },
  process_timeout: {
    seam: 'adapter',
    path: 'src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter.ts',
    token: 'export class OpenCodeTeamRuntimeAdapter',
  },
  partial_launch: {
    seam: 'adapter',
    path: 'src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter.ts',
    token: 'export class OpenCodeTeamRuntimeAdapter',
  },
  restart_adoption: {
    seam: 'recovery',
    path: 'src/main/services/team/provisioning/TeamProvisioningStaleMixedSecondaryRecovery.ts',
    token: 'export async function recoverStaleMixedSecondaryLaunchSnapshotWithPorts',
  },
  opencode_secondary_lane_recovery: {
    seam: 'recovery',
    path: 'src/main/services/team/provisioning/TeamProvisioningStaleMixedSecondaryRecovery.ts',
    token: 'export async function recoverStaleMixedSecondaryLaunchSnapshotWithPorts',
  },
};
const ENVIRONMENT_DISCOVERY_ROOTS = [
  'src/main',
  'src/features/codex-account',
  'src/features/member-work-sync',
  'src/features/workspace-trust/main/infrastructure/workspaceTrustPreflightEnv.ts',
] as const;
const ENVIRONMENT_DISCOVERY_EXCLUDED_SEGMENTS = ['/__tests__/', '/renderer/'];
const PROVIDER_RUNTIME_ROUTING_KEYS = [
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
const NON_ENVIRONMENT_LITERALS = new Set([
  'AgentStudio',
  'AppData',
  'Local',
  'EEXIST',
  'ENOENT',
  'NFKD',
  'Atomic',
  'Details',
]);

type JsonRecord = Record<string, unknown>;

export interface SurfaceFixture {
  routes: string[];
  commands: string[];
  providers: string[];
  modes: string[];
}

export interface ProviderModeIngressFixture {
  authorityModel: string;
  dispositions: Array<{
    provider: string;
    mode: string;
    disposition:
      | 'current_source_observed_runtime_ingress'
      | 'current_source_observed_no_runtime_ingress';
    operations: string[];
    authorityRefs: Array<{ path: string; token: string }>;
    targetStatus: string;
  }>;
}

export interface EnvironmentSemanticsFixture {
  schemaVersion: number;
  canonicalBaseSha: string;
  derivation: string;
  delegatedExecutableSemantics: {
    keys: string[];
    authorityPaths: string[];
    proofTestId: string;
  };
  entries: Array<{
    key: string;
    policyProfileId: string;
    semanticRole: string;
    providerBindings: Array<{
      providerId: string;
      backendFamily: string;
      targetDisposition: string;
    }>;
    platformScope: string;
    childVisibility: string;
    credentialExposureSetId: string;
    providerlessProhibition?: {
      scope: string;
      targetDisposition: string;
      reason: string;
    };
    authority: { path: string; token: string };
  }>;
}

export interface ProviderRuntimeRoutingObservation {
  key: (typeof PROVIDER_RUNTIME_ROUTING_KEYS)[number];
  providerId: 'anthropic' | 'codex' | 'gemini';
  backendFamily: 'provisioning_cli_primary';
  runtimeBackend:
    | 'anthropic_default'
    | 'anthropic_bedrock'
    | 'anthropic_vertex'
    | 'anthropic_foundry'
    | 'anthropic_claude_platform_aws'
    | 'codex_configured'
    | 'gemini_configured';
  targetDisposition: 'required' | 'optional' | 'forbidden';
  emissionDisposition:
    | 'emitted_always'
    | 'emitted_when_backend_selected'
    | 'emitted_configured_backend'
    | 'preserved_when_custom_configuration'
    | 'removed_before_spawn';
}

function readJson(path: string): JsonRecord {
  return JSON.parse(readFileSync(path, 'utf8')) as JsonRecord;
}

function extractQuoted(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

function compareSet(
  label: string,
  actual: readonly string[],
  expected: readonly string[]
): string[] {
  const errors = compareUnique(label, [...actual]);
  const actualSet = new Set(actual);
  for (const value of expected)
    if (!actualSet.has(value)) errors.push(`${label}: missing ${value}`);
  for (const value of actualSet)
    if (!expected.includes(value)) errors.push(`${label}: unexpected ${value}`);
  return errors;
}

function compareUnique(label: string, values: string[]): string[] {
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const value of values) {
    if (!value) errors.push(`${label}: empty value`);
    else if (seen.has(value)) errors.push(`${label}: duplicate ${value}`);
    seen.add(value);
  }
  return errors;
}

export function validateSurfaceFixture(fixture: SurfaceFixture): string[] {
  return [
    ...compareSet('routes', fixture.routes, EXPECTED_ROUTES),
    ...compareSet('commands', fixture.commands, EXPECTED_COMMANDS),
    ...compareSet('providers', fixture.providers, EXPECTED_PROVIDERS),
    ...compareSet('modes', fixture.modes, EXPECTED_MODES),
  ];
}

function scanSource(root: string): SurfaceFixture {
  const routesSource = readFileSync(resolve(root, 'src/main/http/teams.ts'), 'utf8');
  const commandSource = readFileSync(
    resolve(root, 'src/main/services/team/runtime-control/domain/RuntimeControlCommand.ts'),
    'utf8'
  );
  const providerSource = readFileSync(
    resolve(root, 'src/main/services/team/runtime/TeamRuntimeAdapter.ts'),
    'utf8'
  );
  const plannerSource = readFileSync(
    resolve(root, 'src/features/team-runtime-lanes/core/domain/planTeamRuntimeLanes.ts'),
    'utf8'
  );
  return {
    routes: extractQuoted(
      routesSource,
      /['"](\/api\/teams\/:teamName\/opencode\/runtime\/[^'"]+)['"]/g
    ),
    commands: extractQuoted(commandSource, /\|\s*['"](runtime\.[a-z-]+)['"]/g),
    providers: extractQuoted(
      providerSource,
      /TEAM_RUNTIME_PROVIDER_IDS\s*=\s*\[([^\]]+)\]/gs
    ).flatMap((body) => extractQuoted(body, /['"]([a-z]+)['"]/g)),
    modes: [
      ...new Set([
        ...extractQuoted(plannerSource, /mode:\s*['"]([a-z_]+)['"]/g),
        ...extractQuoted(plannerSource, /reason:\s*['"]([a-z_]+)['"]/g),
      ]),
    ],
  };
}

function matchesType(value: unknown, declared: unknown): boolean {
  if (Array.isArray(declared)) return declared.some((type) => matchesType(value, type));
  if (declared === 'null') return value === null;
  if (declared === 'array') return Array.isArray(value);
  if (declared === 'object')
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (declared === 'integer') return Number.isInteger(value);
  return typeof value === declared;
}

function validateSchema(value: unknown, schema: JsonRecord, path: string): string[] {
  const errors: string[] = [];
  if ('const' in schema && value !== schema.const) errors.push(`${path}: violates const`);
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value)))
    errors.push(`${path}: violates enum`);
  if (schema.type !== undefined && !matchesType(value, schema.type))
    return [...errors, `${path}: expected ${String(schema.type)}`];
  if (
    typeof value === 'string' &&
    typeof schema.minLength === 'number' &&
    value.length < schema.minLength
  )
    errors.push(`${path}: below minLength`);
  if (typeof value === 'number' && typeof schema.minimum === 'number' && value < schema.minimum)
    errors.push(`${path}: below minimum`);
  if (typeof value === 'number' && typeof schema.maximum === 'number' && value > schema.maximum)
    errors.push(`${path}: above maximum`);
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems)
      errors.push(`${path}: below minItems`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
      errors.push(`${path}: above maxItems`);
    if (
      schema.uniqueItems &&
      new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length
    )
      errors.push(`${path}: items not unique`);
    if (Array.isArray(schema.prefixItems))
      schema.prefixItems.forEach((rule, index) => {
        if (index < value.length)
          errors.push(...validateSchema(value[index], rule as JsonRecord, `${path}[${index}]`));
      });
    if (
      schema.items === false &&
      value.length > ((schema.prefixItems as unknown[] | undefined)?.length ?? 0)
    )
      errors.push(`${path}: unexpected tuple item`);
    if (schema.items && typeof schema.items === 'object')
      value.forEach((entry, index) =>
        errors.push(...validateSchema(entry, schema.items as JsonRecord, `${path}[${index}]`))
      );
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as JsonRecord;
    for (const key of (schema.required as string[] | undefined) ?? [])
      if (!(key in object)) errors.push(`${path}: missing required ${key}`);
    const properties = (schema.properties as Record<string, JsonRecord> | undefined) ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(object))
        if (!(key in properties)) errors.push(`${path}: unknown property ${key}`);
    }
    for (const [key, rule] of Object.entries(properties))
      if (key in object) errors.push(...validateSchema(object[key], rule, `${path}.${key}`));
  }
  if (Array.isArray(schema.anyOf)) {
    const valid = schema.anyOf.some(
      (branch) => validateSchema(value, branch as JsonRecord, path).length === 0
    );
    if (!valid) errors.push(`${path}: violates anyOf`);
  }
  if (Array.isArray(schema.oneOf)) {
    const branchErrors = schema.oneOf.map((branch) =>
      validateSchema(value, branch as JsonRecord, path)
    );
    const validCount = branchErrors.filter((branch) => branch.length === 0).length;
    if (validCount !== 1) {
      errors.push(`${path}: violates oneOf`);
      if (validCount === 0) errors.push(...branchErrors[0]);
    }
  }
  if (schema.not && typeof schema.not === 'object') {
    if (validateSchema(value, schema.not as JsonRecord, path).length === 0) {
      errors.push(`${path}: violates not`);
    }
  }
  return errors;
}

export function validateArtifactDocument(
  root: string,
  file: string,
  document: JsonRecord
): string[] {
  const schemaRef = document.$schema;
  if (typeof schemaRef !== 'string' || !schemaRef.startsWith('./schemas/'))
    return [`${file}: invalid schema reference`];
  const schema = readJson(resolve(root, EVIDENCE_ROOT, schemaRef.slice(2)));
  return validateSchema(document, schema, file);
}

function extractEnvironmentTokens(source: string): string[] {
  const environmentObject = '(?:process\\.env|[A-Za-z][A-Za-z0-9_]*(?:Env|Environment)|env)';
  const candidates = [
    ...extractQuoted(source, new RegExp(`${environmentObject}\\.([A-Z][A-Za-z0-9_]*)`, 'g')),
    ...extractQuoted(
      source,
      new RegExp(`${environmentObject}\\[['"]([A-Z][A-Za-z0-9_]*|npm_config_[a-z_]+)['"]\\]`, 'g')
    ),
    ...extractQuoted(
      source,
      /\b[A-Z][A-Z0-9_]*(?:ENV|ENV_VAR|ENV_KEY)\s*=\s*['"]([A-Z][A-Za-z0-9_]*|npm_config_[a-z_]+)['"]/g
    ),
    ...extractQuoted(
      source,
      /\b[A-Za-z][A-Za-z0-9_]*Env[A-Za-z0-9_]*\([^;]{0,300}?['"]([A-Z][A-Za-z0-9_]*|npm_config_[a-z_]+)['"]/g
    ),
    ...extractQuoted(
      source,
      /(?:[A-Za-z][A-Za-z0-9_]*Env[A-Za-z0-9_]*|env|assignments)\.set\(\s*['"]([A-Z][A-Za-z0-9_]*|npm_config_[a-z_]+)['"]/g
    ),
  ];
  for (const match of source.matchAll(
    /\b[A-Z][A-Z0-9_]*ENV[A-Z0-9_]*(?:KEYS|VARS|MARKERS)\s*=\s*\[([^\]]+)\]/gs
  )) {
    candidates.push(
      ...extractQuoted(match[1], /['"]([A-Z][A-Za-z0-9_]*|npm_config_[a-z_]+)=?['"]/g)
    );
  }
  for (const match of source.matchAll(
    /\b[A-Z][A-Z0-9_]*ENV_KEYS\s*=\s*new Set\(\s*\[([\s\S]*?)\]\s*\)/g
  )) {
    candidates.push(...extractQuoted(match[1], /['"]([A-Z][A-Za-z0-9_]*|npm_config_[a-z_]+)['"]/g));
  }
  for (const match of source.matchAll(
    /\b[A-Z][A-Z0-9_]*ENV_PREFIXES\s*=\s*\[([\s\S]*?)\]\s*(?:as const)?;/g
  )) {
    candidates.push(
      ...extractQuoted(match[1], /['"]([A-Z][A-Za-z0-9_]*)['"]/g).map((prefix) => `${prefix}*`)
    );
  }
  for (const match of source.matchAll(
    /\b(?:const|let)\s+(?:[A-Za-z][A-Za-z0-9_]*(?:Env|Environment)[A-Za-z0-9_]*|[A-Z][A-Z0-9_]*ENV[A-Z0-9_]*|env)(?:\s*:[^=]+)?\s*=\s*{([\s\S]{0,20000}?)\n\s*};/g
  )) {
    candidates.push(...extractQuoted(match[1], /\b([A-Z][A-Za-z0-9_]{2,})\s*:/g));
  }
  for (const match of source.matchAll(/\benv\s*:\s*{([\s\S]{0,10000}?)\n\s*}/g)) {
    candidates.push(...extractQuoted(match[1], /\b([A-Z][A-Za-z0-9_]{2,})\s*:/g));
  }
  for (const match of source.matchAll(
    /\b[A-Za-z][A-Za-z0-9_]*(?:Env|Environment)[A-Za-z0-9_]*\(\s*{([\s\S]{0,10000}?)\n\s*}\s*\)/g
  )) {
    candidates.push(...extractQuoted(match[1], /\b([A-Z][A-Za-z0-9_]{2,})\s*:/g));
  }
  return candidates.filter((key) => !NON_ENVIRONMENT_LITERALS.has(key));
}

function walkProductionSources(root: string, relativeRoot: string): string[] {
  const absoluteRoot = resolve(root, relativeRoot);
  const files: string[] = [];
  if (statSync(absoluteRoot).isFile()) return [relativeRoot];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile() && ['.ts', '.tsx'].includes(extname(entry.name))) {
        const path = `/${relative(root, absolutePath).replaceAll('\\', '/')}`;
        if (
          !path.endsWith('.test.ts') &&
          !path.endsWith('.test.tsx') &&
          !ENVIRONMENT_DISCOVERY_EXCLUDED_SEGMENTS.some((segment) => path.includes(segment))
        )
          files.push(path.slice(1));
      }
    }
  };
  visit(absoluteRoot);
  return files;
}

export function discoverEnvironmentKeys(root: string): Map<string, string[]> {
  const occurrences = new Map<string, string[]>();
  const sources = ENVIRONMENT_DISCOVERY_ROOTS.flatMap((sourceRoot) =>
    walkProductionSources(root, sourceRoot)
  );
  for (const path of sources) {
    const source = readFileSync(resolve(root, path), 'utf8');
    for (const key of extractEnvironmentTokens(source)) {
      const paths = occurrences.get(key) ?? [];
      if (!paths.includes(path)) paths.push(path);
      occurrences.set(key, paths);
    }
  }
  return occurrences;
}

export function validateEnvironmentCompleteness(
  root: string,
  document: JsonRecord,
  knownOccurrences?: Map<string, string[]>
): string[] {
  const rows = document.records as JsonRecord[];
  const classified = rows.flatMap((row) => (row.keys as string[]) ?? []);
  const errors = compareUnique('environment keys', classified);
  const discovery = document.sourceDiscovery as JsonRecord;
  errors.push(
    ...compareSet(
      'environment discovery roots',
      discovery.roots as string[],
      ENVIRONMENT_DISCOVERY_ROOTS
    ),
    ...compareSet(
      'environment discovery exclusions',
      discovery.excludedSegments as string[],
      ENVIRONMENT_DISCOVERY_EXCLUDED_SEGMENTS
    ),
    ...compareSet('environment discovery extensions', discovery.extensions as string[], [
      '.ts',
      '.tsx',
    ])
  );
  const discovered = knownOccurrences ?? discoverEnvironmentKeys(root);
  const sourceClassified = rows
    .filter((row) => row.discoveryDisposition === 'source_discovered')
    .flatMap((row) => (row.keys as string[]) ?? []);
  const sourceClassifiedSet = new Set(sourceClassified);
  for (const key of discovered.keys())
    if (!sourceClassifiedSet.has(key))
      errors.push(`environment-provenance.json: discovered unclassified key ${key}`);
  for (const key of sourceClassified)
    if (!discovered.has(key))
      errors.push(`environment-provenance.json: classified key has no source occurrence ${key}`);
  for (const row of rows.filter(
    (candidate) => candidate.discoveryDisposition === 'fixture_bound'
  )) {
    const keys = row.keys as string[];
    const bindings = row.keyBindings as JsonRecord[];
    const bindingKeys = bindings.map((binding) => String(binding.key));
    errors.push(...compareSet(`environment fixture bindings ${String(row.id)}`, bindingKeys, keys));
    for (const binding of bindings) {
      const key = String(binding.key);
      const path = String(binding.path);
      const source = readFileSync(resolve(root, path), 'utf8');
      if (!source.includes(key))
        errors.push(`environment-provenance.json: stale fixture binding ${key} in ${path}`);
    }
  }
  for (const row of rows) {
    const source = readFileSync(resolve(root, String(row.source)), 'utf8');
    if (!source.includes(String(row.sourceToken)))
      errors.push(`environment-provenance.json: stale source token for ${String(row.id)}`);
  }
  const keyEvidence = resolvePerKeyEnvironmentEvidence(document);
  errors.push(...validatePerKeyEnvironmentEvidenceCoverage(document));
  const keyTable = document.keyEvidence as JsonRecord;
  errors.push(
    ...compareSet('per-key evidence fields', keyTable.fields as string[], [
      'key',
      'groupId',
      'policyProfileId',
      'probePathId',
    ]),
    ...compareUnique(
      'per-key policy profile ids',
      (document.keyPolicyProfiles as JsonRecord[]).map((profile) => String(profile.id))
    ),
    ...compareUnique(
      'per-key probe path ids',
      (keyTable.probePaths as JsonRecord[]).map((path) => String(path.id))
    )
  );
  const groupById = new Map(rows.map((row) => [String(row.id), row]));
  const policyProfileIds = new Set(
    (document.keyPolicyProfiles as JsonRecord[]).map((profile) => String(profile.id))
  );
  for (const entry of keyEvidence) {
    const key = String(entry.key);
    const group = groupById.get(String(entry.groupId));
    if (!group || !(group.keys as string[]).includes(key))
      errors.push(`environment-provenance.json: ${key} has invalid group binding`);
    if (!policyProfileIds.has(String(entry.policyProfileId))) {
      errors.push(`environment-provenance.json: ${key} has invalid policy profile`);
      continue;
    }
    const probe = entry.probe as JsonRecord;
    const path = String(probe.path);
    const token = String(probe.token);
    if (!path) {
      errors.push(`environment-provenance.json: ${key} has invalid probe path`);
      continue;
    }
    const source = readFileSync(resolve(root, path), 'utf8');
    if (!source.includes(token))
      errors.push(`environment-provenance.json: ${key} has stale exact probe ${path}#${token}`);
    if (probe.kind === 'source_census' && !(discovered.get(key) ?? []).includes(path))
      errors.push(
        `environment-provenance.json: ${key} probe is not a discovered source occurrence`
      );
    if ((entry.executionUnitIds as string[]).length === 0)
      errors.push(`environment-provenance.json: ${key} has no execution unit`);
    if ((entry.credentialExposureSetIds as string[]).length !== 1)
      errors.push(`environment-provenance.json: ${key} must bind exactly one exposure set`);
  }
  return errors;
}

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

function findSecretValues(value: unknown, path: string): string[] {
  const errors: string[] = [];
  if (
    typeof value === 'string' &&
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._-]{12,}|\bsk-[A-Za-z0-9]{12,}/i.test(
      value
    )
  )
    errors.push(`${path}: possible secret value`);
  else if (Array.isArray(value))
    value.forEach((entry, index) => errors.push(...findSecretValues(entry, `${path}[${index}]`)));
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (/^(secretValue|tokenValue|authPayload|rawProviderPayload)$/i.test(key))
        errors.push(`${path}.${key}: forbidden evidence field`);
      errors.push(...findSecretValues(entry, `${path}.${key}`));
    }
  }
  return errors;
}

function validateEstimate(document: JsonRecord): string[] {
  const ranges = document.ranges as Record<string, { low: number; high: number }>;
  const errors: string[] = [];
  for (const [name, range] of Object.entries(ranges))
    if (range.low > range.high) errors.push(`estimate-input.json: ${name} low exceeds high`);
  const expectedLow = ranges.productionLines.low + ranges.testLines.low - ranges.deletedLines.high;
  const expectedHigh =
    ranges.productionLines.high + ranges.testLines.high - ranges.deletedLines.low;
  if (ranges.netChangedLines.low !== expectedLow || ranges.netChangedLines.high !== expectedHigh)
    errors.push('estimate-input.json: net range arithmetic mismatch');
  const w4 = document.w4Reconciliation as JsonRecord;
  if (w4.sharedCanonicalBucket !== document.canonicalBucketId)
    errors.push('estimate-input.json: W4 bucket mismatch');
  return errors;
}

function validateEvidence(root: string): string[] {
  const evidenceRoot = resolve(root, EVIDENCE_ROOT);
  const errors: string[] = [];
  for (const file of ARTIFACTS) {
    const document = readJson(resolve(evidenceRoot, file));
    errors.push(
      ...validateArtifactDocument(root, file, document),
      ...findSecretValues(document, file)
    );
    if (document.phaseStartSha !== PHASE_START_SHA) errors.push(`${file}: wrong phaseStartSha`);
    if (Array.isArray(document.records))
      errors.push(
        ...compareUnique(
          `${file} record ids`,
          (document.records as JsonRecord[]).map((row) => String(row.id ?? ''))
        )
      );
  }

  const ingress = readJson(resolve(evidenceRoot, 'runtime-ingress-inventory.json'));
  const ingressRows = ingress.records as JsonRecord[];
  errors.push(
    ...compareSet(
      'inventory routes',
      ingressRows.map((row) => String(row.currentRoute)),
      EXPECTED_ROUTES
    )
  );
  errors.push(
    ...compareSet(
      'inventory commands',
      ingressRows.map((row) => String(row.commandKind)),
      EXPECTED_COMMANDS
    )
  );
  const trust = ingress.trustSurfaceProof as JsonRecord;
  if ((trust.authorityIntersection as unknown[]).length !== 0)
    errors.push('runtime-ingress-inventory.json: browser/runtime authority overlaps');
  const operatorActions = new Set(trust.operatorOnlyActions as string[]);
  const computedIntersection = (trust.runtimeOnlyActions as string[]).filter((action) =>
    operatorActions.has(action)
  );
  if (computedIntersection.length > 0)
    errors.push(
      `runtime-ingress-inventory.json: computed authority overlap ${computedIntersection.join(', ')}`
    );
  if (
    !String(trust.targetBrowserAuthority).includes('/api/hosted/v1') ||
    !String(trust.targetRuntimeAuthority).includes('/api/runtime/v1') ||
    !String(trust.targetRuntimeAuthority).includes('cannot invoke operator verbs')
  ) {
    errors.push('runtime-ingress-inventory.json: proposed trust split is incomplete');
  }

  const environment = readJson(resolve(evidenceRoot, 'environment-provenance.json'));
  errors.push(...validateEnvironmentCompleteness(root, environment));
  const environmentSemantics = readJson(
    resolve(
      root,
      'test/architecture/hosted-web/phase-0/provider-runtime/fixtures/environment-semantics.json'
    )
  ) as unknown as EnvironmentSemanticsFixture;
  errors.push(...validateEnvironmentSemanticsFixture(root, environment, environmentSemantics));

  const credentialMatrix = readJson(resolve(evidenceRoot, 'credential-exposure-matrix.json'));
  errors.push(...validateCredentialExposureLinks(root, environment, credentialMatrix));

  const matrix = readJson(resolve(evidenceRoot, 'fake-runtime-fixture-matrix.json'));
  errors.push(...validateFakeRuntimeMatrix(root, matrix));

  const positiveProviderModeFixture = readJson(
    resolve(
      root,
      'test/architecture/hosted-web/phase-0/provider-runtime/fixtures/provider-mode-ingress-positive.json'
    )
  ) as unknown as ProviderModeIngressFixture;
  const negativeProviderModeFixture = readJson(
    resolve(
      root,
      'test/architecture/hosted-web/phase-0/provider-runtime/fixtures/provider-mode-ingress-negative.json'
    )
  ) as unknown as ProviderModeIngressFixture;
  errors.push(...validateProviderModeIngressFixture(root, positiveProviderModeFixture));
  const negativeErrors = validateProviderModeIngressFixture(root, negativeProviderModeFixture);
  if (negativeErrors.length === 0)
    errors.push('provider/mode ingress negative fixture unexpectedly passed');

  errors.push(...validateEstimate(readJson(resolve(evidenceRoot, 'estimate-input.json'))));
  return errors;
}

export function scanRepository(root: string): string[] {
  return [...validateSurfaceFixture(scanSource(root)), ...validateEvidence(root)];
}

function main(): void {
  const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
  const matrix = readJson(resolve(root, EVIDENCE_ROOT, 'fake-runtime-fixture-matrix.json'));
  const errors = [...scanRepository(root), ...verifyFakeRuntimeProofExecution(root, matrix)];
  if (errors.length > 0) {
    errors.forEach((error) => process.stderr.write(`ERROR ${error}\n`));
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `P0.W2.RUNTIME_SCANNER ok: 4 providers, 2 backend families, 5 operations, ${EXPECTED_MATRIX_CASES.length} independently executed positive/failing-negative provider cases, 7 independently sourced provider/mode dispositions; per-key provenance/exposure, strict nested schemas, omission-sensitive environment census, trust split and canonical estimate valid\n`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
