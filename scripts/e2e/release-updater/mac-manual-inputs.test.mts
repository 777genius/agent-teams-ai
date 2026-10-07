import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonical, digest, platformNames, textProof } from '../../ci/release/contract.ts';
import {
  checkManualArtifact,
  checkManualBundle,
  checkManualContext,
  checkManualEntries,
  checkManualReleaseReread,
  manualNames,
  manualProducer,
  manualUpload,
  manualWorkflow,
  oldManualDmg,
} from './mac-manual-inputs.mts';
import { nativePredecessor } from './native-release-scenario.mts';

import type { Release, StagePlan } from '../../ci/release/contract.ts';
import type { MacArtifactAuthority } from './mac-input-artifact.mts';
import type { ManualBundle } from './mac-manual-inputs.mts';

// These fail on target/predecessor substitution, stale producer attempts, or unsafe archive paths.
function fixture() {
  const names = platformNames('2.17.7');
  const originals = [
    ...names.windows,
    ...names.linux,
    ...names.windows.map((name) => `${name}.blockmap`),
    ...names.mac,
  ].map((name, index) => ({
    ...textProof(name, `TEST-${name}`),
    assetId: 100 + index,
    releaseId: 999,
    tag: 'v2.17.7',
  }));
  const plan: StagePlan = {
    schemaVersion: 1,
    input: {
      repository: '777genius/agent-teams-ai',
      mode: 'full',
      toolingSha: '1'.repeat(40),
      target: {
        id: 999,
        tag: 'v2.17.7',
        applicationSha: '2'.repeat(40),
        createdAt: '2026-10-07T00:00:00Z',
        name: 'TEST',
        body: null,
      },
      latest: { id: 998, tag: 'v2.17.6' },
      originals,
      macSource: null,
      macProductMinimum: '13.0',
      build: { runId: 1, attempt: 1, jobIds: [2] },
    },
    aliases: {},
    feeds: {},
    outputs: [],
  };
  const expected = {
    toolingSha: plan.input.toolingSha,
    planDigest: digest(canonical(plan)),
    inputDigest: digest(canonical(plan.input)),
    runId: 10,
    attempt: 1,
  };
  const bundle: ManualBundle = {
    schemaVersion: 1,
    ...expected,
    sourceSha: plan.input.target.applicationSha,
    prepared: {
      repository: plan.input.repository,
      workflow: '.github/workflows/stage-existing-partial-draft.yml',
      runId: 5,
      attempt: 1,
      jobId: 6,
      artifactId: 7,
      artifactName: 'existing-draft-stage-plan',
      artifactSha256: '3'.repeat(64),
      toolingSha: expected.toolingSha,
      planDigest: expected.planDigest,
      inputDigest: expected.inputDigest,
    },
    downloads: [],
  };
  for (const architecture of ['arm64', 'x64'] as const) {
    for (const original of originals.filter(
      (item) =>
        manualNames(architecture).dmg === item.name || manualNames(architecture).zip === item.name
    ))
      bundle.downloads.push({
        architecture,
        releaseId: original.releaseId,
        assetId: original.assetId,
        proof: original,
      });
    const pin = oldManualDmg[architecture];
    bundle.downloads.push({
      architecture,
      releaseId: nativePredecessor.id,
      assetId: pin.id,
      proof: {
        ...textProof(manualNames(architecture).old, 'TEST'),
        size: pin.size,
        sha256: pin.sha256,
      },
    });
  }
  return { plan, expected, bundle };
}
void test('217 target is independent of frozen211 and captured latest216', () => {
  const { plan, expected, bundle } = fixture();
  checkManualBundle(bundle, plan, expected);
  assert.equal(
    bundle.downloads.filter((item) => item.releaseId === nativePredecessor.id).length,
    2
  );
  assert.equal(
    bundle.downloads.filter((item) => item.releaseId === plan.input.target.id).length,
    4
  );
});
for (const variation of [
  'target-sha',
  'target-asset',
  'target-bytes',
  'old-asset',
  'old-bytes',
  'architecture',
  'duplicate',
  'floor',
  'carry',
  'tooling',
  'prepared-plan',
] as const)
  void test(`rejects ${variation} substitution`, () => {
    const { plan, expected, bundle } = fixture();
    const target = bundle.downloads[0];
    const old = bundle.downloads.find((item) => item.releaseId === nativePredecessor.id);
    assert(target && old);
    if (variation === 'target-sha') bundle.sourceSha = '0'.repeat(40);
    if (variation === 'target-asset') target.assetId++;
    if (variation === 'target-bytes') target.proof = { ...target.proof, sha256: '0'.repeat(64) };
    if (variation === 'old-asset') old.assetId++;
    if (variation === 'old-bytes') old.proof.sha256 = '0'.repeat(64);
    if (variation === 'architecture') old.architecture = 'x64';
    if (variation === 'duplicate') bundle.downloads.push(structuredClone(target));
    if (variation === 'floor') plan.input.macProductMinimum = '12.0';
    if (variation === 'carry') plan.input.mode = 'carry-mac';
    if (variation === 'tooling') bundle.toolingSha = '0'.repeat(40);
    if (variation === 'prepared-plan') bundle.prepared.planDigest = '0'.repeat(64);
    assert.throws(() => checkManualBundle(bundle, plan, expected));
  });
