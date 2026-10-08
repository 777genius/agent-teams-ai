import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';

import {
  release216Execution,
  verifyRelease216Execution,
  verifyRelease216MacExecution,
} from '../../ci/release/nativeReadinessAuthority.ts';
import type { ExecutionProof } from '../../ci/release/nativeReadinessAuthority.ts';
import { canonical, digest } from '../../ci/release/contract.ts';
import type { StagePlan } from '../../ci/release/contract.ts';

// Independent frozen Git object data, generated from actual T80/M commits.
function fixture(kind: 'windows' | 'mac-old' = 'mac-old'): ExecutionProof {
  return JSON.parse(
    gunzipSync(
      readFileSync(
        new URL(
          `../../../test/fixtures/release216-${kind === 'windows' ? 'windows' : 'mac'}-execution-proof.json.gz`,
          import.meta.url
        )
      )
    ).toString()
  ) as ExecutionProof;
}
void test('the exact independently approved frozen M complete Git proof accepts', () => {
  const proof = fixture();
  proof.executionTree.tree.reverse();
  assert.doesNotThrow(() => verifyRelease216MacExecution(proof));
});
void test('the independently frozen W17 full tree accepts, while failed W identity rejects', () => {
  const proof = fixture('windows');
  assert.doesNotThrow(() => verifyRelease216Execution(proof, 'windows'));
  proof.commit.sha = 'c198e98ef775dfb28bd24ca8bcf71d93a32ec9c4';
  assert.throws(() => verifyRelease216Execution(proof, 'windows'));
});
void test('only the original independent plan routes Windows W17, old Mac M and remaining T80', () => {
  const bytes = execFileSync('/usr/bin/unzip', [
    '-p',
    new URL('../../../test/fixtures/release216-publisher/plan.zip', import.meta.url).pathname,
    'stage-plan.json',
  ]);
  const plan = JSON.parse(bytes.toString()) as StagePlan;
  const p = digest(bytes),
    d = digest(canonical(plan.input));
  assert.equal(
    release216Execution('windows', plan, p, d),
    '32783dc0b671a0d5c107e0976905f97e490db6c0'
  );
  assert.equal(
    release216Execution('mac-old', plan, p, d),
    '2a7d9e18125ad7ac4d50eb5d60ee79247d5c7c64'
  );
  for (const role of ['appimage', 'package', 'mac-current'])
    assert.equal(release216Execution(role, plan, p, d), '80ad7936b6d602c89f712e14771911098277ec44');
  assert.throws(() => release216Execution('windows', plan, '0'.repeat(64), d));
  assert.throws(() => release216Execution('windows', plan, p, '0'.repeat(64)));
  plan.input.toolingSha = 'e'.repeat(40);
  assert.throws(() => release216Execution('windows', plan, p, d));
});
const invalid: [string, (proof: ExecutionProof) => void][] = [
  [
    'spoofed repository',
    (p) => {
      p.repository = 'foreign/repo';
    },
  ],
  [
    'wrong actual execution commit',
    (p) => {
      p.commit.sha = 'f'.repeat(40);
    },
  ],
  [
    'wrong root tree',
    (p) => {
      p.executionTree.sha = 'f'.repeat(40);
    },
  ],
  [
    'missing direct parent',
    (p) => {
      p.commit.parents = [];
    },
  ],
  [
    'wrong merge base',
    (p) => {
      p.comparison.merge_base_commit.sha = 'f'.repeat(40);
    },
  ],
  [
    'incomplete recursive tree',
    (p) => {
      p.executionTree.truncated = true;
    },
  ],
  [
    'duplicate path',
    (p) => {
      const entry = p.executionTree.tree.at(0);
      assert(entry);
      p.executionTree.tree.push(entry);
    },
  ],
  [
    'hidden tracked file',
    (p) => {
      p.executionTree.tree.push({
        path: '.github/.hidden-bypass',
        mode: '100644',
        type: 'blob',
        sha: 'f'.repeat(40),
      });
    },
  ],
  [
    'common hidden file spoofed into both tree responses',
    (p) => {
      const hidden = {
        path: '.github/.hidden-bypass',
        mode: '100644',
        type: 'blob',
        sha: 'f'.repeat(40),
      };
      p.baseTree.tree.push(hidden);
      p.executionTree.tree.push(hidden);
    },
  ],
  [
    'dependency blob',
    (p) => {
      p.executionTree.tree.find((e) => e.path === 'pnpm-lock.yaml')!.sha = 'f'.repeat(40);
    },
  ],
  [
    'workflow blob',
    (p) => {
      p.executionTree.tree.find(
        (e) => e.path === '.github/workflows/updater-mac-old-updater.yml'
      )!.sha = 'f'.repeat(40);
    },
  ],
  [
    'executable mode',
    (p) => {
      p.executionTree.tree.find((e) => e.path === 'README.md')!.mode = '100755';
    },
  ],
  [
    'symlink type change',
    (p) => {
      p.executionTree.tree.find((e) => e.path === 'README.md')!.mode = '120000';
    },
  ],
  [
    'invalid Git mode/type pairing',
    (p) => {
      p.executionTree.tree.find((e) => e.path === 'README.md')!.type = 'tree';
    },
  ],
  [
    'removed tracked file',
    (p) => {
      p.executionTree.tree = p.executionTree.tree.filter((e) => e.path !== 'README.md');
    },
  ],
];
for (const role of ['windows', 'mac-old'] as const)
  for (const [name, mutate] of invalid)
    void test(`reject ${role} ${name} despite fixed claimed head/tree equality`, () => {
      const proof = fixture(role);
      mutate(proof);
      assert.throws(() => verifyRelease216Execution(proof, role));
    });
