export interface ResolverHistoryPort {
  findMemberLogPaths(teamName: string, memberName: string): Promise<string[]>;
  getHomeDir(): string;
  readJsonlLines(filePath: string): AsyncIterable<string>;
}
export interface ResolverGitPort {
  isGitRepo(projectPath: string): Promise<boolean>;
  findCommitNearTimestamp(
    projectPath: string,
    filePath: string,
    timestamp: string
  ): Promise<string | null>;
  getFileAtCommit(projectPath: string, filePath: string, commit: string): Promise<string | null>;
}
export interface ResolverLogger {
  debug(message: string): void;
}
export type FileContentResolverOptions =
  | { mode: 'ledger-only' | 'preview-only'; logger?: ResolverLogger }
  | {
      mode: 'legacy';
      history: ResolverHistoryPort;
      git?: ResolverGitPort;
      logger?: ResolverLogger;
    };
