/**
 * Editor types shared between main and renderer processes.
 */

// =============================================================================
// File Tree
// =============================================================================

export interface FileTreeEntry {
  name: string;
  /** Absolute path */
  path: string;
  type: 'file' | 'directory';
  /** File size in bytes (files only) */
  size?: number;
  /** True for .env, .key, credentials, etc. — shown with lock icon */
  isSensitive?: boolean;
  /** Lazy-loaded children (populated on expand) */
  children?: FileTreeEntry[];
}

// =============================================================================
// IPC Results
// =============================================================================

export interface ReadDirResult {
  entries: FileTreeEntry[];
  /** True when entries were truncated at MAX_DIR_ENTRIES */
  truncated: boolean;
}

export interface ReadFileResult {
  content: string;
  size: number;
  /** Unix timestamp (stats.mtimeMs) — baseline for conflict detection */
  mtimeMs: number;
  /** True when file was too large and only preview was returned */
  truncated: boolean;
  encoding: string;
  isBinary: boolean;
}

// =============================================================================
// Write Request/Response
// =============================================================================

export interface WriteFileRequest {
  filePath: string;
  content: string;
}

export interface WriteFileResponse {
  /** Unix timestamp after write (new mtimeMs) */
  mtimeMs: number;
  /** Bytes written */
  size: number;
}

// =============================================================================
// File Operations
// =============================================================================

export interface CreateFileResponse {
  filePath: string;
  mtimeMs: number;
}

export interface CreateDirResponse {
  dirPath: string;
}

export interface DeleteFileResponse {
  deletedPath: string;
}

export interface MoveFileResponse {
  newPath: string;
  isDirectory: boolean;
}

// =============================================================================
// Search
// =============================================================================

export interface SearchMatch {
  /** 1-based line number */
  line: number;
  /** 0-based column offset */
  column: number;
  /** The matching line text (trimmed) */
  lineContent: string;
}

export interface SearchFileResult {
  filePath: string;
  matches: SearchMatch[];
}

export interface SearchInFilesResult {
  results: SearchFileResult[];
  /** Total number of matches across all files */
  totalMatches: number;
  /** True when results were truncated at limit */
  truncated: boolean;
}

export interface SearchInFilesOptions {
  query: string;
  caseSensitive?: boolean;
  /** Maximum number of result files (default 100) */
  maxFiles?: number;
  /** Maximum number of total matches (default 500) */
  maxMatches?: number;
}

// =============================================================================
// Tab
// =============================================================================

export interface EditorFileTab {
  /** Unique key = filePath */
  id: string;
  filePath: string;
  fileName: string;
  /** Disambiguation suffix for duplicate names, e.g. "(main/utils)" */
  disambiguatedLabel?: string;
  /** Language identifier (from file extension) */
  language: string;
}

// =============================================================================
// Git Status
// =============================================================================

export type GitFileStatusType =
  | 'modified'
  | 'untracked'
  | 'staged'
  | 'deleted'
  | 'conflict'
  | 'renamed';

export interface GitFileStatus {
  /** Relative path from project root */
  path: string;
  status: GitFileStatusType;
  /** Original path for renamed files */
  renamedFrom?: string;
}

export interface GitStatusResult {
  files: GitFileStatus[];
  /** True if the project is inside a git repository */
  isGitRepo: boolean;
  /** Branch name (null if detached HEAD) */
  branch: string | null;
}

// =============================================================================
// File Watcher Events
// =============================================================================

export interface EditorFileChangeEvent {
  type: 'change' | 'create' | 'delete';
  /** Absolute path of the changed file */
  path: string;
}

// =============================================================================
// Editor API
// =============================================================================

export interface QuickOpenFile {
  path: string;
  name: string;
  relativePath: string;
}

export interface EditorAPI {
  open: (projectPath: string) => Promise<void>;
  close: () => Promise<void>;
  readDir: (dirPath: string, maxEntries?: number) => Promise<ReadDirResult>;
  readFile: (filePath: string) => Promise<ReadFileResult>;
  writeFile: (
    filePath: string,
    content: string,
    baselineMtimeMs?: number
  ) => Promise<WriteFileResponse>;
  createFile: (parentDir: string, fileName: string) => Promise<CreateFileResponse>;
  createDir: (parentDir: string, dirName: string) => Promise<CreateDirResponse>;
  deleteFile: (filePath: string) => Promise<DeleteFileResponse>;
  moveFile: (sourcePath: string, destDir: string) => Promise<MoveFileResponse>;
  renameFile: (sourcePath: string, newName: string) => Promise<MoveFileResponse>;
  searchInFiles: (options: SearchInFilesOptions) => Promise<SearchInFilesResult>;
  listFiles: () => Promise<QuickOpenFile[]>;
  readBinaryPreview: (filePath: string) => Promise<BinaryPreviewResult>;
  gitStatus: () => Promise<GitStatusResult>;
  watchDir: (enable: boolean) => Promise<void>;
  /**
   * Provide the list of currently-open file paths (tabs) to watch.
   * Intended as a performance optimization: avoids watching the whole project tree.
   */
  setWatchedFiles: (filePaths: string[]) => Promise<void>;
  /**
   * Provide the list of directories to watch shallowly (depth=0).
   * Intended to keep the explorer tree in sync with external changes without
   * recursively watching the whole project.
   */
  setWatchedDirs: (dirPaths: string[]) => Promise<void>;
  /** Subscribe to file change events (main → renderer). Returns cleanup function. */
  onEditorChange: (callback: (event: EditorFileChangeEvent) => void) => () => void;
}

/** Editor-independent project file operations (e.g. @file mentions). */
export interface ProjectAPI {
  listFiles: (projectPath: string) => Promise<QuickOpenFile[]>;
}

// =============================================================================
// Binary Preview
// =============================================================================

export interface BinaryPreviewResult {
  /** Base64-encoded file content */
  base64: string;
  /** MIME type (e.g. 'image/png') */
  mimeType: string;
  /** File size in bytes */
  size: number;
}

// =============================================================================
// Selection Action Menu
// =============================================================================

export interface EditorSelectionInfo {
  text: string;
  filePath: string;
  fromLine: number;
  toLine: number;
  /** Screen coords of selection end (for menu positioning) */
  screenRect: { top: number; right: number; bottom: number };
}

export interface EditorSelectionAction {
  type: 'sendMessage' | 'createTask';
  filePath: string;
  /** 1-based start line, or null for file-level mentions (no code selection) */
  fromLine: number | null;
  /** 1-based end line, or null for file-level mentions (no code selection) */
  toLine: number | null;
  selectedText: string;
  /** Pre-formatted context block (markdown code fence or file reference) */
  formattedContext: string;
  /** Relative display path for file-level mentions */
  displayPath?: string;
  /** Whether this action represents a folder (not a file) */
  isFolder?: boolean;
}
