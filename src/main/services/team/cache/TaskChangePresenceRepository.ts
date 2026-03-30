import type {
  PersistedTaskChangePresence,
  PersistedTaskChangePresenceIndex,
} from './taskChangePresenceCacheTypes';

export interface TaskChangePresenceRepository {
  load(teamName: string): Promise<PersistedTaskChangePresenceIndex | null>;
  upsertEntry(
    teamName: string,
    metadata: {
      projectFingerprint: string;
      logSourceGeneration: string;
      writtenAt: string;
    },
    entry: {
      taskId: string;
      taskSignature: string;
      presence: PersistedTaskChangePresence;
      writtenAt: string;
      logSourceGeneration: string;
    }
  ): Promise<void>;
}
