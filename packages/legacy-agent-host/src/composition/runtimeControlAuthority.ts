import { RuntimeOwnerError } from '../runtime/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import { captureTeamAccountRead } from './captureTeamAccountRead.js';

import type { MemberEntry, HostedTeam } from './MemberEntry.js';
import type { CapturedProviderCurrent, TeamOwner } from '../team/TeamOwner.js';

/** Retain the trusted caller's grant epoch across async control/allocation fences. */
export function captureRuntimeControlAuthority(options: {
  entry: MemberEntry;
  principalId: string;
  assertWriter(): void;
  isSealed(): boolean;
  restore?: boolean;
}): () => void {
  const { entry, principalId } = options;
  const original = structuredClone(entry.binding);
  const revision = entry.team.owner.withLaunchAuthority(principalId, 'read', (value) => value);
  return () => {
    options.assertWriter();
    const current = entry.binding;
    if (options.isSealed() ||
      runtimeDigest(options.restore ? { ...current, generation: original.generation } : current) !== runtimeDigest(original) ||
      !entry.team.owner.withLaunchAuthority(principalId, 'read', (value) =>
        // Both original read-only checks share the still-held Team lock. The
        // nested control check still revalidates its namespace and reads fresh state.
        value === revision && entry.team.owner.authorizeRuntimeAccess(principalId, current, 'control')))
      throw new RuntimeOwnerError('forbidden');
  };
}

interface DefaultAllocation {
  entry: MemberEntry;
  team: HostedTeam;
  owner: TeamOwner;
  binding: string;
  source: string;
  token: object;
  assertion: (mode?: unknown) => void;
}

// Function provenance only: no grant, currentness result or owner state is retained here.
const defaultAllocations = new WeakMap<() => void, DefaultAllocation>();
const freshAllocations = new WeakMap<() => void, { original: () => void; captured: DefaultAllocation;
  assertion: (mode?: unknown) => void }>();

function sourceIdentity(team: HostedTeam): string {
  return runtimeDigest({ definition: team.definition, capture: team.capture ?? null,
    configurationRevision: team.configurationRevision ?? null, launchId: team.launchId ?? null });
}

function excludedFreshSelection(entry: MemberEntry): boolean {
  return !!(entry.liveRosterCapture || entry.selection?.restore || entry.selection?.checkpointSource ||
    entry.config.checkpointRef !== undefined);
}

function assertDefaultIdentity(captured: DefaultAllocation, entry: MemberEntry): void {
  if (entry !== captured.entry || entry.team !== captured.team || captured.team.owner !== captured.owner ||
    runtimeDigest(entry.binding) !== captured.binding || sourceIdentity(captured.team) !== captured.source)
    throw new RuntimeOwnerError('forbidden');
}

/** The original default callback; only its private token can retain an inherited entry boundary. */
export function captureDefaultRuntimeAllocationAuthority(options: {
  entry: MemberEntry; team: HostedTeam; principalId: string;
  assertWriter(): void; isSealed(): boolean;
}): () => void {
  const { entry, team, principalId } = options;
  const captured = captureRuntimeControlAuthority(options);
  const withAuthorityRead = captureTeamAccountRead({ entry, principalId, assertCurrent: options.assertWriter });
  const token = Object.freeze({});
  const assertion = (mode?: unknown) => withAuthorityRead(() => {
    team.owner.assertExecutionAllowed(principalId);
    captured();
  }, mode === token ? true : undefined);
  // Native additions can use a distinct captured Team; their ordinary callback remains unchanged.
  if (entry.team === team) defaultAllocations.set(assertion, { entry, team, owner: team.owner,
    binding: runtimeDigest(entry.binding), source: sourceIdentity(team), token, assertion });
  return assertion;
}

/** Called only by the original no-restore/no-selected-source openSession branch. */
export function bindDefaultFreshAllocationAuthority(assertion: () => void, entry: MemberEntry): () => void {
  const captured = defaultAllocations.get(assertion);
  if (!captured) return assertion;
  assertDefaultIdentity(captured, entry);
  if (excludedFreshSelection(entry)) return assertion;
  const fresh = (mode?: unknown) => captured.assertion(mode === captured.token ? captured.token : undefined);
  freshAllocations.set(fresh, { original: assertion, captured, assertion: fresh });
  return fresh;
}

/** Only exact original function identities can join the already-held same-Team provider fence. */
export function readDefaultFreshAllocationContinuation(
  assertion: () => void, entry: MemberEntry
): CapturedProviderCurrent | undefined {
  const fresh = freshAllocations.get(assertion);
  if (!fresh) return undefined;
  return (owner, binding) => {
    const captured = fresh.captured;
    if (freshAllocations.get(assertion) !== fresh || defaultAllocations.get(fresh.original) !== captured ||
      owner !== captured.owner || runtimeDigest(binding) !== captured.binding || excludedFreshSelection(entry))
      throw new RuntimeOwnerError('forbidden');
    assertDefaultIdentity(captured, entry);
    fresh.assertion(captured.token);
  };
}
