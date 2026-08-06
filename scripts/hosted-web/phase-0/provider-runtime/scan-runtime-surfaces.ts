import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolvePerKeyEnvironmentEvidence,
  validateCredentialExposureLinks,
  validateEnvironmentSemanticsFixture,
  validateFakeRuntimeMatrix,
  validatePerKeyEnvironmentEvidenceCoverage,
  validateProviderModeIngressFixture as validateProviderModeIngressFixtureSource,
  verifyFakeRuntimeProofExecution,
} from './provider-runtime-fixtures';
import {
  ARTIFACTS,
  compareSet,
  compareUnique,
  EVIDENCE_ROOT,
  ENVIRONMENT_DISCOVERY_EXCLUDED_SEGMENTS,
  ENVIRONMENT_DISCOVERY_ROOTS,
  EXPECTED_COMMANDS,
  EXPECTED_MATRIX_CASES,
  EXPECTED_MODES,
  EXPECTED_PROVIDERS,
  EXPECTED_ROUTES,
  extractQuoted,
  type EnvironmentSemanticsFixture,
  type JsonRecord,
  NON_ENVIRONMENT_LITERALS,
  PHASE_START_SHA,
  type ProviderModeIngressFixture,
  readJson,
  type SurfaceFixture,
} from './provider-runtime-shared';

const LEGACY_RUNTIME_ROUTE_AUTHORITY_PATH = 'src/main/http/teams.ts';
const RUNTIME_COMPATIBILITY_ROUTE_AUTHORITY_PATH =
  'src/main/http/teamRuntimeCompatibilityRoutes.ts';
const RUNTIME_COMPATIBILITY_ROUTE_REGISTRATION =
  'registerTeamRuntimeCompatibilityRoutes(app, applicationHost)';
const RUNTIME_COMPATIBILITY_ROUTE_TOKENS = new Set(
  EXPECTED_ROUTES.map((route) => route.replace('/api/teams/:teamName', ''))
);

export {
  resolvePerKeyEnvironmentEvidence,
  validateCredentialExposureLinks,
  validateEnvironmentSemanticsFixture,
  validateFakeRuntimeMatrix,
  validatePerKeyEnvironmentEvidenceCoverage,
  validateProviderRuntimeRoutingSemantics,
  verifyFakeRuntimeProofExecution,
} from './provider-runtime-fixtures';
export type {
  EnvironmentSemanticsFixture,
  ProviderModeIngressFixture,
  ProviderRuntimeRoutingObservation,
  SurfaceFixture,
} from './provider-runtime-shared';

export function validateSurfaceFixture(fixture: SurfaceFixture): string[] {
  return [
    ...compareSet('routes', fixture.routes, EXPECTED_ROUTES),
    ...compareSet('commands', fixture.commands, EXPECTED_COMMANDS),
    ...compareSet('providers', fixture.providers, EXPECTED_PROVIDERS),
    ...compareSet('modes', fixture.modes, EXPECTED_MODES),
  ];
}

function runtimeRoutePaths(source: string): string[] {
  return extractQuoted(source, /['"](\/api\/teams\/:teamName\/opencode\/runtime\/[^'"]+)['"]/g);
}

function resolveCurrentProviderModeIngressAuthority(
  fixture: ProviderModeIngressFixture
): ProviderModeIngressFixture {
  return {
    ...fixture,
    dispositions: fixture.dispositions.map((row) => ({
      ...row,
      authorityRefs: row.authorityRefs.map((authority) =>
        authority.path === LEGACY_RUNTIME_ROUTE_AUTHORITY_PATH &&
        RUNTIME_COMPATIBILITY_ROUTE_TOKENS.has(authority.token)
          ? { ...authority, path: RUNTIME_COMPATIBILITY_ROUTE_AUTHORITY_PATH }
          : authority
      ),
    })),
  };
}

export function validateProviderModeIngressFixture(
  root: string,
  fixture: ProviderModeIngressFixture
): string[] {
  return validateProviderModeIngressFixtureSource(
    root,
    resolveCurrentProviderModeIngressAuthority(fixture)
  );
}

function scanSource(root: string): SurfaceFixture {
  const routesSource = readFileSync(
    resolve(root, 'src/main/http/teamRuntimeCompatibilityRoutes.ts'),
    'utf8'
  );
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
    routes: runtimeRoutePaths(routesSource),
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

function validateRuntimeRouteAuthority(root: string): string[] {
  const teamRoutesSource = readFileSync(resolve(root, LEGACY_RUNTIME_ROUTE_AUTHORITY_PATH), 'utf8');
  const errors = compareSet('legacy team runtime routes', runtimeRoutePaths(teamRoutesSource), []);
  if (!teamRoutesSource.includes(RUNTIME_COMPATIBILITY_ROUTE_REGISTRATION)) {
    errors.push(
      'team runtime compatibility route registration is missing from src/main/http/teams.ts'
    );
  }
  return errors;
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
      ingressRows.flatMap((row) =>
        typeof row.currentRoute === 'string' ? [row.currentRoute] : []
      ),
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
  return [
    ...validateSurfaceFixture(scanSource(root)),
    ...validateRuntimeRouteAuthority(root),
    ...validateEvidence(root),
  ];
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
