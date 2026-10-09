// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { canonical, digest } from '../../scripts/ci/release/contract.js';
import {
  fullNativeScenarioRows,
  verifyNativeReadiness,
} from '../../scripts/ci/release/nativeReadiness.js';
import {
  verifyRelease220WindowsExecution,
  verifyRelease220WindowsProvenance,
} from '../../scripts/ci/release/nativeReadinessAuthority.js';
import { createNativeExecutionResolver } from '../../scripts/ci/release/nativeReadinessExecution.js';
import { RELEASE220_EXECUTION as original } from '../../scripts/ci/release/release220ExecutionPins.js';
import { RELEASE220_WINDOWS_EXECUTION as pins } from '../../scripts/ci/release/release220WindowsExecutionPins.js';

import type { StagePlan } from '../../scripts/ci/release/contract.js';
import type {
  NativeReadinessPort,
  NativeReadinessReceipt,
} from '../../scripts/ci/release/nativeReadiness.js';
import type {
  ExecutionProof,
  ExecutionTree,
} from '../../scripts/ci/release/nativeReadinessAuthority.js';

// Complete-tree positives use independently read immutable Git objects. CI still
// runs all forged-proof, closed-plan routing and provenance rejection tests.
const repository = process.env.RELEASE220_WINDOWS_TEST_REPOSITORY;
function git(...args: string[]): string {
  if (!repository) throw new Error('Set RELEASE220_WINDOWS_TEST_REPOSITORY for complete Git proof');
  const binary =
    process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : '/usr/bin/git';
  return execFileSync(binary, ['-C', repository, ...args], {
    encoding: 'utf8',
    maxBuffer: 4_000_000,
  });
}
function tree(sha: string): ExecutionTree {
  return {
    sha,
    truncated: false,
    tree: git('ls-tree', '-rz', '-t', sha)
      .split('\0')
      .filter(Boolean)
      .map((record) => {
        const separator = record.indexOf('\t');
        const [mode, type, objectSha] = record.slice(0, separator).split(' ');
        if (!mode || !type || !objectSha || separator < 0) throw new Error('Malformed Git tree');
        return { path: record.slice(separator + 1), mode, type, sha: objectSha };
      }),
  };
}
function claimedProof(): ExecutionProof {
  return {
    repository: pins.repository,
    commit: { sha: pins.head, tree: { sha: pins.tree }, parents: [{ sha: pins.base }] },
    comparison: {
      status: 'ahead',
      base_commit: { sha: pins.base },
      merge_base_commit: { sha: pins.base },
    },
    baseTree: { sha: pins.baseTree, truncated: false, tree: [] },
    executionTree: { sha: pins.tree, truncated: false, tree: [] },
  };
}
function completeProof(): ExecutionProof {
  const [head, executionTree, ...parents] = git('show', '-s', '--format=%H %T %P', pins.head)
    .trim()
    .split(' ');
  if (!head || !executionTree) throw new Error('Missing reviewed executor object');
  return {
    ...claimedProof(),
    commit: { sha: head, tree: { sha: executionTree }, parents: parents.map((sha) => ({ sha })) },
    comparison: {
      status: 'ahead',
      base_commit: { sha: pins.base },
      merge_base_commit: { sha: git('merge-base', pins.base, head).trim() },
    },
    baseTree: tree(git('rev-parse', `${pins.base}^{tree}`).trim()),
    executionTree: tree(executionTree),
  };
}
function routingFixture(actualHead: string) {
  const plan = JSON.parse(
    readFileSync(new URL('../fixtures/release220-original-P10.json', import.meta.url), 'utf8')
  ) as StagePlan;
  const row = fullNativeScenarioRows(37909332806, 1).find(
    (candidate) => candidate.scenario === 'windows-x64-fresh'
  );
  if (!row) throw new Error('Missing Windows scenario contract');
  const receipt: NativeReadinessReceipt = {
    schemaVersion: 2,
    repository: plan.input.repository,
    toolingSha: plan.input.toolingSha,
    planSha256: original.plan,
    inputDigest: digest(canonical(plan.input)),
    targetReleaseId: plan.input.target.id,
    applicationSha: plan.input.target.applicationSha,
    artifacts: Array.from({ length: 14 }, () => ({
      runId: 37909332806,
      runAttempt: 1,
      jobId: 1,
      artifactId: 1,
      artifactName: row.artifact,
      artifactSha256: 'a'.repeat(64),
      entries: [
        {
          scenario: row.scenario,
          path: row.path,
          sha256: 'b'.repeat(64),
          sealedSha256: 'c'.repeat(64),
        },
      ],
    })),
  };
  const unexpected = () => {
    throw new Error('Producer custody should reject before this read');
  };
  const port: NativeReadinessPort = {
    run: () =>
      Promise.resolve({
        id: 37909332806,
        run_attempt: 1,
        head_sha: actualHead,
        path: row.workflow,
        event: 'workflow_dispatch',
        status: 'completed',
        conclusion: 'success',
        repository: { full_name: pins.repository },
      }),
    jobs: () => Promise.resolve([]),
    artifact: unexpected,
    workflow: unexpected,
    archive: unexpected,
  };
  return { port, plan, receipt, row };
}

