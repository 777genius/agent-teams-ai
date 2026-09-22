import type { CodexAccountSnapshotDto, CodexChatgptLoginMode } from './dto';

export interface CodexStartChatgptLoginOptions {
  mode?: CodexChatgptLoginMode;
}

export interface CodexAccountElectronApi {
  getCodexAccountSnapshot: () => Promise<CodexAccountSnapshotDto>;
  refreshCodexAccountSnapshot: (options?: {
    includeRateLimits?: boolean;
    forceRefreshToken?: boolean;
  }) => Promise<CodexAccountSnapshotDto>;
  startCodexChatgptLogin: (
    options?: CodexStartChatgptLoginOptions
  ) => Promise<CodexAccountSnapshotDto>;
  cancelCodexChatgptLogin: () => Promise<CodexAccountSnapshotDto>;
  logoutCodexAccount: () => Promise<CodexAccountSnapshotDto>;
  onCodexAccountSnapshotChanged: (
    callback: (event: unknown, snapshot: CodexAccountSnapshotDto) => void
  ) => () => void;
}
