export const TEAM_TRANSCRIPT_AFFINITY_INDEX_SCHEMA_VERSION = 1;
export const TEAM_TRANSCRIPT_AFFINITY_INDEX_MAX_ENTRIES_PER_PROJECT = 20_000;

export type TeamTranscriptAffinityVerdict = 'belongs' | 'does_not_belong';

export type TeamTranscriptAffinityMatchSource = 'nested_team_name' | 'text_team_mention' | 'none';

export interface TeamTranscriptAffinityFileSignature {
  size: number;
  mtimeMs: number;
  ctimeMs?: number;
}

export interface PersistedTeamTranscriptAffinityEntry {
  fileName: string;
  sessionId: string;
  signature: TeamTranscriptAffinityFileSignature;
  verdict: TeamTranscriptAffinityVerdict;
  headWindowFull: boolean;
  inspectedLineCount: number;
  matchSource: TeamTranscriptAffinityMatchSource;
  writtenAt: string;
}

export interface PersistedTeamTranscriptAffinityIndex {
  version: typeof TEAM_TRANSCRIPT_AFFINITY_INDEX_SCHEMA_VERSION;
  teamName: string;
  projectId: string;
  projectDir: string;
  writtenAt: string;
  entries: Record<string, PersistedTeamTranscriptAffinityEntry>;
}

export interface TeamTranscriptAffinityIndexStore {
  loadProject(
    teamName: string,
    projectId: string
  ): Promise<PersistedTeamTranscriptAffinityIndex | null>;

  upsertProjectEntries(input: {
    teamName: string;
    projectId: string;
    projectDir: string;
    rootFileNames: ReadonlySet<string>;
    entries: readonly PersistedTeamTranscriptAffinityEntry[];
  }): Promise<void>;
}
