export interface ClaudeRootInfo {
  /** Auto-detected default Claude root path for this machine */
  defaultPath: string;
  /** Effective path currently used by local context */
  resolvedPath: string;
  /** Custom override path from settings (null means auto-detect) */
  customPath: string | null;
}

export interface ClaudeRootFolderSelection {
  /** Selected directory absolute path */
  path: string;
  /** Whether the selected folder name is exactly ".claude" */
  isClaudeDirName: boolean;
  /** Whether selected folder contains a "projects" directory */
  hasProjectsDir: boolean;
}

export interface WslClaudeRootCandidate {
  /** WSL distribution name (e.g. Ubuntu) */
  distro: string;
  /** Candidate Claude root path in UNC format */
  path: string;
  /** True if this root contains "projects" directory */
  hasProjectsDir: boolean;
}
