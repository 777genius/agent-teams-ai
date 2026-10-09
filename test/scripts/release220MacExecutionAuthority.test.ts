// @vitest-environment node
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { verifyRelease220MacExecution } from '../../scripts/ci/release/nativeReadinessAuthority.js';
import { RELEASE220_MAC_EXECUTION as pins } from '../../scripts/ci/release/release220MacExecutionPins.js';

import type {
  ExecutionProof,
  ExecutionTree,
} from '../../scripts/ci/release/nativeReadinessAuthority.js';

// Opt into complete-tree tests with RELEASE220_MAC_TEST_REPOSITORY pointing at
// the reviewed executor checkout. Read immutable Git objects, never dirty files
// or a caller's claimed digest. CI still runs the forged-proof tests below.
const repository = process.env.RELEASE220_MAC_TEST_REPOSITORY;

function git(...args: string[]): string {
  if (!repository)
    throw new Error('Set RELEASE220_MAC_TEST_REPOSITORY for local complete-tree proof');
  return execFileSync('git', ['-C', repository, ...args], {
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
        if (!mode || !type || !objectSha || separator < 0)
          throw new Error('Malformed local Git tree');
        return { path: record.slice(separator + 1), mode, type, sha: objectSha };
      }),
  };
}
function completeProof(): ExecutionProof {
  const [head, executionTree, ...parents] = git('show', '-s', '--format=%H %T %P', pins.head)
    .trim()
    .split(' ');
  if (!head || !executionTree) throw new Error('Missing reviewed executor object');
  return {
    repository: pins.repository,
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

describe.runIf(Boolean(repository))('local full220 Mac executor complete Git proof', () => {
  it('accepts the independently read reviewed commit, parent and every tree record', () => {
    expect(() => verifyRelease220MacExecution(completeProof())).not.toThrow();
  });
  it.each(['baseTree', 'executionTree'] as const)(
    'rejects truncated or omitted %s records',
    (key) => {
      const truncated = completeProof();
      truncated[key].truncated = true;
      expect(() => verifyRelease220MacExecution(truncated)).toThrow('Incomplete execution tree');
      const omitted = completeProof();
      omitted[key].tree.pop();
      expect(() => verifyRelease220MacExecution(omitted)).toThrow(
        'Complete execution tree records changed'
      );
    }
  );
  it.each(['baseTree', 'executionTree'] as const)(
    'rejects altered %s records under the approved tree SHA',
    (key) => {
      const altered = completeProof();
      const record = altered[key].tree.find((entry) => entry.type === 'blob');
      if (!record) throw new Error('Missing blob');
      record.sha = '0'.repeat(40);
      expect(() => verifyRelease220MacExecution(altered)).toThrow(
        'Complete execution tree records changed'
      );
    }
  );
  it('rejects a wrong parent, extra parent, wrong merge base or foreign repository', () => {
    for (const mutate of [
      (proof: ExecutionProof) => {
        proof.commit.parents = [{ sha: '0'.repeat(40) }];
      },
      (proof: ExecutionProof) => {
        proof.commit.parents.push({ sha: '0'.repeat(40) });
      },
      (proof: ExecutionProof) => {
        proof.comparison.merge_base_commit.sha = '0'.repeat(40);
      },
      (proof: ExecutionProof) => {
        proof.repository = 'foreign/repository';
      },
    ]) {
      const proof = completeProof();
      mutate(proof);
      expect(() => verifyRelease220MacExecution(proof)).toThrow();
    }
  });
});

// Matching identity claims cannot substitute for the complete reviewed records.
// These negatives run in CI without a reviewed local executor checkout.
describe('closed full220 Mac proof rejects caller-authored identity claims', () => {
  function forgedProof(): ExecutionProof {
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
  it('rejects omitted tree records even when every identity claim matches the approved executor', () => {
    expect(() => verifyRelease220MacExecution(forgedProof())).toThrow(
      'Complete execution tree records changed'
    );
  });
  it('rejects a truncated base snapshot before evaluating claimed records', () => {
    const proof = forgedProof();
    proof.baseTree.truncated = true;
    expect(() => verifyRelease220MacExecution(proof)).toThrow('Incomplete execution tree');
  });
  it('rejects a forged parent before accepting a claimed complete proof', () => {
    const proof = forgedProof();
    proof.commit.parents = [{ sha: '0'.repeat(40) }];
    expect(() => verifyRelease220MacExecution(proof)).toThrow(
      'Unapproved full220 Mac executor ancestry or tree'
    );
  });
});
