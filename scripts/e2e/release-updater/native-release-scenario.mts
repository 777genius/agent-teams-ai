import assert from 'node:assert/strict';

import { checkInput, checkRelease, version } from '../../ci/release/contract.ts';

import type { Release, StagePlan } from '../../ci/release/contract.ts';

// Native predecessor bytes are frozen independently of the channel's captured latest.
export const nativePredecessor = {
  id: 398386033,
  tag: 'v2.17.1',
  applicationSha: '395572f9ff2a261cb28224754883a39d2c3c8827',
} as const;

export function nativeReleaseScenario(plan: StagePlan) {
  assert.equal(plan.schemaVersion, 1);
  checkInput(plan.input);
  assert.equal(plan.input.repository, '777genius/agent-teams-ai');
  if (plan.input.target.tag === 'v2.17.6') {
    assert.equal(plan.input.mode, 'carry-mac');
    assert.equal(plan.input.latest.tag, nativePredecessor.tag);
    assert.equal(plan.input.latest.id, nativePredecessor.id);
    assert(plan.input.macSource);
    assert.equal(plan.input.macSource.release.id, nativePredecessor.id);
    assert.equal(plan.input.macSource.release.tag, nativePredecessor.tag);
    assert.equal(plan.input.macSource.release.applicationSha, nativePredecessor.applicationSha);
  } else {
    assert.equal(
      plan.input.target.tag,
      'v2.17.7',
      'Only reviewed native release scenarios supported'
    );
    assert.equal(plan.input.mode, 'full');
    assert.equal(plan.input.macSource, null);
    assert.equal(plan.input.macProductMinimum, '13.0');
    assert.equal(plan.input.latest.tag, 'v2.17.6');
  }
  return { targetVersion: version(plan.input.target.tag), predecessor: nativePredecessor };
}

export function checkNativePredecessor(plan: StagePlan, source: Release) {
  const { predecessor } = nativeReleaseScenario(plan);
  // The historical carry lane also retains its complete frozen metadata snapshot.
  checkRelease(source, plan.input.macSource?.release, false);
  assert.equal(source.id, predecessor.id);
  assert.equal(source.tag_name, predecessor.tag);
  assert.equal(source.target_commitish, predecessor.applicationSha);
}
