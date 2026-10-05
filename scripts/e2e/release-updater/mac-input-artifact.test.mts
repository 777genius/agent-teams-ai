import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkMacArtifactAuthority } from './mac-input-artifact.mts';
import { checkMacAssetSnapshot } from './mac-inputs.mts';

import type { Asset } from '../../ci/release/contract.ts';
import type { MacArtifactAuthority, MacArtifactExpected } from './mac-input-artifact.mts';

const expected: MacArtifactExpected = {
  artifactId: 51001,
  artifactSha256: 'a'.repeat(64),
  toolingSha: 'b'.repeat(40),
  runId: 41001,
  attempt: 2,
  workflowPath: '.github/workflows/updater-mac-updater.yml',
};
function fixture(): MacArtifactAuthority {
  return {
    run: {
      id: 41001,
      head_sha: 'b'.repeat(40),
      run_attempt: 2,
      path: '.github/workflows/updater-mac-updater.yml',
      event: 'workflow_dispatch',
      status: 'in_progress',
    },
    job: {
      id: 61001,
      run_id: 41001,
      name: 'prepare-mac-inputs',
      status: 'completed',
      conclusion: 'success',
      started_at: '2026-10-05T12:00:00Z',
      completed_at: '2026-10-05T12:02:00Z',
      steps: [
        {
          name: 'Upload authenticated immutable Mac inputs',
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-10-05T12:01:00Z',
          completed_at: '2026-10-05T12:01:05Z',
        },
      ],
    },
    attemptJobIds: [61001, 61002],
    artifact: {
      id: 51001,
      name: 'TEST-mac-authenticated-inputs-41001-2',
      digest: `sha256:${'a'.repeat(64)}`,
      expired: false,
      created_at: '2026-10-05T12:01:05.500Z',
      workflow_run: { id: 41001, head_sha: 'b'.repeat(40) },
    },
    archiveSha256: 'a'.repeat(64),
  };
}
void test('a successful authenticated job is usable while its dependent native workflow remains active', () => {
  assert.doesNotThrow(() => checkMacArtifactAuthority(fixture(), expected));
});
void test('a documented ref-suffixed workflow path retains exact producer authority', () => {
  const value = fixture();
  value.run.path = `${expected.workflowPath}@main`;
  assert.doesNotThrow(() => checkMacArtifactAuthority(value, expected));
});
const invalid: { name: string; mutate: (value: MacArtifactAuthority) => void }[] = [
  {
    name: 'foreign artifact ID',
    mutate: (value) => {
      value.artifact.id = 51002;
    },
  },
  {
    name: 'wrong downloaded archive hash',
    mutate: (value) => {
      value.archiveSha256 = 'c'.repeat(64);
    },
  },
  {
    name: 'foreign artifact digest',
    mutate: (value) => {
      value.artifact.digest = `sha256:${'c'.repeat(64)}`;
    },
  },
  {
    name: 'foreign artifact workflow run',
    mutate: (value) => {
      value.artifact.workflow_run.id = 41002;
    },
  },
  {
    name: 'different tooling head',
    mutate: (value) => {
      value.run.head_sha = 'c'.repeat(40);
    },
  },
  {
    name: 'wrong run attempt',
    mutate: (value) => {
      value.run.run_attempt = 1;
    },
  },
  {
    name: 'untrusted workflow',
    mutate: (value) => {
      value.run.path = '.github/workflows/release.yml';
    },
  },
  {
    name: 'ref-suffixed wrong workflow filename',
    mutate: (value) => {
      value.run.path = '.github/workflows/release.yml@main';
    },
  },
  {
    name: 'wrong tooling head with a valid ref-suffixed workflow',
    mutate: (value) => {
      value.run.path = `${expected.workflowPath}@main`;
      value.run.head_sha = 'c'.repeat(40);
    },
  },
  {
    name: 'pull request producer event',
    mutate: (value) => {
      value.run.event = 'pull_request';
    },
  },
  {
    name: 'job outside selected attempt',
    mutate: (value) => {
      value.attemptJobIds = [61002];
    },
  },
  {
    name: 'unfinished producer job',
    mutate: (value) => {
      value.job.status = 'in_progress';
    },
  },
  {
    name: 'failed producer job',
    mutate: (value) => {
      value.job.conclusion = 'failure';
    },
  },
  {
    name: 'expired artifact',
    mutate: (value) => {
      value.artifact.expired = true;
    },
  },
  {
    name: 'artifact created outside successful upload',
    mutate: (value) => {
      value.artifact.created_at = '2026-10-05T12:01:06Z';
    },
  },
  {
    name: 'missing successful upload step',
    mutate: (value) => {
      value.job.steps = [];
    },
  },
];
for (const { name, mutate } of invalid)
  void test(`reject ${name} before native installation`, () => {
    const value = fixture();
    mutate(value);
    assert.throws(() => checkMacArtifactAuthority(value, expected));
  });

function assetFixture(): Asset & { state: string; download_count: number } {
  return {
    id: 593747171,
    name: 'Agent.Teams.AI-2.17.0-arm64.dmg',
    size: 249860511,
    digest: 'sha256:ffee8ea0ae14507da597a7339c1e78481d2ddaf96686e6aad32229f716cc46d7',
    state: 'uploaded',
    download_count: 124,
  };
}
void test('an asset download counter may increase without changing its trusted snapshot', () => {
  const before = assetFixture();
  const after = { ...before, download_count: before.download_count + 1 };
  assert.doesNotThrow(() => checkMacAssetSnapshot(after, before));
});
const assetChanges: {
  name: string;
  mutate: (asset: ReturnType<typeof assetFixture>) => void;
}[] = [
  {
    name: 'ID',
    mutate: (asset) => {
      asset.id += 1;
    },
  },
  {
    name: 'name',
    mutate: (asset) => {
      asset.name = 'substituted.dmg';
    },
  },
  {
    name: 'size',
    mutate: (asset) => {
      asset.size += 1;
    },
  },
  {
    name: 'digest',
    mutate: (asset) => {
      asset.digest = `sha256:${'c'.repeat(64)}`;
    },
  },
  {
    name: 'state',
    mutate: (asset) => {
      asset.state = 'starter';
    },
  },
];
for (const { name, mutate } of assetChanges)
  void test(`reject changed asset ${name} after download`, () => {
    const before = assetFixture();
    const after = { ...before };
    mutate(after);
    assert.throws(() => checkMacAssetSnapshot(after, before));
  });
