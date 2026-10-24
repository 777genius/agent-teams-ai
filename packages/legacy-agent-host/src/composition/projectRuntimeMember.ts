import { runtimeDigest } from '../runtime/identity.js';
import type { JsonValue } from '../contracts.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { RuntimeBinding, RuntimeSessionRecord } from '../runtime/contracts.js';
import type { MemberEntry } from './MemberEntry.js';

/** Existing public Runtime snapshot omits private operation references and native identities. */
export function projectRuntimeMember(options: {
  entry: MemberEntry;
  record: RuntimeSessionRecord | undefined;
  binding: RuntimeBinding;
  runtime: Pick<RuntimeOwner, 'readSession'>;
  isCurrent(): boolean;
}): JsonValue {
  const { entry, record, binding } = options;
  return {
    memberId: entry.profile.memberId,
    generation: binding.generation,
    phase: record?.phase ?? 'unopened',
    sealed: record?.sealed ?? false,
    custody: record?.custody ?? 'released',
    nativeReady:
      runtimeDigest(binding) === runtimeDigest(entry.binding) &&
      !!record?.nativeReady &&
      !!entry.provider?.isReady() &&
      options.isCurrent(),
    attached: options.runtime.readSession(binding).attached,
    inputs: (record?.inputs ?? []).map((input) => ({
      inputId: input.intent.inputId,
      phase: input.phase,
      ...(input.terminal ? { terminal: input.terminal } : {}),
    })),
    interactions: (record?.interactions ?? []).map(({ operationRef: _operation, ...safe }) => safe),
    ...(record?.diagnostic ? { diagnostic: record.diagnostic } : {}),
  };
}
