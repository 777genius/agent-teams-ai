import type { DeliveryBinding } from '../team/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { MemberEntry } from './MemberEntry.js';
import type { HostGroupRun } from '../group-chats/GroupCommands.js';
const REQUIRED = [
  'group_chat_list',
  'group_chat_create',
  'group_chat_send',
  'group_chat_react',
  'group_chat_lookup',
];
/** Capability comes from an actually served authenticated catalog and the current owned allocation. */
export function readGroupRuntime(options: {
  entry: MemberEntry | undefined;
  read: RuntimeOwner['readSession'];
  current(entry: MemberEntry): boolean;
}): HostGroupRun | null {
  const entry = options.entry;
  if (!entry || !options.current(entry)) return null;
  const catalog = entry.endpoint?.getCatalogReceipt?.();
  if (
    !catalog ||
    runtimeDigest(catalog.binding) !== runtimeDigest(entry.delivery) ||
    !REQUIRED.every((name) => catalog.toolNames.includes(name))
  )
    return null;
  const { record, attached } = options.read(entry.binding);
  if (
    !attached ||
    !record ||
    record.sealed ||
    record.control ||
    !record.nativeReady ||
    !record.sessionRef ||
    record.phase !== 'allocated' ||
    record.custody !== 'owned'
  )
    return null;
  const runKey = `host-group-v1:${runtimeDigest({ binding: entry.delivery, config: entry.config, sessionRef: record.sessionRef })}`;
  return {
    provider: 'host',
    runKey,
    binding: structuredClone(entry.delivery),
    protocolVersion: 1,
    groupReactionProtocolVersion: 1,
    isCurrent: async () => readGroupRuntime(options)?.runKey === runKey,
  };
}

/** A historical native entry can neither shadow nor replace the current Team-owned target. */
export function selectCurrentGroupEntry<T extends { delivery: DeliveryBinding }>(
  entries: Iterable<T>,
  binding: DeliveryBinding | undefined
): T | undefined {
  if (!binding) return undefined;
  const matches = [...entries].filter(
    (entry) => runtimeDigest(entry.delivery) === runtimeDigest(binding)
  );
  return matches.length === 1 ? matches[0] : undefined;
}
