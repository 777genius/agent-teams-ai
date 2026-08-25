#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const requireFromFastify = createRequire(require.resolve('fastify/package.json'));
const Ajv = requireFromFastify('ajv');

const indexDir = dirname(fileURLToPath(import.meta.url));
let repoRoot = indexDir;
while (!existsSync(resolve(repoRoot, 'package.json'))) {
  const parent = dirname(repoRoot);
  if (parent === repoRoot) throw new Error('repository root not found');
  repoRoot = parent;
}

const includeControllerExternal = process.argv.includes('--include-controller-external');
const indexFiles = [
  'lane-identity-index.json',
  'review-disposition-index.json',
  'decision-index.json',
  'evidence-index.json',
  'supersession-index.json',
];
const fixtureFiles = ['omission.json', 'stale-hash.json', 'duplicate-id.json'];
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));
const indexes = new Map(indexFiles.map((name) => [name, readJson(resolve(indexDir, name))]));

const ajv = new Ajv({ allErrors: true, jsonPointers: true });
const validateIndex = ajv.compile(readJson(resolve(indexDir, 'canonical-index.schema.json')));
const validateFixture = ajv.compile(readJson(resolve(indexDir, 'negative-fixture.schema.json')));

class ValidationFailure extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new ValidationFailure(code, message);
};

const assertUnique = (rows, field, collection) => {
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row[field])) fail('DUPLICATE_ID', `${collection} repeats ${row[field]}`);
    seen.add(row[field]);
  }
};

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');

const hashAtCommit = (commit, path) => {
  try {
    return sha256Bytes(
      execFileSync('git', ['show', `${commit}:${path}`], {
        cwd: repoRoot,
        encoding: null,
        maxBuffer: 128 * 1024 * 1024,
      })
    );
  } catch (error) {
    if (error?.status === 0 && error?.stdout) return sha256Bytes(error.stdout);
    fail('GIT_PROVENANCE_MISSING', `${commit}:${path}`);
  }
};

const checkPathHash = ({ path, sha256: expected, scope = 'repository' }) => {
  if (scope === 'controller-external' && !includeControllerExternal) return;
  const absolute = isAbsolute(path) ? path : resolve(repoRoot, path);
  if (!existsSync(absolute)) fail('PATH_MISSING', path);
  const actual = sha256(absolute);
  if (actual !== expected) fail('STALE_HASH', `${path}: expected ${expected}, received ${actual}`);
};

