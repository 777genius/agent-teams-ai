import { RuntimeOwnerError } from '../runtime/contracts.js';
import { runtimeDigest } from '../runtime/identity.js';
import { conversationGaps } from '../runtime/runtimeConversation.js';
import { CONVERSATION_LIMITS } from '../runtime/activityContracts.js';
import { readRuntimeActivitySources } from './runtimeActivitySources.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { RuntimeConversationGap } from '../runtime/activityContracts.js';
import type { HostedTeam, MemberEntry } from './MemberEntry.js';
import type { RetainedNativeLaunch } from './createRuntimeNativeMemberCreation.js';
import type { TeamConversationCapture, TeamConversationView } from '../team/ownerMessageReads.js';
import type { JsonValue } from '../contracts.js';

interface ConversationOptions {
  team: HostedTeam | undefined;
  principalId: string;
  entries: readonly MemberEntry[];
  launches: ReadonlyMap<string, RetainedNativeLaunch>;
  runtime: Pick<RuntimeOwner, 'readConversation'>;
  assertCurrent(): void;
}
/** Original current lead and validated retained lineage only; no Runtime scan or runnable recipe. */
export function readTeamConversation(
  options: ConversationOptions,
  captured: Readonly<TeamConversationCapture>,
  mode: 'metadata' | 'messages'
): TeamConversationView {
  options.assertCurrent();
  const team = options.team;
  if (!team || options.principalId !== captured.principalId ||
      runtimeDigest(team.definition.binding) !== runtimeDigest(captured.binding))
    throw new RuntimeOwnerError('forbidden');
  const selected = captured.visible && captured.lead ? options.entries.filter(entry =>
    entry.binding.teamId === captured.binding.teamId && entry.binding.memberId === captured.lead!.memberId) : [];
  // Filter before lineage expansion and any member-record read, including metadata polling.
  const sources = readRuntimeActivitySources(selected, options.launches, captured.binding.teamId)
    .sort((a, b) => runtimeDigest(a.binding).localeCompare(runtimeDigest(b.binding)));
  const revisions: { binding: string; session: string; revision: string }[] = [];
  const gaps = new Set<RuntimeConversationGap>();
  const messages: { value: JsonValue; order: string }[] = [];
  for (const source of sources) {
    options.assertCurrent();
    if (!captured.lead || source.binding.memberId !== captured.lead.memberId ||
        source.binding.backendId !== captured.binding.backendId ||
        source.team.definition.binding.teamId !== captured.binding.teamId ||
        !source.costScope || !/^[a-f0-9]{64}$/u.test(source.costScope))
      throw new RuntimeOwnerError('hold');
    const original = source.team.definition.members.find(row => row.memberId === source.binding.memberId);
    if (!original || original.role !== 'lead' || original.name !== captured.lead.name)
      throw new RuntimeOwnerError('hold');
    const value = options.runtime.readConversation(source.binding, mode, source.recordRequired);
    if (runtimeDigest(value.binding) !== runtimeDigest(source.binding)) throw new RuntimeOwnerError('hold');
    revisions.push({ binding: runtimeDigest(source.binding), session: source.costScope, revision: value.revision });
    for (const gap of value.gaps) gaps.add(gap);
    if (mode === 'metadata') continue;
    for (const message of value.messages ?? []) {
      const text = message.blocks.map(block => block.text).join('\n');
      if (!text.trim()) continue;
      messages.push({ order: message.observedAt + ':' + runtimeDigest(source.binding) + ':' +
        String(message.firstSequence).padStart(16, '0'),
      value: { from: original.name, to: 'user', text, timestamp: message.observedAt,
        read: true, source: 'lead_session', messageId: message.messageId,
        leadSessionId: 'host-lead-' + source.costScope } });
    }
    // Bound the accumulator while reading each source; never retain all source files together.
    messages.sort((a, b) => a.order.localeCompare(b.order));
    while (messages.length > CONVERSATION_LIMITS.messages ||
        Buffer.byteLength(JSON.stringify(messages)) > CONVERSATION_LIMITS.bytes) {
      messages.shift(); gaps.add('retention');
    }
  }
  options.assertCurrent();
  return {
    revision: runtimeDigest({ binding: captured.binding, lead: captured.lead ?? null,
      visible: captured.visible, sources: revisions }),
    gaps: conversationGaps([...gaps]),
    ...(mode === 'messages' ? { messages: messages.map(row => row.value) } : {}),
  };
}
