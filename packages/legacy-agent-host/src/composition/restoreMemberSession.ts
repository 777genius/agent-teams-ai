import { memberInitialInstructions } from './TeamLaunchComposition.js';
import { initialContextDigest } from '../team-launch/context.js';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import type { MemberEntry } from './MemberEntry.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { RuntimeBinding, RuntimeSessionRecord } from '../runtime/contracts.js';
import type { TeamLaunchOwner } from '../team-launch/TeamLaunchOwner.js';

interface RestoreOptions {
  entry: MemberEntry;
  runtime: RuntimeOwner;
  launch: TeamLaunchOwner;
  commandId: string;
  reference: string;
  expectedGeneration: string;
  assertAuthority?: (() => void) | undefined;
  rekey(previous: RuntimeBinding, entry: MemberEntry): void;
}
interface RestoreResult {
  binding: RuntimeBinding;
  record: RuntimeSessionRecord | undefined;
}

// Only a same-incarnation continuation barrier. Durable command identity and
// selection remain in the launch record; Runtime alone claims native allocation.
const flights = new WeakMap<
  MemberEntry,
  { fingerprint: string; pending: Promise<RestoreResult> }
>();

/** Explicit selected resume. The launch publication is the sole active-binding registry. */
export function restoreMemberSession(options: RestoreOptions): Promise<RestoreResult> {
  const fingerprint = runtimeDigest({
    commandId: options.commandId,
    reference: options.reference,
    expectedGeneration: options.expectedGeneration,
  });
  const current = flights.get(options.entry);
  if (current)
    return current.fingerprint === fingerprint
      ? current.pending
      : Promise.reject(new RuntimeOwnerError('conflict'));
  const pending = restoreSelectedMember(options);
  flights.set(options.entry, { fingerprint, pending });
  const clear = () => {
    if (flights.get(options.entry)?.pending === pending) flights.delete(options.entry);
  };
  void pending.then(clear, clear);
  return pending;
}

async function restoreSelectedMember(options: RestoreOptions): Promise<RestoreResult> {
  const { entry, runtime, launch, commandId, reference } = options;
  options.assertAuthority?.();
  const known = launch.restoreSelection(commandId, entry.profile.memberId, reference);
  if (known) {
    if (!known.binding) throw new RuntimeOwnerError('hold');
    if (known.restore?.sourceBinding.generation !== options.expectedGeneration)
      throw new RuntimeOwnerError('conflict');
    if (runtimeDigest(known.binding) === runtimeDigest(entry.binding)) {
      const opening = launch.startMember(entry.profile.memberId, options.assertAuthority);
      if (opening) await opening;
    }
    return { binding: known.binding, record: runtime.readSession(known.binding).record };
  }
  const sourceBinding = structuredClone(entry.binding);
  if (sourceBinding.generation !== options.expectedGeneration)
    throw new RuntimeOwnerError('conflict');
  const source = runtime.readSession(sourceBinding);
  if (source.record?.phase !== 'closed' || source.record.custody !== 'released' || source.attached)
    throw new RuntimeOwnerError('hold');
  // Retire only this exact already-stopped capture. A failed cleanup cannot select a new generation.
  if (entry.provider && !(await entry.provider.cleanup())) throw new RuntimeOwnerError('hold');
  entry.endpoint?.revoke();
  await entry.endpoint?.close();
  options.assertAuthority?.();
  const generation = entry.profile.generation + 1;
  if (!Number.isSafeInteger(generation)) throw new RuntimeOwnerError('hold');
  const profile = { ...structuredClone(entry.profile), generation };
  const binding = {
    ...sourceBinding,
    generation: `restore-${runtimeDigest({ commandId, reference, sourceBinding })}`,
  };
  const config = { ...entry.config, generation };
  const selected = entry.team.definition.members.find(
    (member) => member.memberId === profile.memberId
  )!;
  const restore = { commandId, reference, sourceBinding };
  const member = launch.selectRestore(
    {
      commandId,
      member: {
        memberId: profile.memberId,
        binding,
        runtimeGeneration: generation,
        configurationDigest: runtimeDigest(profile),
        baseConfigurationDigest: runtimeDigest(entry.baseProfile),
        contextDigest: initialContextDigest(
          memberInitialInstructions(
            selected.name,
            selected.role,
            entry.delivery.teamName,
            profile.cwd
          )
        ),
        configRevision: config.configRevision,
        timeoutMs: profile.limits.timeoutMs,
        skipped: false,
        restore,
      },
    },
    () => runtime.validateRestoreSource({ sourceBinding, reference, binding, config })
  );
  if (runtimeDigest(member.binding) !== runtimeDigest(binding))
    throw new RuntimeOwnerError('conflict');
  entry.profile = profile;
  entry.binding = binding;
  entry.delivery = { ...entry.delivery, ...binding };
  selected.delivery = entry.delivery;
  entry.config = config;
  entry.selection = {
    binding,
    generation,
    configurationDigest: runtimeDigest(profile),
    baseConfigurationDigest: runtimeDigest(entry.baseProfile),
    ...(entry.selection?.configuration ? { configuration: entry.selection.configuration } : {}),
    restore,
  };
  delete entry.provider;
  delete entry.endpoint;
  delete entry.endpointExpiresAtMs;
  options.rekey(sourceBinding, entry);
  const opening = launch.startMember(profile.memberId, options.assertAuthority);
  if (opening) await opening;
  return { binding, record: runtime.readSession(binding).record };
}