const validateSemantics = (allIndexes) => {
  const laneIndex = allIndexes.get('lane-identity-index.json');
  const reviewIndex = allIndexes.get('review-disposition-index.json');
  const decisionIndex = allIndexes.get('decision-index.json');
  const evidenceIndex = allIndexes.get('evidence-index.json');
  const supersessionIndex = allIndexes.get('supersession-index.json');

  const expectedCurrentCommit = 'f4fa24aac9615a4ce10632965a2244a2e11a273e';
  for (const [name, index] of allIndexes) {
    if (index.currentIntegrationCommit !== expectedCurrentCommit) {
      fail('INTEGRATION_COMMIT_MISMATCH', `${name} does not pin accepted freeze f4fa24aa`);
    }
    if (
      index.freezeCandidate?.baseCommit !== expectedCurrentCommit ||
      index.freezeCandidate?.status !== 'accepted-frozen' ||
      index.freezeCandidate?.integrationCommit !== expectedCurrentCommit
    ) {
      fail('CANDIDATE_PROVENANCE_MISMATCH', `${name} does not freeze the accepted candidate`);
    }
  }

  const expectedLanes = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'];
  assertUnique(laneIndex.lanes, 'laneId', 'lanes');
  const actualLanes = laneIndex.lanes.map(({ laneId }) => laneId).sort();
  if (JSON.stringify(actualLanes) !== JSON.stringify(expectedLanes)) {
    fail('MISSING_LANE', `expected ${expectedLanes.join(',')}; received ${actualLanes.join(',')}`);
  }

  const expectedLaneIdentity = {
    w1: {
      producerJobId: 'agent-teams-hosted-web-refactor-phase-00-remediation-w1-v9',
      packetRevision: 'phase-00-r2',
      sourceBaseSha: 'f7d98790eb868714e536f77bd796072ea706911a',
      integratedAtCommit: 'a6bd7a39aebb4d822f57707c96c5e071b2aecb2b',
    },
    w2: {
      producerJobId: 'agent-teams-hosted-web-refactor-phase-00-w2-targeted-fix-a1',
      packetRevision: 'phase-00-r2',
      sourceBaseSha: 'c72fd201867b9bcd1ef77d5e0f95ba379adb4fca',
      integratedAtCommit: '6d54e7c60d29812de5b96e471761486fbbc0842c',
    },
    w3: {
      producerJobId: 'agent-teams-hosted-web-refactor-phase-00-remediation-w3-v1',
      packetRevision: 'phase-00-r2',
      sourceBaseSha: '0e8431b1935c71a2e77bea1384b134ee25c8aa12',
      integratedAtCommit: '7f23e7b628b09e8fbed71c914af5e665f14dab25',
    },
    w4: {
      producerJobId: 'agent-teams-hosted-web-refactor-phase-00-remediation-w4-w6-v7',
      packetRevision: 'phase-00-r3',
      sourceBaseSha: 'f7d98790eb868714e536f77bd796072ea706911a',
      integratedAtCommit: 'c72fd201867b9bcd1ef77d5e0f95ba379adb4fca',
    },
    w5: {
      producerJobId: 'agent-teams-hosted-web-refactor-phase-00-remediation-w5-v3',
      packetRevision: 'phase-00-r2',
      sourceBaseSha: '648bebed68f5a64c984e83b441e14dd7c587c403',
      integratedAtCommit: '5d723407f287767c0f30f3d708459fb943256eaf',
    },
    w6: {
      producerJobId: 'agent-teams-hosted-web-refactor-phase-00-remediation-w4-w6-v7',
      packetRevision: 'phase-00-r3',
      sourceBaseSha: 'f7d98790eb868714e536f77bd796072ea706911a',
      integratedAtCommit: '3bc0dfa7c00261785c0c752270cb302a9294e751',
    },
  };

  for (const lane of laneIndex.lanes) {
    if (lane.phaseStartSha !== laneIndex.phaseStartSha) {
      fail('PHASE_START_MISMATCH', `${lane.laneId} does not use the controller phase start`);
    }
    for (const [field, expected] of Object.entries(expectedLaneIdentity[lane.laneId])) {
      if (lane[field] !== expected) {
        fail('LANE_IDENTITY_MISMATCH', `${lane.laneId}.${field} differs from integration history`);
      }
    }
    checkPathHash(lane.handoff);
    if (!lane.integrationHistory.some(({ commit }) => commit === lane.integratedAtCommit)) {
      fail(
        'INTEGRATION_COMMIT_MISMATCH',
        `${lane.laneId} latest commit is absent from its history`
      );
    }
  }

  const expectedEvidenceById = new Map();
  for (const lane of laneIndex.lanes) {
    const handoff = readJson(resolve(repoRoot, lane.handoff.path));
    for (const row of handoff.evidence) {
      if (expectedEvidenceById.has(row.id)) {
        fail('DUPLICATE_ID', `lane handoffs repeat ${row.id}`);
      }
      expectedEvidenceById.set(row.id, {
        laneId: lane.laneId,
        path: row.path,
        proofLevel: row.proofLevel,
      });
    }
  }

  assertUnique(reviewIndex.reviews, 'reviewId', 'reviews');
  for (const review of reviewIndex.reviews) review.sources.forEach(checkPathHash);

  const expectedAuthorities = {
    'P0.CURRENT.AUTHORITY.ESTIMATE': {
      commit: 'f4fa24aac9615a4ce10632965a2244a2e11a273e',
      role: 'estimate',
    },
    'P0.CURRENT.AUTHORITY.FINAL_GATE': {
      commit: '63ff349e14e44a83d363ccbcdd756af935555aa9',
      role: 'final-gate',
    },
    'P0.CURRENT.AUTHORITY.NAVIGATION': {
      commit: 'f32be6a6fcb2da7a47ef3553476430ef8052e19a',
      role: 'navigation',
    },
    'P0.CURRENT.AUTHORITY.ORCHESTRATION': {
      commit: '1587615c751c3cb12b5078ab4b7264b6e9fd42ad',
      role: 'orchestration',
    },
    'P0.CURRENT.AUTHORITY.TARGET_IMAGE': {
      commit: '3bc0dfa7c00261785c0c752270cb302a9294e751',
      role: 'target-image-narrowing',
    },
  };
  assertUnique(reviewIndex.acceptedAuthorities, 'authorityId', 'acceptedAuthorities');
  if (reviewIndex.acceptedAuthorities.length !== Object.keys(expectedAuthorities).length) {
    fail('MISSING_PROVENANCE', 'accepted authority count differs from the frozen set');
  }
  for (const authority of reviewIndex.acceptedAuthorities) {
    const expected = expectedAuthorities[authority.authorityId];
    if (
      !expected ||
      authority.commit !== expected.commit ||
      authority.role !== expected.role ||
      authority.disposition !== 'accepted'
    ) {
      fail('ADOPTION_PROVENANCE_MISMATCH', authority.authorityId);
    }
    checkPathHash(authority.source);
    if (hashAtCommit(authority.commit, authority.source.path) !== authority.source.sha256) {
      fail('GIT_PROVENANCE_MISMATCH', `${authority.authorityId} manifest`);
    }
    try {
      execFileSync(
        'git',
        ['merge-base', '--is-ancestor', authority.commit, expectedCurrentCommit],
        {
          cwd: repoRoot,
          stdio: 'ignore',
        }
      );
    } catch {
      fail(
        'CANDIDATE_PROVENANCE_MISMATCH',
        `${authority.authorityId} is not in the freeze ancestry`
      );
    }
  }

  assertUnique(decisionIndex.decisions, 'decisionId', 'decisions');
  for (const decision of decisionIndex.decisions) {
    for (const path of decision.authorityPaths) {
      if (!existsSync(resolve(repoRoot, path))) fail('PATH_MISSING', path);
    }
  }

  assertUnique(evidenceIndex.evidence, 'evidenceId', 'evidence');
  const indexedEvidenceIds = evidenceIndex.evidence.map(({ evidenceId }) => evidenceId).sort();
  const handoffEvidenceIds = [...expectedEvidenceById.keys()].sort();
  if (JSON.stringify(indexedEvidenceIds) !== JSON.stringify(handoffEvidenceIds)) {
    fail('MISSING_PROVENANCE', 'evidence IDs differ from the six hashed lane handoffs');
  }
  const laneById = new Map(laneIndex.lanes.map((lane) => [lane.laneId, lane]));
  for (const laneId of expectedLanes) {
    if (!evidenceIndex.evidence.some((row) => row.laneId === laneId)) {
      fail('MISSING_LANE', `evidence index omits ${laneId}`);
    }
  }
  for (const row of evidenceIndex.evidence) {
    const handoffRow = expectedEvidenceById.get(row.evidenceId);
    if (
      row.laneId !== handoffRow.laneId ||
      row.path !== handoffRow.path ||
      row.proofLevel !== handoffRow.proofLevel
    ) {
      fail('EVIDENCE_PROVENANCE_MISMATCH', row.evidenceId);
    }
    checkPathHash({ path: row.path, sha256: row.sha256, scope: 'repository' });
    const lane = laneById.get(row.laneId);
    const laneCommits = new Set(lane.integrationHistory.map(({ commit }) => commit));
    if (row.byteState === 'pending-integration') {
      if (
        row.integratedAtCommit !== null ||
        !laneCommits.has(row.derivedFromCommit) ||
        !lane.pendingCandidatePaths?.includes(row.path)
      ) {
        fail('CANDIDATE_PROVENANCE_MISMATCH', row.evidenceId);
      }
    } else {
      if (!laneCommits.has(row.integratedAtCommit)) {
        fail(
          'INTEGRATION_COMMIT_MISMATCH',
          `${row.evidenceId} is absent from ${row.laneId} history`
        );
      }
      const committedHash = hashAtCommit(row.integratedAtCommit, row.path);
      if (committedHash !== row.sha256) {
        fail(
          'GIT_PROVENANCE_MISMATCH',
          `${row.evidenceId}: ${row.integratedAtCommit} has ${committedHash}, index has ${row.sha256}`
        );
      }
    }
  }

  const expectedLaterBytes = {
    'P0.W1.RENDERER_ACTIONS': {
      commit: '0d1a82fe2fb0c8d73b62cd3b5996b853bef2d7c3',
      disposition: 'narrowed',
      decisionId: 'P0.CURRENT.W1.LATER_BYTES',
    },
    'P0.W1.RENDERER_CHILD_CONTROLS': {
      commit: '0d1a82fe2fb0c8d73b62cd3b5996b853bef2d7c3',
      disposition: 'narrowed',
      decisionId: 'P0.CURRENT.W1.LATER_BYTES',
    },
    'P0.W1.LEGACY_BYPASSES': {
      commit: 'a6bd7a39aebb4d822f57707c96c5e071b2aecb2b',
      disposition: 'narrowed',
      decisionId: 'P0.CURRENT.W1.LATER_BYTES',
    },
    'P0.W1.SCANNER': {
      commit: 'a6bd7a39aebb4d822f57707c96c5e071b2aecb2b',
      disposition: 'narrowed',
      decisionId: 'P0.CURRENT.W1.LATER_BYTES',
    },
    'P0.W2.ENVIRONMENT_PROVENANCE': {
      commit: '6d54e7c60d29812de5b96e471761486fbbc0842c',
      disposition: 'narrowed',
      decisionId: 'P0.CURRENT.W2.LATER_BYTES',
    },
    'P0.W2.CREDENTIAL_EXPOSURE_MATRIX': {
      commit: '6d54e7c60d29812de5b96e471761486fbbc0842c',
      disposition: 'narrowed',
      decisionId: 'P0.CURRENT.W2.LATER_BYTES',
    },
    'P0.W2.RUNTIME_SCANNER': {
      commit: '6d54e7c60d29812de5b96e471761486fbbc0842c',
      disposition: 'narrowed',
      decisionId: 'P0.CURRENT.W2.LATER_BYTES',
    },
    'P0.W5.COMMAND_CATALOG': {
      commit: '5d723407f287767c0f30f3d708459fb943256eaf',
      disposition: 'narrowed',
      decisionId: 'P0.CURRENT.W5.LATER_BYTES',
    },
    'P0.W5.EFFECT_RECOVERY_MATRIX': {
      commit: '5d723407f287767c0f30f3d708459fb943256eaf',
      disposition: 'narrowed',
      decisionId: 'P0.CURRENT.W5.LATER_BYTES',
    },
    'P0.W5.SUPPORTING.MUTATION_CENSUS': {
      commit: '5d723407f287767c0f30f3d708459fb943256eaf',
      disposition: 'narrowed',
      decisionId: 'P0.CURRENT.W5.LATER_BYTES',
    },
    'P0.W5.SUPPORTING.MUTATION_SURFACE_MANIFEST': {
      commit: '5d723407f287767c0f30f3d708459fb943256eaf',
      disposition: 'narrowed',
      decisionId: 'P0.CURRENT.W5.LATER_BYTES',
    },
  };
  const decisionIds = new Set(decisionIndex.decisions.map(({ decisionId }) => decisionId));
  for (const [evidenceId, expected] of Object.entries(expectedLaterBytes)) {
    const row = evidenceIndex.evidence.find((candidate) => candidate.evidenceId === evidenceId);
    if (
      row?.integratedAtCommit !== expected.commit ||
      row?.adoptionDisposition !== expected.disposition ||
      row?.adoptionDecisionId !== expected.decisionId ||
      !decisionIds.has(expected.decisionId)
    ) {
      fail('ADOPTION_PROVENANCE_MISMATCH', evidenceId);
    }
  }

  const laterReviewByDecision = {
    'P0.CURRENT.W1.LATER_BYTES': {
      reviewId: 'P0.CURRENT.REVIEW.W1',
      commit: '0d1a82fe2fb0c8d73b62cd3b5996b853bef2d7c3',
    },
    'P0.CURRENT.W2.LATER_BYTES': {
      reviewId: 'P0.CURRENT.REVIEW.W2',
      commit: '6d54e7c60d29812de5b96e471761486fbbc0842c',
    },
    'P0.CURRENT.W5.LATER_BYTES': {
      reviewId: 'P0.CURRENT.REVIEW.W3_W5',
      commit: '5d723407f287767c0f30f3d708459fb943256eaf',
    },
  };
  for (const [decisionId, expected] of Object.entries(laterReviewByDecision)) {
    const review = reviewIndex.reviews.find(({ reviewId }) => reviewId === expected.reviewId);
    const disposition = review?.commitDispositions.find(({ commit }) => commit === expected.commit);
    const expectedPaths = evidenceIndex.evidence
      .filter(({ adoptionDecisionId }) => adoptionDecisionId === decisionId)
      .map(({ path }) => path);
    if (
      disposition?.disposition !== 'narrowed' ||
      expectedPaths.some((path) => !disposition.paths.includes(path))
    ) {
      fail('ADOPTION_PROVENANCE_MISMATCH', `${decisionId} review projection`);
    }
  }
  for (const [reviewId, commit] of [
    ['P0.CURRENT.REVIEW.W1', 'a6bd7a39aebb4d822f57707c96c5e071b2aecb2b'],
    ['P0.CURRENT.REVIEW.W4_W6', '3bc0dfa7c00261785c0c752270cb302a9294e751'],
  ]) {
    const disposition = reviewIndex.reviews
      .find((review) => review.reviewId === reviewId)
      ?.commitDispositions.find((candidate) => candidate.commit === commit);
    if (disposition?.disposition !== 'narrowed') {
      fail('ADOPTION_PROVENANCE_MISMATCH', `${reviewId} ${commit}`);
    }
  }

  const legacyBypasses = readJson(
    resolve(
      repoRoot,
      'docs/research/hosted-web/phase-0/parity-renderer/legacy-bypass-inventory.json'
    )
  );
  if (
    legacyBypasses.rawArtifact?.externalPath !== 'legacy-bypass-raw.json' ||
    legacyBypasses.rawArtifact?.pathScope !== 'artifact-pack-relative' ||
    /(^|\/)tmp\//.test(legacyBypasses.rawArtifact?.externalPath ?? '') ||
    !legacyBypasses.rawArtifact?.reproductionCommand?.includes(
      'scripts/hosted-web/phase-0/parity-renderer/scan-api-and-actions.ts'
    )
  ) {
    fail(
      'NON_PORTABLE_PROVENANCE',
      'legacy bypass raw artifact is not pack-relative and reproducible'
    );
  }

  const requiredDecisions = {
    'P0.CURRENT.PHASE0_FREEZE': 'accepted',
    'P0.CURRENT.PHASE1_AUTHORITY': 'narrowed',
    'P0.CURRENT.ORCHESTRATION_AUTHORITY': 'accepted',
    'P0.CURRENT.NAVIGATION_AUTHORITY': 'accepted',
    'P0.CURRENT.ESTIMATE_AUTHORITY': 'accepted',
  };
  for (const [decisionId, status] of Object.entries(requiredDecisions)) {
    if (
      decisionIndex.decisions.find((decision) => decision.decisionId === decisionId)?.status !==
      status
    ) {
      fail('READINESS_AUTHORITY_MISMATCH', decisionId);
    }
  }

  const phase1Readme = readFileSync(
    resolve(repoRoot, 'docs/hosted-web-phases/phase-01/README.md'),
    'utf8'
  );
  const phase1Packet = readFileSync(
    resolve(repoRoot, 'docs/hosted-web-phases/phase-01/controller-packet.md'),
    'utf8'
  );
  const phase1Dag = readFileSync(
    resolve(repoRoot, 'docs/hosted-web-phases/phase-01/execution-dag.md'),
    'utf8'
  );
  const executionIndex = readJson(resolve(repoRoot, 'docs/hosted-web-phases/EXECUTION_INDEX.json'));
  const revivedHistoricalClaim = [
    'Both rejected',
    'Pair rejected with RW35',
    'Pair rejected with R46',
    'Holds all adoption',
  ].find((claim) => `${phase1Readme}\n${phase1Packet}\n${phase1Dag}`.includes(claim));
  if (
    revivedHistoricalClaim ||
    executionIndex.acceptedPhase0Freeze?.commit !== expectedCurrentCommit ||
    executionIndex.acceptedPhase0Freeze?.status !== 'accepted-frozen'
  ) {
    fail('SUPERSESSION_PROJECTION_MISMATCH', revivedHistoricalClaim ?? 'accepted freeze missing');
  }
  if (
    executionIndex.currentExecutablePhase !== 'phase-01' ||
    executionIndex.currentExecutableSubphase !== 'P1.S0' ||
    JSON.stringify(executionIndex.authorization?.authorized) !== JSON.stringify(['P1.S0']) ||
    executionIndex.authorization?.productSourceImplementationAuthorized !== false ||
    !phase1Readme.includes('current for `P1.S0` serial bootstrap only') ||
    !phase1Packet.includes('current execution authority for serial `P1.S0` only') ||
    !phase1Packet.includes('Later-subphase producer target: **zero**') ||
    !phase1Dag.includes('`-X->` is a blocked transition')
  ) {
    fail('PHASE1_AUTHORITY_MISMATCH', 'Phase 1 is not restricted to serial P1.S0');
  }

  assertUnique(supersessionIndex.supersessions, 'supersessionId', 'supersessions');
  for (const row of supersessionIndex.supersessions) {
    row.sources.forEach(checkPathHash);
    if (!existsSync(resolve(repoRoot, row.replacementIndex))) {
      fail('PATH_MISSING', row.replacementIndex);
    }
  }

  const w2 = laneById.get('w2');
  if (
    w2.phaseStartSha !== 'a32f509e6d9bd31ba2135940e336729bf90c3d93' ||
    w2.sourceBaseSha !== 'c72fd201867b9bcd1ef77d5e0f95ba379adb4fca'
  ) {
    fail('PHASE_START_MISMATCH', 'W2 phase start/source-base correction is absent');
  }
  const w2Supersession = supersessionIndex.supersessions.find(
    ({ supersessionId }) => supersessionId === 'P0.CURRENT.SUPERSESSION.W2_INCORRECT_PHASE_START'
  );
  if (
    !w2Supersession?.supersededClaims.includes(
      'phaseStartSha=c72fd201867b9bcd1ef77d5e0f95ba379adb4fca'
    )
  ) {
    fail('PHASE_START_MISMATCH', 'W2 historical claim is not explicitly superseded');
  }
  const expectedW2PhaseStartSources = [
    '.codex-handoff/phase-00-w2.json',
    'docs/research/hosted-web/phase-0/provider-runtime/README.md',
    'docs/research/hosted-web/phase-0/provider-runtime/credential-exposure-matrix.json',
    'docs/research/hosted-web/phase-0/provider-runtime/environment-provenance.json',
    'docs/research/hosted-web/phase-0/provider-runtime/estimate-input.json',
    'docs/research/hosted-web/phase-0/provider-runtime/execution-topology.json',
    'docs/research/hosted-web/phase-0/provider-runtime/fake-runtime-fixture-matrix.json',
    'docs/research/hosted-web/phase-0/provider-runtime/runtime-ingress-inventory.json',
    'docs/research/hosted-web/phase-0/provider-runtime/schemas/credential-exposure-matrix.schema.json',
    'docs/research/hosted-web/phase-0/provider-runtime/schemas/environment-provenance.schema.json',
    'docs/research/hosted-web/phase-0/provider-runtime/schemas/estimate-input.schema.json',
    'docs/research/hosted-web/phase-0/provider-runtime/schemas/execution-topology.schema.json',
    'docs/research/hosted-web/phase-0/provider-runtime/schemas/fake-runtime-fixture-matrix.schema.json',
    'docs/research/hosted-web/phase-0/provider-runtime/schemas/runtime-ingress-inventory.schema.json',
  ].sort();
  const actualW2PhaseStartSources = w2Supersession.sources.map(({ path }) => path).sort();
  if (JSON.stringify(actualW2PhaseStartSources) !== JSON.stringify(expectedW2PhaseStartSources)) {
    fail('MISSING_PROVENANCE', 'W2 incorrect phase-start source set is incomplete or excessive');
  }
};

