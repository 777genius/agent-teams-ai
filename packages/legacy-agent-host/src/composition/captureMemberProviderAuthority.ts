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
  /** Original writer lease, required by the production factory before sharing a Team fence. */
  assertWriter?(): void;
  /** Closed Team operation; a denied/corrupt source must throw, never return legacy applicability. */
  assertProviderAuthority?(): 'current' | 'roster-not-applicable';
  assertCurrent(): void;
  readRuntime(): { record: RuntimeSessionRecord | undefined; attached: boolean };
}) {
  const { entry, assertWriter } = options;
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
  function assertOriginal() {
    if (
      entry.team !== original.team ||
      runtimeDigest(entry.binding) !== original.binding ||
      runtimeDigest(entry.delivery) !== original.delivery ||
      runtimeDigest(entry.profile) !== original.profile ||
      runtimeDigest(entry.config) !== original.config ||
      entry.profile.principalId !== original.principalId
    )
      throw new RuntimeOwnerError('forbidden');
  }
  // No Runtime lookup here: called inside Runtime/Team fences as well as native callbacks.
  function checkCurrent() {
    options.assertCurrent();
    assertOriginal();
    if (
      !entry.team.owner.authorizeMemberBinding(entry.binding, 'admit') ||
      !entry.team.owner.authorizeRuntimeAccess(original.principalId, entry.binding, 'control')
    )
      throw new RuntimeOwnerError('forbidden');
  }
  function assertCurrent() {
    // Never enter a different Team's lock through a replaced mutable entry.
    if (entry.team !== original.team) throw new RuntimeOwnerError('forbidden');
    // Direct legacy compositions retain their original independent fences.
    if (!assertWriter) return checkCurrent();
    // A replaced store root must be refused before even publishing a lock there.
    assertWriter();
    if (options.assertProviderAuthority) {
      assertOriginal();
      const authority = options.assertProviderAuthority();
      if (authority === 'current') return;
      if (authority !== 'roster-not-applicable') throw new RuntimeOwnerError('forbidden');
    }
    // This callback is synchronous. Nested namespace checks and policy reads stay
    // current; only the original cross-process lock acquisition is shared.
    original.team.owner.withLaunchAuthority(original.principalId, 'read', checkCurrent);
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
