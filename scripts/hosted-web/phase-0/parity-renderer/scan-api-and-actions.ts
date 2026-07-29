import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { absenceSeeds, actionSeeds, apiGroups } from './parity-catalog-seeds';
import {
  API_SURFACES,
  type AbsenceRow,
  type ApiSurface,
  type ChildControlCatalog,
  CONTROL_ROOTS,
  kebab,
  PHASE_START_API_COUNTS,
  PHASE_START_SHA,
  PINNED_BASE_SHA,
  type SemanticRow,
  sha,
} from './parity-scan-contracts';
import {
  bypassEvidence,
  childCatalogAbsences,
  childCatalogActions,
  discoverControlClosure,
  refsFor,
  rendererCallers,
  scanApiInterfaces,
  scanControls,
  validateApiDispositions,
  validateChildControlCatalog,
  validateControlClosure,
  validateLegacyChildApiActionMappings,
  validateMountedControlRoots,
  validateSemanticCatalog,
  walk,
} from './parity-source-scanner';

export {
  CONTROL_ROOTS,
  isEventProp,
  LEGACY_CHILD_API_ACTION_IDS,
  PHASE_START_SHA,
  PINNED_BASE_SHA,
  type AbsenceRow,
  type ChildControlCatalog,
  type ControlSite,
  type SemanticRow,
} from './parity-scan-contracts';
export {
  discoverControlClosure,
  findDynamicDispatch,
  refsFor,
  scanApiInterfaces,
  scanControls,
  scanRendererApiCallers,
  validateApiDispositions,
  validateChildControlCatalog,
  validateControlClosure,
  validateLegacyChildApiActionMappings,
  validateMountedControlRoots,
  validateSemanticCatalog,
} from './parity-source-scanner';

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeCompactJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

type SchemaNode = {
  type?: string;
  required?: string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
};

export function validateJsonSchema(value: unknown, schema: SchemaNode, label = '$'): void {
  if (schema.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error(`${label} must be an object`);
  }
  if (schema.type === 'array' && !Array.isArray(value))
    throw new Error(`${label} must be an array`);
  if (schema.type === 'string' && typeof value !== 'string')
    throw new Error(`${label} must be a string`);
  if (schema.type === 'number' && typeof value !== 'number')
    throw new Error(`${label} must be a number`);
  if (schema.type === 'boolean' && typeof value !== 'boolean')
    throw new Error(`${label} must be a boolean`);
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? [])
      if (!(key in record)) throw new Error(`${label}.${key} is required`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in record) validateJsonSchema(record[key], child, `${label}.${key}`);
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validateJsonSchema(item, schema.items!, `${label}[${index}]`));
  }
}

