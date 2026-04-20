import type { CodexAccountSnapshotDto } from './dto';

export interface CodexAccountElectronApi {
  getCodexAccountSnapshot: () => Promise<CodexAccountSnapshotDto>;
  refreshCodexAccountSnapshot: (options?: {
    includeRateLimits?: boolean;
    forceRefreshToken?: boolean;
  }) => Promise<CodexAccountSnapshotDto>;
  startCodexChatgptLogin: () => Promise<CodexAccountSnapshotDto>;
  cancelCodexChatgptLogin: () => Promise<CodexAccountSnapshotDto>;
  logoutCodexAccount: () => Promise<CodexAccountSnapshotDto>;
  onCodexAccountSnapshotChanged: (
    callback: (event: unknown, snapshot: CodexAccountSnapshotDto) => void
  ) => () => void;
}