function artifactFixture() {
  const expected = {
    toolingSha: '1'.repeat(40),
    runId: 10,
    attempt: 2,
    artifactId: 12,
    artifactSha256: '2'.repeat(64),
  };
  const authority: MacArtifactAuthority = {
    run: {
      id: 10,
      head_sha: expected.toolingSha,
      run_attempt: 2,
      path: manualWorkflow,
      event: 'workflow_dispatch',
      status: 'in_progress',
    },
    job: {
      id: 11,
      run_id: 10,
      name: manualProducer,
      status: 'completed',
      conclusion: 'success',
      started_at: '2026-10-07T00:00:00Z',
      completed_at: '2026-10-07T00:01:00Z',
      steps: [
        {
          name: manualUpload,
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-10-07T00:00:30Z',
          completed_at: '2026-10-07T00:00:59Z',
        },
      ],
    },
    attemptJobIds: [11],
    artifact: {
      id: 12,
      name: 'TEST-mac-manual-inputs-10-2',
      digest: `sha256:${expected.artifactSha256}`,
      expired: false,
      created_at: '2026-10-07T00:00:58Z',
      workflow_run: { id: 10, head_sha: expected.toolingSha },
    },
    archiveSha256: expected.artifactSha256,
  };
  return { authority, expected };
}
void test('accepts only completed producer/upload of current attempt', () => {
  const { authority, expected } = artifactFixture();
  checkManualArtifact(authority, expected);
});
for (const variation of [
  'attempt',
  'workflow',
  'job',
  'upload',
  'time',
  'head',
  'archive',
  'expired',
] as const)
  void test(`rejects artifact ${variation}`, () => {
    const { authority, expected } = artifactFixture();
    if (variation === 'attempt') authority.run.run_attempt++;
    if (variation === 'workflow')
      authority.run.path = '.github/workflows/updater-mac-old-updater.yml';
    if (variation === 'job') authority.attemptJobIds = [];
    const upload = authority.job.steps[0];
    assert(upload);
    if (variation === 'upload') upload.conclusion = 'failure';
    if (variation === 'time') authority.artifact.created_at = '2026-10-07T00:02:00Z';
    if (variation === 'head') authority.artifact.workflow_run.head_sha = '0'.repeat(40);
    if (variation === 'archive') authority.archiveSha256 = '0'.repeat(64);
    if (variation === 'expired') authority.artifact.expired = true;
    assert.throws(() => checkManualArtifact(authority, expected));
  });
void test('archive contract rejects traversal, missing, duplicate and alien entries', () => {
  const entries = [
    'plan.json',
    'stage-plan.sha256',
    'producer-run.json',
    'producer-jobs.json',
    'producer-artifact.json',
    'manual-bundle.json',
  ];
  for (const architecture of ['arm64', 'x64'] as const)
    entries.push(
      ...Object.values(manualNames(architecture)).map((name) => `${architecture}/${name}`)
    );
  checkManualEntries(entries);
  const first = entries[0];
  assert(first);
  for (const invalid of [
    [...entries, '../escape'],
    entries.slice(1),
    [...entries, first],
    [...entries, 'alien.dmg'],
  ])
    assert.throws(() => checkManualEntries(invalid));
});
void test('context refuses local, foreign workflow and moving source execution', () => {
  const sha = '1'.repeat(40);
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: '777genius/agent-teams-ai',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_WORKFLOW_REF: `777genius/agent-teams-ai/${manualWorkflow}@refs/tags/TEST`,
    GITHUB_SHA: sha,
    GITHUB_RUN_ID: '10',
    GITHUB_RUN_ATTEMPT: '1',
  };
  checkManualContext(env, sha);
  for (const change of [
    { GITHUB_ACTIONS: 'false' },
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_WORKFLOW_REF: 'alien' },
    { GITHUB_SHA: '0'.repeat(40) },
  ])
    assert.throws(() => checkManualContext({ ...env, ...change }, sha));
});

// A real GitHub download changes counters; custody depends on identity/state/hash instead.
void test('release reread accepts download counters but rejects asset and snapshot substitution', () => {
  const before: Release = {
    id: 999,
    tag_name: 'v2.17.7',
    target_commitish: '2'.repeat(40),
    created_at: '2026-10-07T00:00:00Z',
    draft: true,
    prerelease: false,
    name: 'TEST',
    body: null,
    assets: [{ id: 100, name: 'TEST.dmg', size: 5, digest: `sha256:${'3'.repeat(64)}` }],
  };
  const beforeAsset = before.assets[0];
  assert(beforeAsset);
  Object.assign(beforeAsset, { state: 'uploaded', download_count: 0 });
  const after = structuredClone(before);
  const afterAsset = after.assets[0];
  assert(afterAsset);
  Object.assign(afterAsset, { download_count: 1, updated_at: '2026-10-07T00:01:00Z' });
  checkManualReleaseReread(before, after, ['TEST.dmg']);
  for (const mutation of [
    { id: 101 },
    { digest: `sha256:${'0'.repeat(64)}` },
    { state: 'starter' },
  ]) {
    const changed = structuredClone(after);
    const changedAsset = changed.assets[0];
    assert(changedAsset);
    Object.assign(changedAsset, mutation);
    assert.throws(() => checkManualReleaseReread(before, changed, ['TEST.dmg']));
  }
  assert.throws(() =>
    checkManualReleaseReread(before, { ...after, target_commitish: '0'.repeat(40) }, ['TEST.dmg'])
  );
});