function evidenceSchemas(outputRoot: string): void {
  const base = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: [
      'schemaId',
      'schemaVersion',
      'evidenceId',
      'packetRevision',
      'pinnedBaseSha',
      'phaseStartSha',
    ],
  };
  const schemas = {
    'api-parity-ledger.schema.json': {
      ...base,
      required: [...base.required, 'counts', 'members'],
      properties: {
        members: {
          type: 'array',
          items: {
            type: 'object',
            required: [
              'stableId',
              'source',
              'sourceMember',
              'legacySignature',
              'sourceSignatureHash',
              'rendererCallers',
              'owningFeature',
              'disposition',
              'securityClass',
              'requiredSemanticEvidence',
              'actionId',
              'targetWorkPackage',
            ],
          },
        },
      },
    },
    'renderer-action-inventory.schema.json': {
      ...base,
      required: [
        ...base.required,
        'roots',
        'mountProofs',
        'sourceFiles',
        'excludedSourceFiles',
        'actions',
        'apiActionBindings',
        'legacyChildApiActionBindings',
        'deliberateAbsences',
      ],
      properties: {
        roots: { type: 'array', items: { type: 'string' } },
        mountProofs: {
          type: 'array',
          items: { type: 'object', required: ['root', 'mountChain'] },
        },
        sourceFiles: {
          type: 'array',
          items: { type: 'object', required: ['path', 'sha256', 'interactionSiteCount'] },
        },
        excludedSourceFiles: {
          type: 'array',
          items: { type: 'object', required: ['path', 'reason', 'interactionSiteCount'] },
        },
        actions: {
          type: 'array',
          items: {
            type: 'object',
            required: [
              'id',
              'owner',
              'disposition',
              'securityClass',
              'target',
              'evidence',
              'sourceRefs',
            ],
          },
        },
        apiActionBindings: {
          type: 'array',
          items: {
            type: 'object',
            required: ['actionId', 'owner', 'source', 'sourceMember', 'rendererCallers'],
          },
        },
        legacyChildApiActionBindings: {
          type: 'array',
          items: {
            type: 'object',
            required: ['childActionId', 'apiActionId', 'owner'],
          },
        },
        deliberateAbsences: {
          type: 'array',
          items: { type: 'object', required: ['id', 'reason', 'sourceRefs'] },
        },
      },
    },
    'renderer-child-control-catalog.schema.json': {
      ...base,
      required: [...base.required, 'roots', 'sourceFiles', 'actions', 'absences', 'mappings'],
      properties: {
        roots: { type: 'array', items: { type: 'string' } },
        sourceFiles: { type: 'array', items: { type: 'string' } },
        actions: { type: 'object' },
        absences: { type: 'object' },
        mappings: { type: 'object' },
      },
    },
    'legacy-bypass-inventory.schema.json': {
      ...base,
      required: [...base.required, 'summary', 'rawArtifact'],
      properties: {
        rawArtifact: {
          type: 'object',
          required: [
            'format',
            'recordCount',
            'sha256',
            'externalPath',
            'pathScope',
            'reproductionCommand',
          ],
          properties: {
            externalPath: { const: 'legacy-bypass-raw.json' },
            pathScope: { const: 'artifact-pack-relative' },
            reproductionCommand: {
              const:
                'W1_RAW_EVIDENCE_ROOT=<artifact-pack-dir> node --import tsx scripts/hosted-web/phase-0/parity-renderer/scan-api-and-actions.ts',
            },
          },
        },
      },
    },
    'estimate-input.schema.json': {
      ...base,
      required: [...base.required, 'unit', 'buckets', 'varianceAssessment'],
      properties: {
        buckets: {
          type: 'array',
          items: {
            type: 'object',
            required: [
              'bucketId',
              'packages',
              'productionLines',
              'testLines',
              'deletedLines',
              'netLines',
              'excludedGeneratedVendorLines',
              'overlap',
              'confidence',
              'assumptions',
              'evidenceRefs',
            ],
          },
        },
        varianceAssessment: {
          type: 'object',
          required: [
            'parentRangeStillSupported',
            'uniqueBucketOverTwentyPercent',
            'scopeReviewRequired',
            'changes',
          ],
        },
      },
    },
  };
  for (const [name, schema] of Object.entries(schemas))
    writeJson(join(outputRoot, 'schemas', name), schema);
}

