import { readGroupFile, writeGroupFile } from './groupStorageFiles.js';
import { join } from 'node:path';
import { safeSegment, digest } from '../../team/identity.js';
import { TeamOwnerError } from '../../team/contracts.js';
import {
  assertValidGroupInboxRows,
  hasGroupChatEnvelopeMarker,
} from '../../group-chats/envelope.js';
import { parseGroupRegistry } from '../../group-chats/storageSchema.js';
import { parseGroupReactions } from '../../group-chats/groupReactions.js';
import { GroupChatError } from '../../group-chats/model.js';
import { writeTeamJson } from './ControllerAdapter.js';
import type { GroupChatStorage } from '../../group-chats/storage.js';
import type { GroupMessage } from '../../group-chats/message.js';
import type { GroupChat } from '../../group-chats/model.js';
import type { GroupMessageReactions } from '../../group-chats/groupReactions.js';
import type { GroupRequestGuard } from '../../group-chats/GroupCommands.js';
import type { TeamStore } from '../../team/ports.js';
const pending = new Map<string, Promise<void>>();
async function serialized<T>(key: string, action: () => Promise<T>): Promise<T> {
  const before = pending.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  pending.set(key, current);
  await before;
  try {
    return await action();
  } finally {
    release();
    if (pending.get(key) === current) pending.delete(key);
  }
}
export class HostGroupStorage implements GroupChatStorage {
  private readonly directory: string;
  constructor(
    root: string,
    private readonly teamName: string,
    private readonly store: TeamStore,
    private readonly guard: GroupRequestGuard,
    private readonly humanOriginal: (row: Record<string, unknown>) => Record<string, unknown>
  ) {
    this.directory = join(root, 'teams', safeSegment(teamName));
  }
  async teamRoot(teamName: string): Promise<string> {
    this.check(teamName);
    return this.directory;
  }
  logicalPost<T>(key: string, action: () => Promise<T>): Promise<T> {
    return serialized(`${this.directory}:${key}`, action);
  }
  private check(teamName: string) {
    if (teamName !== this.teamName) throw new TeamOwnerError('forbidden');
    this.guard.before();
  }
  private fenced<T>(teamName: string, action: () => T): T {
    this.check(teamName);
    return this.store.fenced(() => {
      this.guard.inside();
      return action();
    });
  }
  private async resource<T, R>(
    teamName: string,
    relative: string,
    parse: (raw: unknown) => R,
    encode: (rows: R) => unknown,
    action: (rows: R, save: () => Promise<void>) => Promise<T>
  ): Promise<T> {
    this.check(teamName);
    const file = join(this.directory, relative);
    return serialized(file, async () => {
      const raw = this.fenced(teamName, () => readGroupFile(file));
      let expectedDigest = digest(raw ?? null);
      const rows = parse(raw);
      return action(rows, async () => {
        this.fenced(teamName, () => {
          if (digest(readGroupFile(file) ?? null) !== expectedDigest)
            throw new TeamOwnerError('hold');
          const next = encode(rows);
          this.guard.publish?.();
          writeGroupFile(file, next, writeTeamJson);
          expectedDigest = digest(next);
        });
      });
    });
  }
  withRegistry<T>(
    teamName: string,
    action: (groups: GroupChat[], save: () => Promise<void>) => Promise<T>
  ): Promise<T> {
    return this.resource(
      teamName,
      'group-chats.json',
      parseGroupRegistry,
      (groups) => ({ version: 1, groups }),
      action
    );
  }
  withReactions<T>(
    teamName: string,
    action: (entries: GroupMessageReactions[], save: () => Promise<void>) => Promise<T>
  ): Promise<T> {
    return this.resource(
      teamName,
      'group-chat-reactions.json',
      parseGroupReactions,
      (entries) => ({ version: 1, entries }),
      action
    );
  }
  async readReactions(teamName: string): Promise<GroupMessageReactions[]> {
    return this.fenced(teamName, () =>
      parseGroupReactions(readGroupFile(join(this.directory, 'group-chat-reactions.json')))
    );
  }
  withInbox<T>(
    teamName: string,
    member: string,
    action: (rows: GroupMessage[], save: () => Promise<void>) => Promise<T>
  ): Promise<T> {
    return this.resource(
      teamName,
      `inboxes/${safeSegment(member)}.json`,
      (raw) => {
        const rows = raw ?? [];
        assertValidGroupInboxRows(rows);
        return rows as GroupMessage[];
      },
      (rows) => rows,
      action
    );
  }
  async readCreationOriginal(
    teamName: string,
    from: string,
    messageId: string
  ): Promise<Record<string, unknown>> {
    return this.fenced(teamName, () => {
      const files = ['sentMessages.json', `inboxes/${safeSegment(from)}.json`, 'inboxes/user.json'];
      const matches: Record<string, unknown>[] = [];
      for (const file of files) {
        const rows = readGroupFile(join(this.directory, file));
        if (rows === undefined) continue;
        assertValidGroupInboxRows(rows);
        for (const value of rows) {
          if (!value || typeof value !== 'object') continue;
          const row = value as Record<string, unknown>;
          if (row.messageId !== messageId) continue;
          if (hasGroupChatEnvelopeMarker(row) !== (file === 'inboxes/user.json'))
            throw new GroupChatError('invalid-user-request', 'Original conversation mismatch');
          matches.push(this.humanOriginal(row));
        }
      }
      if (matches.length !== 1)
        throw new GroupChatError(
          'invalid-user-request',
          'Original request is missing or ambiguous'
        );
      return matches[0]!;
    });
  }
}
