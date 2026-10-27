import type { GroupChat } from './model.js';
import type { GroupMessage } from './message.js';
import type { GroupMessageReactions } from './groupReactions.js';
/** Feature-specific persistence. Publication adapters retain their existing ownership fences. */
export interface GroupChatStorage {
  teamRoot(teamName: string): Promise<string>;
  logicalPost<T>(key: string, action: () => Promise<T>): Promise<T>;
  readCreationOriginal(
    teamName: string,
    from: string,
    messageId: string
  ): Promise<Record<string, unknown>>;
  readReactions(teamName: string): Promise<GroupMessageReactions[]>;
  withReactions<T>(
    teamName: string,
    action: (entries: GroupMessageReactions[], save: () => Promise<void>) => Promise<T>
  ): Promise<T>;
  /** A registry snapshot read that does not acquire or publish writer-lock state. */
  readRegistry?(teamName: string): Promise<GroupChat[]>;
  withRegistry<T>(
    teamName: string,
    action: (groups: GroupChat[], save: () => Promise<void>) => Promise<T>
  ): Promise<T>;
  withInbox<T>(
    teamName: string,
    member: string,
    action: (rows: GroupMessage[], save: () => Promise<void>) => Promise<T>
  ): Promise<T>;
}