export function generateEvidence(
  repoRoot: string,
  rawRoot = '/tmp/agent-teams-hosted-web-refactor-phase-00-remediation-w1-v9-artifacts'
): { rawPath: string; rawHash: string; apiCount: number; controlCount: number } {
  const outputRoot = join(repoRoot, 'docs/research/hosted-web/phase-0/parity-renderer');
  const apiRows = scanApiInterfaces(
    readFileSync(join(repoRoot, 'src/shared/types/api.ts'), 'utf8')
  );
  const callers = rendererCallers(repoRoot);
  const dispositions = apiGroups.flatMap((group) =>
    group.members.map((sourceMember) => {
      const source = group.surface;
      const scanned = apiRows.find((row) => row.surface === source && row.member === sourceMember);
      if (!scanned) throw new Error(`Explicit API disposition is stale: ${source}.${sourceMember}`);
      return {
        stableId: `P0.W1.API.${source}.${sourceMember}`,
        source,
        sourceMember,
        legacySignature: scanned.signature,
        sourceSignatureHash: scanned.signatureHash,
        rendererCallers: [...(callers.get(`${source}.${sourceMember}`) ?? [])].sort(),
        owningFeature: group.owner,
        disposition: group.disposition,
        securityClass: group.securityClass,
        requiredSemanticEvidence: [
          'normalized success/error contract',
          'support distinct from resource allowance',
          'revision/idempotency/event obligation',
        ],
        actionId: `${group.namespace}.${kebab(sourceMember)}`,
        targetWorkPackage: group.target,
      };
    })
  );
  validateApiDispositions(apiRows, dispositions);

  const readRepoSource = (file: string): string | undefined => {
    const absolute = join(repoRoot, file);
    return existsSync(absolute) && statSync(absolute).isFile()
      ? readFileSync(absolute, 'utf8')
      : undefined;
  };
  const mountProofs = validateMountedControlRoots(readRepoSource);
  const controlFiles = discoverControlClosure(CONTROL_ROOTS, readRepoSource);
  const teamControlCandidates = walk(join(repoRoot, 'src/renderer/components/team'))
    .filter((absolute) => absolute.endsWith('.tsx') && !/\.(?:test|stories)\.tsx$/.test(absolute))
    .map((absolute) => relative(repoRoot, absolute))
    .sort();
  const excludedControlFiles = teamControlCandidates.filter((file) => !controlFiles.includes(file));
  const catalogPath = join(outputRoot, 'renderer-child-control-catalog.json');
  if (!existsSync(catalogPath))
    throw new Error(`Missing reviewed child-control catalog: ${catalogPath}`);
  const childCatalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as ChildControlCatalog;
  if (
    childCatalog.pinnedBaseSha !== PINNED_BASE_SHA ||
    childCatalog.phaseStartSha !== PHASE_START_SHA
  ) {
    throw new Error('Child-control catalog provenance does not match the pinned W1 source');
  }
  if (JSON.stringify(childCatalog.roots) !== JSON.stringify(CONTROL_ROOTS)) {
    throw new Error('Child-control catalog roots do not match the mounted team roots');
  }
  validateControlClosure(controlFiles, childCatalog.sourceFiles);
  const sites = controlFiles.flatMap((file) => scanControls(readRepoSource(file)!, file));
  validateChildControlCatalog(sites, childCatalog);
  const actions: SemanticRow[] = [
    ...actionSeeds.map(({ refs, ...row }) => ({
      ...row,
      sourceRefs: refsFor(repoRoot, refs, sites),
    })),
    ...childCatalogActions(childCatalog),
  ];
  const deliberateAbsences: AbsenceRow[] = [
    ...absenceSeeds.map(({ refs, ...row }) => ({
      ...row,
      sourceRefs: refsFor(repoRoot, refs, sites),
    })),
    ...childCatalogAbsences(childCatalog),
  ];
  validateSemanticCatalog(sites, actions, deliberateAbsences);
  const ownerByAction = new Map(dispositions.map((row) => [row.actionId, row.owningFeature]));
  for (const action of actions) {
    const apiOwner = ownerByAction.get(action.id);
    if (apiOwner && apiOwner !== action.owner)
      throw new Error(`Cross-lane ownership conflict for ${action.id}`);
  }
  if (ownerByAction.get('team.lifecycle.stop') !== 'team-lifecycle')
    throw new Error('Team stop must remain team-lifecycle owned');
  if (
    actions.find((row) => row.id === 'provider.management.credentials.edit')?.owner !==
    'runtime-provider-management'
  )
    throw new Error('Provider credential controls must remain provider-management owned');
  const legacyChildApiActionBindings = validateLegacyChildApiActionMappings(actions, dispositions);
  const apiActionBindings = dispositions
    .filter((row) => row.rendererCallers.length)
    .map((row) => ({
      actionId: row.actionId,
      owner: row.owningFeature,
      source: row.source,
      sourceMember: row.sourceMember,
      rendererCallers: row.rendererCallers,
    }));

  const bypasses = bypassEvidence(repoRoot);
  const rawPath = join(rawRoot, 'legacy-bypass-raw.json');
  writeCompactJson(rawPath, bypasses.rows);
  const rawText = readFileSync(rawPath, 'utf8');
  const rawHash = `sha256:${sha(rawText)}`;

  const envelope = {
    schemaVersion: 2,
    packetRevision: 'phase-00-r2',
    pinnedBaseSha: PINNED_BASE_SHA,
    phaseStartSha: PHASE_START_SHA,
  };
  const apiCounts = Object.fromEntries(
    API_SURFACES.map((surface) => [
      surface,
      apiRows.filter((row) => row.surface === surface).length,
    ])
  ) as Record<ApiSurface, number>;
  writeJson(join(outputRoot, 'api-parity-ledger.json'), {
    schemaId: 'p0-w1-api-parity-ledger',
    evidenceId: 'P0.W1.API_PARITY_LEDGER',
    ...envelope,
    counts: apiCounts,
    historicalCountDifference: `ReviewAPI +${apiCounts.ReviewAPI - PHASE_START_API_COUNTS.ReviewAPI} since the phase-start AST: current ${API_SURFACES.map((surface) => apiCounts[surface]).join('/')} versus historical ${API_SURFACES.map((surface) => PHASE_START_API_COUNTS[surface]).join('/')}`,
    members: dispositions,
  });
  writeJson(join(outputRoot, 'renderer-action-inventory.json'), {
    schemaId: 'p0-w1-renderer-action-inventory',
    evidenceId: 'P0.W1.RENDERER_ACTIONS',
    ...envelope,
    identityRule:
      'Semantic IDs are reviewed contract identifiers; source hashes, handler text, counts, file paths, and line positions are refreshable references and never enter identity.',
    roots: [...CONTROL_ROOTS],
    mountProofs,
    sourceFiles: controlFiles.map((file) => ({
      path: file,
      sha256: `sha256:${sha(readRepoSource(file)!)}`,
      interactionSiteCount: sites.filter((site) => site.file === file).length,
    })),
    excludedSourceFiles: excludedControlFiles.map((file) => ({
      path: file,
      reason:
        'No relative or renderer-alias static/dynamic import path exists from the mounted W1 team roots; the file is absent from this mount closure.',
      interactionSiteCount: scanControls(readRepoSource(file)!, file).length,
    })),
    transitiveActionCoverage: `The checked-in child-control catalog exactly matches the recursively discovered team/change-review/provider renderer closure. Every scanner-visible site maps once to a reviewed semantic action or deliberate absence; direct renderer IPC callers remain bound to the ${apiRows.length}-member parity ledger. Every other production team TSX file is listed as excluded and rechecked as unreachable from these roots.`,
    actions,
    apiActionBindings,
    legacyChildApiActionBindings,
    deliberateAbsences,
    dynamicDispatch: {
      unannotatedCount: 0,
      annotation: '@hosted-web-dynamic-action <semantic-id>',
    },
  });
  writeJson(join(outputRoot, 'legacy-bypass-inventory.json'), {
    schemaId: 'p0-w1-legacy-bypass-inventory',
    evidenceId: 'P0.W1.LEGACY_BYPASSES',
    ...envelope,
    summary: bypasses.summary,
    rawArtifact: {
      format: 'deterministically sorted compact JSON',
      recordCount: bypasses.rows.length,
      sha256: rawHash,
      externalPath: basename(rawPath),
      pathScope: 'artifact-pack-relative',
      reproductionCommand:
        'W1_RAW_EVIDENCE_ROOT=<artifact-pack-dir> node --import tsx scripts/hosted-web/phase-0/parity-renderer/scan-api-and-actions.ts',
    },
    requiredDisposition:
      'Supported hosted actions use a real feature facet; unavailable and desktop-only controls are absent before mount. No optional-method check or fabricated success is capability proof.',
  });
  const buckets = [
    {
      bucketId: 'EST-CONTRACTS',
      packages: ['shared capability/action contracts', 'ADR-19 parity gate'],
      productionLines: { low: 1200, high: 1800 },
      testLines: { low: 800, high: 1200 },
      deletedLines: { low: 0, high: 0 },
      netLines: { low: 2000, high: 3000 },
      excludedGeneratedVendorLines: ['Phase 0 evidence', 'lockfiles', 'vendor'],
      overlap: 'W1 parity contracts only.',
      confidence: 'high',
      assumptions: ['No replacement mega-interface.'],
      evidenceRefs: ['P0.W1.API_PARITY_LEDGER', 'P0.W1.SCANNER'],
    },
    {
      bucketId: 'EST-RENDERER-LIFECYCLE',
      packages: ['team-console', 'team lifecycle renderer composition'],
      productionLines: { low: 1800, high: 2800 },
      testLines: { low: 1200, high: 2000 },
      deletedLines: { low: 900, high: 1600 },
      netLines: { low: 2100, high: 3200 },
      excludedGeneratedVendorLines: ['Phase 0 evidence', 'format churn'],
      overlap: 'Task/message/review/provider actions stay with their canonical owners.',
      confidence: 'medium',
      assumptions: ['Desktop-only controls are absent before hosted mount.'],
      evidenceRefs: ['P0.W1.RENDERER_ACTIONS', 'P0.W1.SELECTION_INVARIANTS'],
    },
    {
      bucketId: 'EST-REMAINING-PARITY',
      packages: [
        'team-task-board',
        'team-messaging',
        'team-review',
        'team-approvals',
        'agent-attachments',
      ],
      productionLines: { low: 2500, high: 3900 },
      testLines: { low: 1500, high: 2600 },
      deletedLines: { low: 1200, high: 2300 },
      netLines: { low: 2800, high: 4200 },
      excludedGeneratedVendorLines: ['Phase 0 evidence', 'post-v1 terminal'],
      overlap: 'Server/runtime/auth work remains in its owning non-W1 bucket.',
      confidence: 'medium-low',
      assumptions: ['One owning feature per semantic action.'],
      evidenceRefs: ['P0.W1.API_PARITY_LEDGER', 'P0.W1.RENDERER_ACTIONS', 'P0.W1.LEGACY_BYPASSES'],
    },
  ];
  writeJson(join(outputRoot, 'estimate-input.json'), {
    schemaId: 'p0-w1-estimate-input',
    evidenceId: 'P0.W1.ESTIMATE',
    ...envelope,
    unit: 'net integrated source lines; aligned low/high = production + test - deleted',
    buckets,
    varianceAssessment: {
      parentRangeStillSupported: false,
      uniqueBucketOverTwentyPercent: true,
      scopeReviewRequired: true,
      changes: [
        {
          bucketId: 'EST-RENDERER-LIFECYCLE',
          baseline: { low: 3000, high: 5000 },
          recomputed: { low: 2100, high: 3200 },
          variancePercent: { low: -30, high: -36 },
        },
        {
          bucketId: 'EST-REMAINING-PARITY',
          baseline: { low: 4000, high: 6500 },
          recomputed: { low: 2800, high: 4200 },
          variancePercent: { low: -30, high: -35.38 },
        },
      ],
      controllerDisposition:
        'scope review required before estimate freeze; W1 does not suppress or self-approve either variance',
    },
  });
  evidenceSchemas(outputRoot);
  const generatedJsonPaths = [
    'api-parity-ledger',
    'renderer-action-inventory',
    'legacy-bypass-inventory',
    'estimate-input',
  ].flatMap((stem) => [
    join(outputRoot, `${stem}.json`),
    join(outputRoot, 'schemas', `${stem}.schema.json`),
  ]);
  generatedJsonPaths.push(
    join(outputRoot, 'schemas', 'renderer-child-control-catalog.schema.json')
  );
  execFileSync(
    process.execPath,
    [join(repoRoot, 'node_modules/prettier/bin/prettier.cjs'), '--write', ...generatedJsonPaths],
    { cwd: repoRoot, stdio: 'ignore' }
  );
  for (const stem of [
    'api-parity-ledger',
    'renderer-action-inventory',
    'renderer-child-control-catalog',
    'legacy-bypass-inventory',
    'estimate-input',
  ]) {
    const document = JSON.parse(readFileSync(join(outputRoot, `${stem}.json`), 'utf8')) as unknown;
    const schema = JSON.parse(
      readFileSync(join(outputRoot, 'schemas', `${stem}.schema.json`), 'utf8')
    ) as SchemaNode;
    validateJsonSchema(document, schema, stem);
  }
  return { rawPath, rawHash, apiCount: apiRows.length, controlCount: sites.length };
}

function findRoot(start: string): string {
  let current = resolve(start);
  while (!existsSync(join(current, 'package.json'))) {
    const parent = dirname(current);
    if (parent === current) throw new Error('Repository root not found');
    current = parent;
  }
  return current;
}

if (process.argv[1]?.endsWith('scan-api-and-actions.ts')) {
  const result = generateEvidence(findRoot(process.cwd()), process.env.W1_RAW_EVIDENCE_ROOT);
  console.log(JSON.stringify({ status: 'ok', ...result }));
}
