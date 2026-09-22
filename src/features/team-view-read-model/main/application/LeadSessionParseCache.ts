import type { InboxMessage } from '@shared/types';

export interface LeadSessionParseCacheKey {
  jsonlPath: string;
  leadSessionId: string;
  leadName: string;
  maxTexts: number;
  schemaVersion: string;
}

export interface LeadSessionFileSignature {
  size: number;
  mtimeMs: number;
  ctimeMs?: number;
}

interface LeadSessionParseCacheEntry {
  signature: LeadSessionFileSignature;
  messages: InboxMessage[];
  cachedAtMs: number;
}

interface LeadSessionParseInFlightEntry {
  signature: LeadSessionFileSignature;
  promise: Promise<InboxMessage[]>;
}

const DEFAULT_MAX_ENTRIES = 64;

function keyToString(key: LeadSessionParseCacheKey): string {
  return JSON.stringify([
    key.schemaVersion,
    key.jsonlPath,
    key.leadSessionId,
    key.leadName,
    key.maxTexts,
  ]);
}

function inFlightKeyToString(
  key: LeadSessionParseCacheKey,
  signature: LeadSessionFileSignature
): string {
  return `${keyToString(key)}::${signature.size}:${signature.mtimeMs}:${signature.ctimeMs ?? ''}`;
}

export function areLeadSessionFileSignaturesEqual(
  left: LeadSessionFileSignature,
  right: LeadSessionFileSignature
): boolean {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    (left.ctimeMs ?? undefined) === (right.ctimeMs ?? undefined)
  );
}

function cloneMessage(message: InboxMessage): InboxMessage {
  return {
    ...message,
    ...(message.taskRefs ? { taskRefs: message.taskRefs.map((taskRef) => ({ ...taskRef })) } : {}),
    ...(message.attachments
      ? { attachments: message.attachments.map((attachment) => ({ ...attachment })) }
      : {}),
    ...(message.toolCalls
      ? { toolCalls: message.toolCalls.map((toolCall) => ({ ...toolCall })) }
      : {}),
    ...(message.slashCommand ? { slashCommand: { ...message.slashCommand } } : {}),
    ...(message.commandOutput ? { commandOutput: { ...message.commandOutput } } : {}),
  };
}

function cloneMessages(messages: readonly InboxMessage[]): InboxMessage[] {
  return messages.map(cloneMessage);
}

export class LeadSessionParseCache {
  private readonly entries = new Map<string, LeadSessionParseCacheEntry>();
  private readonly inFlightEntries = new Map<string, LeadSessionParseInFlightEntry>();

  constructor(private readonly maxEntries: number = DEFAULT_MAX_ENTRIES) {}

  getIfFresh(
    key: LeadSessionParseCacheKey,
    signature: LeadSessionFileSignature
  ): InboxMessage[] | null {
    const entryKey = keyToString(key);
    const entry = this.entries.get(entryKey);
    if (!entry) {
      return null;
    }
    if (!areLeadSessionFileSignaturesEqual(entry.signature, signature)) {
      this.entries.delete(entryKey);
      return null;
    }
    return cloneMessages(entry.messages);
  }

  getInFlight(
    key: LeadSessionParseCacheKey,
    signature: LeadSessionFileSignature
  ): Promise<InboxMessage[]> | null {
    const entry = this.inFlightEntries.get(inFlightKeyToString(key, signature));
    if (!entry) {
      return null;
    }
    return entry.promise.then((messages) => cloneMessages(messages));
  }

  setInFlight(
    key: LeadSessionParseCacheKey,
    signature: LeadSessionFileSignature,
    promise: Promise<InboxMessage[]>
  ): void {
    this.inFlightEntries.set(inFlightKeyToString(key, signature), {
      signature,
      promise,
    });
  }

  clearInFlight(key: LeadSessionParseCacheKey, signature: LeadSessionFileSignature): void {
    this.inFlightEntries.delete(inFlightKeyToString(key, signature));
  }

  set(
    key: LeadSessionParseCacheKey,
    signature: LeadSessionFileSignature,
    messages: readonly InboxMessage[]
  ): void {
    const entryKey = keyToString(key);
    this.entries.set(entryKey, {
      signature,
      messages: cloneMessages(messages),
      cachedAtMs: Date.now(),
    });
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.entries.delete(oldestKey);
    }
  }

  clearForPath(jsonlPath: string): void {
    for (const key of this.entries.keys()) {
      if (key.includes(`"${jsonlPath}"`)) {
        this.entries.delete(key);
      }
    }
    for (const key of this.inFlightEntries.keys()) {
      if (key.includes(`"${jsonlPath}"`)) {
        this.inFlightEntries.delete(key);
      }
    }
  }

  clearAll(): void {
    this.entries.clear();
    this.inFlightEntries.clear();
  }
}
