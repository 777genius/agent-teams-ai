/**
 * FileSystemProvider - Abstract interface for filesystem operations.
 *
 * Enables the app to read session data from either:
 * - Local filesystem (default)
 * - Remote SSH/SFTP connections
 *
 * Only covers read operations needed by session-data services.
 * Write operations (ConfigManager, NotificationManager) always stay local.
 */

import type { Readable } from 'stream';

// =============================================================================
// Types
// =============================================================================

/**
 * Simplified stat result matching the subset of fs.Stats used by services.
 */
export interface FsStatResult {
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

/**
 * Simplified directory entry matching the subset of fs.Dirent used by services.
 */
export interface FsDirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  /** Optional metadata provided by some providers (e.g., SFTP readdir attrs) */
  size?: number;
  /** Optional mtime in milliseconds since epoch */
  mtimeMs?: number;
  /** Optional birthtime/ctime fallback in milliseconds since epoch */
  birthtimeMs?: number;
}

/**
 * Options for createReadStream, matching the subset used by services.
 */
export interface ReadStreamOptions {
  start?: number;
  encoding?: BufferEncoding;
}

// =============================================================================
// Provider Interface
// =============================================================================

/**
 * Abstract filesystem provider interface.
 * All session-data services use this instead of direct `fs` calls.
 */
export interface FileSystemProvider {
  /** Provider type identifier */
  readonly type: 'local' | 'ssh';

  /** Check if a file or directory exists */
  exists(filePath: string): Promise<boolean>;

  /** Read a file's contents as a string */
  readFile(filePath: string, encoding?: BufferEncoding): Promise<string>;

  /** Get file/directory stats */
  stat(filePath: string): Promise<FsStatResult>;

  /** Read directory entries */
  readdir(dirPath: string): Promise<FsDirent[]>;

  /** Create a readable stream for a file */
  createReadStream(filePath: string, opts?: ReadStreamOptions): Readable;

  /** Cleanup resources */
  dispose(): void;
}