describe('closed Windows E13 authority', () => {
  it('rejects matching identity claims without every independently checked Git tree record', () => {
    expect(() => verifyRelease220WindowsExecution(claimedProof())).toThrow(
      'Complete execution tree records changed'
    );
  });
  it('rejects truncated base records', () => {
    const proof = claimedProof();
    proof.baseTree.truncated = true;
    expect(() => verifyRelease220WindowsExecution(proof)).toThrow('Incomplete execution tree');
  });
  it.each([
    (proof: ExecutionProof) => {
      proof.commit.sha = '0'.repeat(40);
    },
    (proof: ExecutionProof) => {
      proof.commit.parents = [{ sha: '0'.repeat(40) }];
    },
    (proof: ExecutionProof) => {
      proof.commit.parents.push({ sha: '0'.repeat(40) });
    },
    (proof: ExecutionProof) => {
      proof.comparison.base_commit.sha = '0'.repeat(40);
    },
    (proof: ExecutionProof) => {
      proof.comparison.merge_base_commit.sha = '0'.repeat(40);
    },
    (proof: ExecutionProof) => {
      proof.comparison.status = 'diverged';
    },
    (proof: ExecutionProof) => {
      proof.commit.tree.sha = '0'.repeat(40);
    },
    (proof: ExecutionProof) => {
      proof.executionTree.sha = '0'.repeat(40);
    },
    (proof: ExecutionProof) => {
      proof.baseTree.sha = '0'.repeat(40);
    },
    (proof: ExecutionProof) => {
      proof.repository = 'foreign/repository';
    },
  ])('rejects changed ancestry, tree or repository before reading claimed records %#', (mutate) => {
    const proof = claimedProof();
    mutate(proof);
    expect(() => verifyRelease220WindowsExecution(proof)).toThrow();
  });
  it('requires the optional complete proof capability before accepting E13 producer evidence', async () => {
    const f = routingFixture(pins.head);
    await expect(verifyNativeReadiness(f.port, f.plan, original.plan, f.receipt)).rejects.toThrow(
      'Missing complete Windows executor proof'
    );
  });
  it('rejects an arbitrary Windows workflow head', async () => {
    const f = routingFixture('0'.repeat(40));
    await expect(verifyNativeReadiness(f.port, f.plan, original.plan, f.receipt)).rejects.toThrow(
      'native tooling SHA'
    );
  });
  it('keeps the reviewed executor closed to the original P10 application graph', async () => {
    const f = routingFixture(pins.head);
    f.plan.input.target.applicationSha = '0'.repeat(40);
    f.receipt.applicationSha = f.plan.input.target.applicationSha;
    f.receipt.inputDigest = digest(canonical(f.plan.input));
    const proof = vi.fn(() => Promise.resolve(claimedProof()));
    f.port.release220WindowsExecutionProof = proof;
    await expect(verifyNativeReadiness(f.port, f.plan, original.plan, f.receipt)).rejects.toThrow(
      'original P10/D10/E10 application graph'
    );
    expect(proof).not.toHaveBeenCalled();
  });
  it('still accepts original E10 routing without requiring new E13 provenance', async () => {
    const f = routingFixture(pins.base);
    const resolve = createNativeExecutionResolver(
      f.port,
      f.receipt,
      f.plan,
      original.plan,
      original.input,
      true
    );
    await expect(resolve(f.row, pins.base)).resolves.toBe(pins.base);
    expect(() =>
      verifyRelease220WindowsProvenance({}, pins.base, pins.base, 37909332806, 1, f.row.job)
    ).not.toThrow();
  });
});

