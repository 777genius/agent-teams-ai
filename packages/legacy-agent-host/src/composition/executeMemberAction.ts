import type { MemberActionAdmission } from './nativeMemberActionAdmission.js';
import { runtimeDigest as digest } from '../runtime/identity.js';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { captureRuntimeControlAuthority } from './runtimeControlAuthority.js';
import { assertCapturedRosterCurrent } from './teamRoster.js';
import type { MemberEntry } from './MemberEntry.js';
import type { RuntimeBinding } from '../runtime/contracts.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { TeamLaunchOwner } from '../team-launch/TeamLaunchOwner.js';
import type { ExpectedLaunchMember } from '../team-launch/contracts.js';
import { transitionRuntimeMember } from './transitionRuntimeMember.js';
import type { createLaunchMemberActions, MemberActionInput } from '../team-launch/memberActions.js';

type Launch = Pick<TeamLaunchOwner, 'read' | 'startMember'> & {
  memberActions(): ReturnType<typeof createLaunchMemberActions>;
};
export function parseMemberAction(commandId: string, raw: unknown): MemberActionInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RuntimeOwnerError('invalid');
  const row = raw as Record<string, unknown>;
  if (
    Object.keys(row).some(
      (k) => !['launchId', 'rosterRevision', 'memberId', 'expectedGeneration', 'action'].includes(k)
    )
  )
    throw new RuntimeOwnerError('invalid');
  for (const value of [commandId, row.launchId, row.rosterRevision, row.memberId])
    if (typeof value !== 'string' || !value || value.length > 256 || value.includes('\0'))
      throw new RuntimeOwnerError('invalid');
  if (
    row.expectedGeneration !== null &&
    (typeof row.expectedGeneration !== 'string' ||
      !row.expectedGeneration ||
      row.expectedGeneration.length > 256 ||
      row.expectedGeneration.includes('\0'))
  )
    throw new RuntimeOwnerError('invalid');
  if (row.action !== 'restart' && row.action !== 'skip') throw new RuntimeOwnerError('invalid');
  return {
    commandId,
    launchId: row.launchId as string,
    rosterRevision: row.rosterRevision as string,
    memberId: row.memberId as string,
    expectedGeneration: row.expectedGeneration as string | null,
    action: row.action,
  };
}
/** Exact current captured member only. The current wrapper is retained for existing launch callbacks. */
export function executeMemberAction(
  options: {
    actions?: ReturnType<typeof createLaunchMemberActions>;
    /** Trusted native admission only; never parsed from operation payload. */
    admission?: MemberActionAdmission;
    entry: MemberEntry;
    launch: Launch;
    runtime: RuntimeOwner;
    principalId: string;
    assertWriter(): void;
    isSealed(): boolean;
    /** Actual Team lifecycle guard + exact captured worktree/private configuration checks; not member dispatch. */
    assertNewWorkAllowed(entry: MemberEntry): void;
    verifyNewWorkAllowed(entry: MemberEntry): Promise<void>;
    rekey(before: RuntimeBinding, entry: MemberEntry): void;
  },
  operation: 'prepare' | 'execute',
  commandId: string,
  raw: unknown
) {
  const input = parseMemberAction(commandId, raw),
    { entry, launch } = options;
  options.assertWriter();
  if (options.isSealed()) throw new RuntimeOwnerError('hold');
  if (options.admission) options.admission.assertRosterCurrent();
  else assertCapturedRosterCurrent(entry.team);
  const actions = options.admission?.actions ?? options.actions ?? launch.memberActions();
  const authorityRevision = options.admission
    ? undefined
    : entry.team.owner.withLaunchAuthority(options.principalId, 'control', (revision) => revision);
  const assertGrant =
    options.admission?.assertCurrent ??
    (() => {
      options.assertWriter();
      if (options.isSealed()) throw new RuntimeOwnerError('hold');
      assertCapturedRosterCurrent(entry.team);
      entry.team.owner.withLaunchAuthority(options.principalId, 'control', (revision) => {
        if (revision !== authorityRevision) throw new RuntimeOwnerError('forbidden');
      });
    });
  assertGrant();
  // A lookup is always a distinct read route. Duplicate control itself remains effect-free.
  const known = actions.lookup(commandId);
  if (known && digest(known.input) !== digest(input)) throw new RuntimeOwnerError('conflict');
  if (known && (operation === 'prepare' || known.phase !== 'prepared'))
    return Promise.resolve(known);
  if (operation === 'execute' && !known) throw new RuntimeOwnerError('conflict');
  const source = actions.source(input.memberId),
    sourceBinding = structuredClone(entry.binding);
  if (
    input.launchId !== sourceBinding.runId ||
    input.memberId !== sourceBinding.memberId ||
    input.expectedGeneration !== sourceBinding.generation ||
    digest(source.binding) !== digest(sourceBinding) ||
    source.configurationDigest !== digest(entry.profile) ||
    source.runtimeGeneration !== entry.profile.generation
  )
    throw new RuntimeOwnerError('conflict');
  const originalProvider = entry.provider,
    originalEndpoint = entry.endpoint;
  const profile = structuredClone(entry.profile);
  if (input.action === 'restart') profile.generation++;
  if (!Number.isSafeInteger(profile.generation)) throw new RuntimeOwnerError('hold');
  const binding =
    input.action === 'skip'
      ? sourceBinding
      : {
          ...sourceBinding,
          generation: `restart-${digest({ commandId, sourceBinding })}`,
        };
  const selected: ExpectedLaunchMember = {
    ...source,
    binding,
    runtimeGeneration: profile.generation,
    configurationDigest: digest(profile),
    skipped: input.action === 'skip',
  };
  if (input.action === 'restart') delete selected.restore;
  const baseProfile = structuredClone(entry.baseProfile),
    configuration = entry.selection?.configuration;
  const config = { ...entry.config, generation: profile.generation };
  if (operation === 'prepare') {
    assertGrant();
    if (input.action === 'restart') options.assertNewWorkAllowed(entry);
    return Promise.resolve(actions.prepare(input, selected).record);
  }
  const assertOriginal =
    options.admission?.captureTarget(entry) ??
    captureRuntimeControlAuthority({
      entry,
      principalId: options.principalId,
      assertWriter: options.assertWriter,
      isSealed: options.isSealed,
    });
  let selectedAuthority: (() => void) | undefined;
  return transitionRuntimeMember({
    input,
    sourceBinding,
    selected,
    actions,
    runtime: options.runtime,
    assertOriginalAuthority() {
      assertGrant();
      assertOriginal();
    },
    assertNewWorkAllowed() {
      assertGrant();
      options.assertNewWorkAllowed(entry);
    },
    verifyNewWorkAllowed() {
      return options.verifyNewWorkAllowed(entry);
    },
    async retireUnallocated() {
      if (originalProvider) return false;
      originalEndpoint?.revoke();
      await originalEndpoint?.close();
      return true;
    },
    async retireOriginal() {
      if (originalProvider && !(await originalProvider.cleanup())) return false;
      originalEndpoint?.revoke();
      await originalEndpoint?.close();
      return true;
    },
    installSelected() {
      assertGrant();
      // Physical old closure and endpoint revocation precede replacing these captured fields.
      entry.profile = profile;
      entry.baseProfile = baseProfile;
      entry.binding = binding;
      entry.delivery = { ...entry.delivery, ...binding };
      entry.config = config;
      entry.selection = {
        binding,
        generation: profile.generation,
        configurationDigest: digest(profile),
        baseConfigurationDigest: digest(baseProfile),
        ...(configuration === undefined ? {} : { configuration }),
        ...(input.action === 'skip' && source.restore ? { restore: source.restore } : {}),
      };
      const member = entry.team.definition.members.find((m) => m.memberId === input.memberId)!;
      member.delivery = entry.delivery;
      member.launchPolicy = input.action === 'skip' ? 'skip' : 'launch';
      delete entry.provider;
      delete entry.endpoint;
      delete entry.endpointExpiresAtMs;
      options.rekey(sourceBinding, entry);
      selectedAuthority =
        options.admission?.captureTarget(entry) ??
        captureRuntimeControlAuthority({
          entry,
          principalId: options.principalId,
          assertWriter: options.assertWriter,
          isSealed: options.isSealed,
        });
    },
    startSelected() {
      assertGrant();
      return launch.startMember(
        input.memberId,
        () => {
          assertGrant();
          if (!selectedAuthority) throw new RuntimeOwnerError('hold');
          selectedAuthority();
          options.assertNewWorkAllowed(entry);
        },
        input.commandId
      );
    },
  });
}
