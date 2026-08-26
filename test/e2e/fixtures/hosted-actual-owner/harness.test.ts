import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  parseActualOwnerIntegration,
  REQUIRED_OPENCODE_TAG,
  REQUIRED_OPENCODE_UPSTREAM,
  REQUIRED_SANDBOX,
  REQUIRED_SCENARIOS,
} from '../../../../scripts/e2e/hosted-actual-owner/contracts';
import { runActualOwnerE2E } from '../../../../scripts/e2e/hosted-actual-owner/driver';
import {
  deriveProofRows,
  validateProofMatrix,
} from '../../../../scripts/e2e/hosted-actual-owner/evidence';
import {
  type ActualOwnerRunSandbox,
  claimExactlyOneRun,
} from '../../../../scripts/e2e/hosted-actual-owner/sandbox';
import {
  atomicPrivateFile,
  canonicalJson,
} from '../../../../scripts/e2e/hosted-actual-owner/secure-files';

const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function integrated(): Record<string, unknown> {
  const sha = 'a'.repeat(64);
  const commit = 'b'.repeat(40);
  return {
    schemaVersion: 1,
    purpose: 'agent-teams.hosted-actual-owner-e2e.integration/v1',
    integrated: true,
    finalRunAuthorized: false,
    maximumRuns: 1,
    product: { commit, tree: commit, executable: '/bin/product', sha256: sha, argv: [] },
    orchestrator: {
      repository: '777genius/agent_teams_orchestrator',
      pullRequest: 45,
      commit,
      entry: '/bin/owner',
      sha256: sha,
      argv: [],
    },
    openCode: {
      repository: '777genius/opencode-anomaly',
      upstreamTag: REQUIRED_OPENCODE_TAG,
      upstreamCommit: REQUIRED_OPENCODE_UPSTREAM,
      functionalPullRequest: 6,
      artifactPullRequest: 7,
      functionalCommit: commit,
      artifactCommit: commit,
      sourceTree: commit,
      materializedArtifactTree: commit,
      patchSha256: sha,
      workflowMergeCommit: commit,
      workflowRunId: 1,
      artifactId: 2,
      artifactEnvelope: '/input/artifact.zip',
      artifactEnvelopeSha256: sha,
      releaseManifest: '/input/manifest.json',
      releaseManifestSha256: sha,
      attestation: '/input/attestation.json',
      attestationSha256: sha,
      linuxArchive: '/input/opencode.tar.gz',
      linuxArchiveSha256: sha,
      executable: '/input/opencode',
      executableSha256: sha,
      productionEligible: false,
    },
    browser: {
      chromiumExecutable: '/bin/chromium',
      chromiumSha256: sha,
      teamA: `team_${'1'.repeat(32)}`,
      runA: `run_${'2'.repeat(32)}`,
      teamB: `team_${'3'.repeat(32)}`,
      runB: `run_${'4'.repeat(32)}`,
      csrfHeader: 'x-csrf-token',
      csrfToken: 'x'.repeat(32),
    },
    provider: { kind: 'deterministic-local', baseUrl: 'http://127.0.0.1:19002' },
    productOrigin: 'http://127.0.0.1:19001',
    ownerStorageState: '/input/owner.json',
    nonOwnerStorageState: '/input/non-owner.json',
    controllerNonce: '5'.repeat(48),
    sandboxRoot: REQUIRED_SANDBOX,
  };
}

function nested(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const child = value[key];
  if (!child || typeof child !== 'object' || Array.isArray(child)) {
    throw new Error('fixture_invalid');
  }
  return child as Record<string, unknown>;
}

describe('hosted actual-owner harness contracts', () => {
  it('exports only the fail-closed manifest-driven runner', () => {
    expect(runActualOwnerE2E).toBeTypeOf('function');
  });

  it('pins refreshed OpenCode and fails closed while the checked-in manifest is unintegrated', async () => {
    const path = join(
      process.cwd(),
      'test/e2e/fixtures/hosted-actual-owner/integration-manifest.unintegrated.json'
    );
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    expect(() => parseActualOwnerIntegration(manifest)).toThrow(
      'actual_owner_integration_unavailable'
    );
    expect(manifest.openCode).toMatchObject({
      upstreamTag: 'v1.18.23',
      upstreamCommit: REQUIRED_OPENCODE_UPSTREAM,
    });
  });

  it('rejects production eligibility, ref drift, cross-team identity collapse, and extra fields', () => {
    expect(parseActualOwnerIntegration(integrated()).openCode.productionEligible).toBe(false);
    for (const mutation of [
      (value: Record<string, unknown>) => {
        nested(value, 'openCode').productionEligible = true;
      },
      (value: Record<string, unknown>) => {
        nested(value, 'openCode').upstreamCommit = 'c'.repeat(40);
      },
      (value: Record<string, unknown>) => {
        const browser = nested(value, 'browser');
        browser.teamB = browser.teamA;
      },
      (value: Record<string, unknown>) => {
        value.ambientDiscovery = true;
      },
    ]) {
      const value = integrated();
      mutation(value);
      expect(() => parseActualOwnerIntegration(value)).toThrow();
    }
  });

  it('requires one raw proof for every allow/deny/stale/replay/cross-team/ambiguous/cleanup case', async () => {
    const root = await mkdtemp(join(tmpdir(), 'actual-owner-proof-'));
    roots.push(root);
    const rows = REQUIRED_SCENARIOS.map((scenario, index) => ({
      schemaVersion: 1,
      scenario,
      recordId: `record:${scenario}:00000000`,
      passed: true,
      effectCount: scenario === 'exactly-one' ? 1 : 0,
      raw: { index },
    }));
    await writeFile(
      join(root, 'records.ndjson'),
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`
    );
    const proof = await deriveProofRows(root);
    expect(() => validateProofMatrix(proof)).not.toThrow();
    await writeFile(
      join(root, 'records.ndjson'),
      `${rows
        .slice(0, -1)
        .map((row) => JSON.stringify(row))
        .join('\n')}\n`
    );
    await expect(deriveProofRows(root)).rejects.toThrow(
      'actual_owner_proof_cleanup-forced_missing'
    );
  });

  it('claims a run count with create-exclusive semantics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'actual-owner-once-'));
    roots.push(root);
    await mkdir(join(root, 'evidence'));
    const sandbox = {
      root,
      evidenceRoot: join(root, 'evidence'),
      markerPath: join(root, '.marker'),
      runLedgerPath: join(root, 'run-count.json'),
    } satisfies ActualOwnerRunSandbox;
    await claimExactlyOneRun(sandbox);
    await expect(claimExactlyOneRun(sandbox)).rejects.toThrow(
      'actual_owner_exactly_one_run_violated'
    );
  });

  it('allows atomic evidence directly under an already admitted run root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'actual-owner-root-file-'));
    roots.push(root);
    const anchor = await atomicPrivateFile(
      join(root, 'manifest.json'),
      canonicalJson({ schemaVersion: 1 }),
      root
    );
    expect(anchor.mode).toBe(0o600);
    expect(anchor.path).toBe(join(root, 'manifest.json'));
  });
});