describe('Windows E13 native execution provenance', () => {
  const execution = {
    toolingSha: pins.base,
    executionSha: pins.head,
    runId: 37909332806,
    attempt: 1,
    job: 'windows-ota',
  };
  const check = (value: Record<string, unknown>, job = 'windows-ota') =>
    verifyRelease220WindowsProvenance(value, pins.base, pins.head, 37909332806, 1, job);
  it('binds prepared E10 tooling and actual E13 execution to the selected run, attempt and job ID', () => {
    expect(() => check({ execution })).not.toThrow();
    expect(() =>
      check({ execution: { ...execution, job: 'fresh-windows' } }, 'fresh-windows')
    ).not.toThrow();
  });
  it.each(['toolingSha', 'executionSha', 'runId', 'attempt', 'job'] as const)(
    'rejects changed or missing %s',
    (key) => {
      const changed: Record<string, unknown> = {
        ...execution,
        [key]: key === 'job' ? 'windows-ota (windows-2025, full)' : 'wrong',
      };
      expect(() => check({ execution: changed })).toThrow('Windows execution provenance');
      delete changed[key];
      expect(() => check({ execution: changed })).toThrow('Windows execution provenance');
    }
  );
  it('requires E13 provenance rather than accepting sealed E10 evidence', () => {
    expect(() => check({})).toThrow('Windows execution provenance');
  });
});

describe.runIf(Boolean(repository))('Windows E13 immutable complete Git proof', () => {
  it('accepts independently read exact commit, direct parent and all blob and ancestor tree records', () => {
    expect(() => verifyRelease220WindowsExecution(completeProof())).not.toThrow();
  });
  it.each(['baseTree', 'executionTree'] as const)('rejects changed complete %s', (key) => {
    const truncated = completeProof();
    truncated[key].truncated = true;
    expect(() => verifyRelease220WindowsExecution(truncated)).toThrow('Incomplete execution tree');
    for (const mutate of [
      (value: ExecutionTree) => {
        value.tree.pop();
      },
      (value: ExecutionTree) => {
        const blob = value.tree.find((entry) => entry.type === 'blob');
        if (!blob) throw new Error('Missing blob');
        blob.sha = '0'.repeat(40);
      },
      (value: ExecutionTree) => {
        const ancestor = value.tree.find((entry) => entry.type === 'tree');
        if (!ancestor) throw new Error('Missing ancestor tree');
        ancestor.sha = '0'.repeat(40);
      },
      (value: ExecutionTree) => {
        const blob = value.tree.find((entry) => entry.mode === '100644');
        if (!blob) throw new Error('Missing file mode');
        blob.mode = '100755';
      },
    ]) {
      const proof = completeProof();
      mutate(proof[key]);
      expect(() => verifyRelease220WindowsExecution(proof)).toThrow(
        'Complete execution tree records changed'
      );
    }
  });
  it('authorizes Windows E13 only after validating the complete original P10 graph and complete proof', async () => {
    const f = routingFixture(pins.head);
    const proof = vi.fn(() => Promise.resolve(completeProof()));
    f.port.release220WindowsExecutionProof = proof;
    const resolve = createNativeExecutionResolver(
      f.port,
      f.receipt,
      f.plan,
      original.plan,
      original.input,
      true
    );
    await expect(resolve(f.row, pins.head)).resolves.toBe(pins.head);
    await expect(resolve(f.row, pins.head)).resolves.toBe(pins.head);
    expect(proof).toHaveBeenCalledOnce();
  });
});