for (const [name, value] of indexes) {
  if (!validateIndex(value)) {
    fail('SCHEMA', `${name}: ${JSON.stringify(validateIndex.errors)}`);
  }
}
validateSemantics(indexes);

const applyMutation = (target, mutation) => {
  if (mutation.type === 'omit-lane') {
    target.lanes = target.lanes.filter(({ laneId }) => laneId !== mutation.laneId);
    return;
  }
  if (mutation.type === 'replace-evidence-hash') {
    const row = target.evidence.find(({ evidenceId }) => evidenceId === mutation.evidenceId);
    if (!row) fail('FIXTURE_INVALID', mutation.evidenceId);
    row.sha256 = mutation.replacementSha256;
    return;
  }
  if (mutation.type === 'duplicate-first-id') {
    target[mutation.collection].push(clone(target[mutation.collection][0]));
    return;
  }
  if (mutation.type === 'omit-supersession-source') {
    const row = target.supersessions.find(
      ({ supersessionId }) => supersessionId === mutation.supersessionId
    );
    if (!row) fail('FIXTURE_INVALID', mutation.supersessionId);
    row.sources = row.sources.filter(({ path }) => path !== mutation.path);
    return;
  }
  fail('FIXTURE_INVALID', mutation.type);
};

for (const fixtureName of fixtureFiles) {
  const fixture = readJson(resolve(indexDir, 'fixtures', fixtureName));
  if (!validateFixture(fixture)) {
    fail('SCHEMA', `${fixtureName}: ${JSON.stringify(validateFixture.errors)}`);
  }
  const mutated = new Map([...indexes].map(([name, value]) => [name, clone(value)]));
  applyMutation(mutated.get(fixture.targetIndex), fixture.mutation);
  let observedCode = 'NO_FAILURE';
  try {
    validateSemantics(mutated);
  } catch (error) {
    if (!(error instanceof ValidationFailure)) throw error;
    observedCode = error.code;
  }
  if (observedCode !== fixture.expectedCode) {
    fail(
      'NEGATIVE_FALSE_GREEN',
      `${fixture.fixtureId}: expected ${fixture.expectedCode}, received ${observedCode}`
    );
  }
}

process.stdout.write(
  `Phase 0 current canonical indexes passed: 5 schemas, ${indexes.get('evidence-index.json').evidence.length} evidence IDs, 5 accepted authorities, 3 focused negatives${includeControllerExternal ? ', controller-external hashes checked' : ''}.\n`
);
