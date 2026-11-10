import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureMemberProviderAuthority } from '../dist/composition/captureMemberProviderAuthority.js';
import { emptySession } from '../dist/runtime/sessionState.js';
import { runtimeDigest } from '../dist/runtime/identity.js';
import { captureNativeInputAuthority } from '../dist/composition/captureNativeInputAuthority.js';
import { fixture } from './native-member-actions-fixture.ts';

test('restored provider authority binds the complete open request and keeps current fences', async (t) => {
  const f = await fixture(t);
  const entry = [...f.entries.values()].find(value => value.binding.memberId === 'A')!;
  const request = { ...entry.config, checkpointRef: 'TEST-exact-checkpoint' };
  const record = emptySession(entry.binding, 'TEST-profile', 'TEST-host');
  record.config = structuredClone(request);
  record.openFingerprint = runtimeDigest({ profileId: 'TEST-profile', config: request });
  record.phase = 'opening'; record.custody = 'unknown';
  let attached = false, allocationChecks = 0;
  const authority = captureMemberProviderAuthority({
    entry, request, profileId: 'TEST-profile', hostIncarnation: 'TEST-host',
    assertAllocation() { allocationChecks++; },
    assertCurrent() {},
    readRuntime: () => ({ record, attached }),
  });
  assert.equal(authority.canAllocate(), true, 'exact checkpoint-bearing opening remains allocatable');
  assert.equal(allocationChecks, 1);
  record.config = { ...request, checkpointRef: 'TEST-other-checkpoint' };
  assert.equal(authority.canAllocate(), false, 'checkpoint identity remains fenced');
  record.config = structuredClone(request);
  record.openFingerprint = runtimeDigest({ profileId: 'TEST-profile', config: entry.config });
  assert.equal(authority.canAllocate(), false, 'base profile fingerprint cannot replace full request');
  record.openFingerprint = runtimeDigest({ profileId: 'TEST-profile', config: request });
  record.hostIncarnation = 'TEST-other-host'; assert.equal(authority.canAllocate(), false);
  record.hostIncarnation = 'TEST-host';
  record.phase = 'allocated'; record.custody = 'owned'; record.sessionRef = 'TEST-restored-session'; attached = true;
  authority.assertAllocatedCurrent();
  record.sealed = true; assert.equal(authority.canAllocate(), false); record.sealed = false;
  request.checkpointRef = 'TEST-mutated-caller';
  record.config = structuredClone(request);
  record.openFingerprint = runtimeDigest({ profileId: 'TEST-profile', config: request });
  assert.equal(authority.canAllocate(), false, 'caller mutation cannot replace captured request identity');
  request.checkpointRef = 'TEST-exact-checkpoint';
  record.config = structuredClone(request); record.openFingerprint = runtimeDigest({ profileId: 'TEST-profile', config: request });
  entry.config = { ...entry.config, configRevision: 'TEST-replaced-entry' };
  assert.equal(authority.canAllocate(), false, 'immutable entry configuration remains fenced separately');
});


test('restored native input keeps the full checkpoint-bearing request identity', async (t) => {
  const f = await fixture(t);
  const snapshot = f.runtime.readSession(f.lead.binding);
  const record = structuredClone(snapshot.record!);
  const request = { ...f.lead.config, checkpointRef: 'TEST-exact-checkpoint' };
  record.config = structuredClone(request);
  record.openFingerprint = runtimeDigest({ profileId: 'TEST-profile', config: request });
  const capture = (config: typeof f.lead.config) => captureNativeInputAuthority({
    binding: f.lead.binding,
    profileId: 'TEST-profile',
    hostIncarnation: 'TEST-host',
    config,
    readRuntime: () => ({ record, attached: snapshot.attached }),
    captureTeam: (raw) => f.owner.captureNativeMcpAuthority('native-L', f.lead.binding, raw, true),
    assertCurrent() {},
  });
  assert.throws(() => capture(f.lead.config), /hold/, 'base member recipe omits the checkpoint identity');
  const source = capture(request);
  source.assertCurrent();
  record.config = { ...request, checkpointRef: 'TEST-other-checkpoint' };
  assert.throws(() => source.assertCurrent(), /hold/, 'restored native input cannot cross checkpoint identity');
});
