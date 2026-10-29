import { RuntimeOwnerError } from '../runtime/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import type { MemberEntry } from './MemberEntry.js';
import type { RuntimeSessionRecord } from '../runtime/contracts.js';

/** Original transition authority ends only at this exact target's allocation commit.
 * Target lifetime uses its own grant; retained callbacks never follow a mutable entry. */
export function captureMemberProviderAuthority(options: {
  entry: MemberEntry;
  request: MemberEntry['config'];
  profileId: string;
  hostIncarnation: string;
  assertAllocation?: () => void;
  assertCurrent(): void;
  readRuntime(): { record: RuntimeSessionRecord | undefined; attached: boolean };
}) {
  const { entry } = options;
  const original = {
    team: entry.team,
    binding: runtimeDigest(entry.binding),
    delivery: runtimeDigest(entry.delivery),
    profile: runtimeDigest(entry.profile),
    config: runtimeDigest(entry.config),
    openConfig: runtimeDigest(options.request),
    principalId: entry.profile.principalId,
    fingerprint: runtimeDigest({ profileId: options.profileId, config: options.request }),
  };
  // No Runtime lookup here: called inside Runtime/Team fences as well as native callbacks.
  function assertCurrent() {
    options.assertCurrent();
    if (
      entry.team !== original.team ||
      runtimeDigest(entry.binding) !== original.binding ||
      runtimeDigest(entry.delivery) !== original.delivery ||
      runtimeDigest(entry.profile) !== original.profile ||
      runtimeDigest(entry.config) !== original.config ||
      entry.profile.principalId !== original.principalId ||
      !entry.team.owner.authorizeMemberBinding(entry.binding, 'admit') ||
      !entry.team.owner.authorizeRuntimeAccess(original.principalId, entry.binding, 'control')
    )
      throw new RuntimeOwnerError('forbidden');
  }
  function isCurrent() {
    try {
      assertCurrent();
      return true;
    } catch {
      return false;
    }
  }
  function read() {
    assertCurrent();
    const state = options.readRuntime(),
      record = state.record;
    if (
      !record ||
      record.profileId !== options.profileId ||
      record.hostIncarnation !== options.hostIncarnation ||
      runtimeDigest(record.binding) !== original.binding ||
      runtimeDigest(record.config) !== original.openConfig ||
      record.openFingerprint !== original.fingerprint ||
      record.sealed
    )
      throw new RuntimeOwnerError('hold');
    return { record, attached: state.attached };
  }
  function assertAllocatedCurrent() {
    const { record, attached } = read();
    if (
      record.phase !== 'allocated' ||
      record.custody !== 'owned' ||
      !attached ||
      !record.sessionRef
    )
      throw new RuntimeOwnerError('hold');
  }
  function canAllocate() {
    try {
      const { record, attached } = read();
      if (
        record.phase === 'allocated' &&
        record.custody === 'owned' &&
        attached &&
        record.sessionRef
      )
        return true;
      if (
        record.phase !== 'opening' ||
        record.custody !== 'unknown' ||
        attached ||
        !options.assertAllocation
      )
        return false;
      options.assertAllocation();
      assertCurrent();
      return true;
    } catch {
      return false;
    }
  }
  return Object.freeze({ assertCurrent, isCurrent, canAllocate, assertAllocatedCurrent });
}
