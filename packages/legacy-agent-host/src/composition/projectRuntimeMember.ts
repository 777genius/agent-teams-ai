import { channel } from 'node:diagnostics_channel';
import { runtimeDigest } from '../runtime/identity.js';
import type { JsonValue } from '../contracts.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { RuntimeBinding, RuntimeSessionRecord } from '../runtime/contracts.js';
import type { MemberEntry } from './MemberEntry.js';

const runtimeProjection = channel('agent-teams.legacy-host.runtime-projection');

/** Existing public Runtime snapshot omits private operation references and native identities. */
export function projectRuntimeMember(options: {
  entry: MemberEntry;
  record: RuntimeSessionRecord | undefined;
  binding: RuntimeBinding;
  runtime: Pick<RuntimeOwner, 'readSession'>;
  isCurrent(): boolean;
}): JsonValue {
  const { entry, record, binding } = options;
  const observed = options.runtime.readSession(binding);
  const bindingMatches = runtimeDigest(binding) === runtimeDigest(entry.binding);
  let recordReady: boolean | null = null, providerReady: boolean | null = null, ownerCurrent: boolean | null = null;
  const nativeReady =
    bindingMatches &&
    (recordReady = !!record?.nativeReady) &&
    (providerReady = !!entry.provider?.isReady()) &&
    (ownerCurrent = options.isCurrent());
  const captured =
    nativeReady &&
    observed.attached &&
    record !== undefined &&
    record.phase === 'allocated' &&
    record.custody === 'owned' &&
    !record.sealed &&
    runtimeDigest(record.binding) === runtimeDigest(binding) &&
    runtimeDigest(observed.record) === runtimeDigest(record);
  const attachmentCapabilities = captured ? entry.provider?.attachmentCapabilities : undefined;
  const sessionCommands = captured
    ? entry.profile.provider === 'codex'
      ? entry.team.connection.readRoster().members.some(member =>
          member.memberId === entry.profile.memberId && member.role === 'lead')
        ? [{ name: 'cost', description: 'Show reported token usage for this captured session' }]
        : []
      : entry.provider?.sessionCommands?.() ?? []
    : undefined;
  const value: JsonValue = {
    memberId: entry.profile.memberId,
    generation: binding.generation,
    phase: record?.phase ?? 'unopened',
    sealed: record?.sealed ?? false,
    custody: record?.custody ?? 'released',
    nativeReady,
    attached: observed.attached,
    ...(sessionCommands ? { sessionCommands: sessionCommands.map(({ name, description }) => ({ name, description })) } : {}),
    ...(attachmentCapabilities
      ? {
          attachmentCapabilities: {
            images: attachmentCapabilities.images,
            documents: attachmentCapabilities.documents,
            textFiles: attachmentCapabilities.textFiles,
          },
        }
      : {}),
    inputs: (record?.inputs ?? []).map((input) => ({
      inputId: input.intent.inputId,
      phase: input.phase,
      ...(input.terminal ? { terminal: input.terminal } : {}),
    })),
    interactions: (record?.interactions ?? []).map(({ operationRef: _operation, ...safe }) => safe),
    ...(record?.diagnostic ? { diagnostic: record.diagnostic } : {}),
  };
  try {
    if (runtimeProjection.hasSubscribers) runtimeProjection.publish({
      viewDigest: runtimeDigest(value), bindingMatches, recordReady, providerReady, ownerCurrent, nativeReady,
    });
  } catch { /* Private observation cannot replace the original public result. */ }
  return value;
}
