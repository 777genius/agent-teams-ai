import { pageOwnerMessages } from './pageOwnerMessages.js';
import { digest } from './identity.js';
import { TeamOwnerError } from './contracts.js';
import { json } from './TeamReviewCommands.js';
import { CONVERSATION_GAPS } from '../runtime/activityContracts.js';
import type { RuntimeConversationGap } from '../runtime/activityContracts.js';
import type { JsonValue } from '../contracts.js';
import type { TeamBinding, TeamGrant, TeamMember } from './contracts.js';
import type { TeamProductChanges } from './TeamProductChanges.js';

export interface TeamConversationCapture {
  binding: Readonly<TeamBinding>;
  principalId: string;
  grantFingerprint: string;
  rosterFingerprint: string;
  lead?: Readonly<{ memberId: string; name: string }>;
  visible: boolean;
}
export interface TeamConversationMetadata {
  revision: string;
  gaps: RuntimeConversationGap[];
}
export interface TeamConversationView extends TeamConversationMetadata {
  messages?: JsonValue[];
}
export type TeamConversationReadPort = (
  capture: Readonly<TeamConversationCapture>, mode: 'metadata' | 'messages'
) => TeamConversationView | undefined;
export function conversationMetadata(value: TeamConversationView): TeamConversationMetadata {
  if (!value || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(value.revision) ||
      !Array.isArray(value.gaps) || value.gaps.length > CONVERSATION_GAPS.length ||
      Array.from(value.gaps).some(row => !CONVERSATION_GAPS.includes(row)) ||
      new Set(value.gaps).size !== value.gaps.length) throw new TeamOwnerError('hold');
  return { revision: value.revision, gaps: [...value.gaps] };
}
interface MessageReadOptions {
  binding: TeamBinding;
  principalId: string;
  key: string;
  changes: TeamProductChanges;
  fenced<T>(action: () => T): T;
  authority(): { grant: TeamGrant; members: readonly TeamMember[]; removedMembers: readonly { name: string }[] };
  productMessages(grant: TeamGrant, members: readonly { name: string }[]): JsonValue[];
  productRevision(): string;
  conversation?: TeamConversationReadPort;
}
/** Original product readers plus a private derived read, never a public authority or callback argument. */
export function createOwnerMessageReads(options: MessageReadOptions) {
  const identity = (grant: TeamGrant, members: readonly TeamMember[]): Readonly<TeamConversationCapture> => {
    const leads = members.filter(row => row.role === 'lead');
    if (leads.length > 1) throw new TeamOwnerError('hold');
    const lead = leads[0];
    return Object.freeze({
      binding: Object.freeze({ ...options.binding }), principalId: options.principalId,
      grantFingerprint: digest(grant), rosterFingerprint: digest(members),
      ...(lead ? { lead: Object.freeze({ memberId: lead.memberId, name: lead.name }) } : {}),
      visible: grant.permissions.includes('admin') || grant.memberName === 'user' || grant.memberName === lead?.name,
    });
  };
  const prepare = (mode: 'metadata' | 'messages') => {
    if (!options.conversation) return undefined;
    const captured = options.fenced(() => {
      const { grant, members } = options.authority();
      return identity(grant, members);
    });
    // Deliberately outside the Team fence: Runtime retains its original member -> Team lock order.
    const projection = options.conversation(captured, mode);
    return { fingerprint: digest(captured), projection };
  };
  const finish = (prepared: ReturnType<typeof prepare>) => {
    const authority = options.authority();
    if (prepared && digest(identity(authority.grant, authority.members)) !== prepared.fingerprint)
      throw new TeamOwnerError('forbidden');
    return authority;
  };
  return {
    readChanges(cursor?: string): JsonValue {
      const prepared = prepare('metadata');
      return options.fenced(() => {
        if (prepared) finish(prepared);
        const product = options.changes.read(options.principalId, options.productRevision(), cursor);
        return json({ ...product, ...(prepared?.projection
          ? { conversation: conversationMetadata(prepared.projection) } : {}) });
      });
    },
    readMessagesPage(query: { cursor?: string; limit?: number; groupChatId?: string } = {}): JsonValue {
      const prepared = query.groupChatId === undefined ? prepare('messages') : undefined;
      return options.fenced(() => {
        const { grant, members, removedMembers } = finish(prepared);
        const projection = prepared?.projection;
        if (projection && (!Array.isArray(projection.messages) || projection.messages.length > 150))
          throw new TeamOwnerError('hold');
        return pageOwnerMessages({
          principalId: options.principalId, grant, teamName: options.binding.teamName, key: options.key,
          messages: [...options.productMessages(grant, [...members, ...removedMembers]), ...(projection?.messages ?? [])],
          ...(projection ? { conversation: conversationMetadata(projection) } : {}),
          ...query,
        });
      });
    },
  };
}
