/**
 * Stateless file service for the project editor.
 *
 * Every method receives `projectRoot` as the first argument.
 * Security: path containment, symlink escape detection, device path blocking,
 * binary detection, and size limits are enforced on every call.
 */

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import {
  isDevicePath,
  isGitInternalPath,
  isPathWithinAllowedDirectories,
  isPathWithinRoot,
  matchesSensitivePattern,
  validateFileName,
  validateFilePath,
} from '@main/utils/pathValidation';
import { createLogger } from '@shared/utils/logger';
import { shell } from 'electron';
import * as fs from 'fs/promises';
import { isBinaryFile } from 'isbinaryfile';
import * as path from 'path';

import type {
  BinaryPreviewResult,
  CreateDirResponse,
  CreateFileResponse,
  DeleteFileResponse,
  FileTreeEntry,
  MoveFileResponse,
  ReadDirResult,
  ReadFileResult,
  WriteFileResponse,
} from '@shared/types/editor';

// =============================================================================
// Constants
// =============================================================================

const MAX_FILE_SIZE_FULL = 2 * 1024 * 1024; // 2 MB
const MAX_FILE_SIZE_PREVIEW = 5 * 1024 * 1024; // 5 MB
const MAX_WRITE_SIZE = 2 * 1024 * 1024; // 2 MB
const MAX_DIR_ENTRIES = 500;
const PREVIEW_LINE_COUNT = 100;

/**
 * Extract the first N lines from text using indexOf — O(1) allocations vs split().
 * For a 5MB file with 100k lines, avoids creating 100k string objects.
 */
function sliceFirstNLines(text: string, n: number): string {
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const next = text.indexOf('\n', pos);
    if (next === -1) return text;
    pos = next + 1;
  }
  return text.slice(0, pos > 0 ? pos - 1 : 0);
}

const PREVIEW_MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};
const MAX_PREVIEW_SIZE = 10 * 1024 * 1024; // 10 MB

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  '__pycache__',
  '.cache',
  '.venv',
  '.tox',
  'vendor',
]);

const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db']);

const log = createLogger('ProjectFileService');

// =============================================================================
// Service
// =============================================================================

export class ProjectFileService {
  /**
   * Read a directory listing (depth=1, lazy loading).
   *
   * Security:
   * - Containment via isPathWithinAllowedDirectories (NOT validateFilePath — sensitive files
   *   are shown with isSensitive flag, not filtered)
   * - Symlinks: realpath + re-check containment, silently skip escapes (SEC-2)
   */
  async readDir(
    projectRoot: string,
    dirPath: string,
    maxEntries: number = MAX_DIR_ENTRIES
  ): Promise<ReadDirResult> {
    const t0 = performance.now();
    const normalizedDir = path.resolve(dirPath);

    // Containment check (allow sensitive files to be listed with flag)
    if (!isPathWithinAllowedDirectories(normalizedDir, projectRoot)) {
      throw new Error('Directory is outside project root');
    }

    const stat = await fs.lstat(normalizedDir);
    if (!stat.isDirectory()) {
      throw new Error('Not a directory');
    }

    const dirents = await fs.readdir(normalizedDir, { withFileTypes: true });

    // Phase 1: classify entries without I/O (instant)
    const pendingEntries: {
      dirent: { name: string };
      entryPath: string;
      type: 'file' | 'directory' | 'symlink';
    }[] = [];

    for (const dirent of dirents) {
      if (dirent.isDirectory() && IGNORED_DIRS.has(dirent.name)) continue;
      if (dirent.isFile() && IGNORED_FILES.has(dirent.name)) continue;

      const entryPath = path.join(normalizedDir, dirent.name);
      if (!isPathWithinRoot(entryPath, projectRoot)) continue;
      if (isGitInternalPath(entryPath)) continue;

      if (dirent.isSymbolicLink()) {
        pendingEntries.push({ dirent, entryPath, type: 'symlink' });
      } else if (dirent.isDirectory()) {
        pendingEntries.push({ dirent, entryPath, type: 'directory' });
      } else if (dirent.isFile()) {
        pendingEntries.push({ dirent, entryPath, type: 'file' });
      }

      if (pendingEntries.length >= maxEntries) break;
    }

    // Phase 2: resolve entries in parallel (I/O-bound)
    const STAT_CONCURRENCY = 50;
    const entries: FileTreeEntry[] = [];

    for (let i = 0; i < pendingEntries.length; i += STAT_CONCURRENCY) {
      const batch = pendingEntries.slice(i, i + STAT_CONCURRENCY);
      const resolved = await Promise.all(
        batch.map(async ({ dirent, entryPath, type }) => {
          if (type === 'directory') {
            return this.buildEntry(dirent.name, entryPath, 'directory');
          }
          if (type === 'symlink') {
            return this.resolveSymlinkEntry(dirent.name, entryPath, projectRoot);
          }
          // file — stat for size
          try {
            const fileStat = await fs.stat(entryPath);
            return this.buildEntry(dirent.name, entryPath, 'file', fileStat.size);
          } catch {
            return this.buildEntry(dirent.name, entryPath, 'file');
          }
        })
      );
      for (const entry of resolved) {
        if (entry) entries.push(entry);
      }
    }

    // Sort: directories first, then alphabetical
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const totalMs = performance.now() - t0;
    if (totalMs > 50) {
      log.info(
        `[perf] readDir: ${totalMs.toFixed(1)}ms, entries=${entries.length}, dirents=${dirents.length}, dir=${path.basename(normalizedDir)}`
      );
    }

    return { entries, truncated: pendingEntries.length >= maxEntries };
  }

  /**
   * Read file content with security checks and binary detection.
   *
   * Security:
   * - validateFilePath for traversal + sensitive check (SEC-1)
   * - Device path blocking (SEC-4)
   * - lstat + isFile check (SEC-4)
   * - Size limits (SEC-4)
   * - Post-read TOCTOU realpath verify (SEC-3)
   */
  async readFile(projectRoot: string, filePath: string): Promise<ReadFileResult> {
    // 1. Path validation (traversal, sensitive, symlink)
    const validation = validateFilePath(filePath, projectRoot);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const normalizedPath = validation.normalizedPath!;

    // 2. Device path block
    if (isDevicePath(normalizedPath)) {
      throw new Error('Cannot read device files');
    }

    // 3. File type check
    const stats = await fs.lstat(normalizedPath);
    if (!stats.isFile()) {
      throw new Error('Not a regular file');
    }

    // 4. Size check — reject files beyond preview limit
    if (stats.size > MAX_FILE_SIZE_PREVIEW) {
      throw new Error(
        `File too large (${(stats.size / 1024 / 1024).toFixed(1)}MB). Open in external editor.`
      );
    }

    // 5. Binary check
    const binary = await isBinaryFile(normalizedPath);
    if (binary) {
      return {
        content: '',
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        truncated: false,
        encoding: 'binary',
        isBinary: true,
      };
    }

    // 6. Read content
    const raw = await fs.readFile(normalizedPath, 'utf8');

    // 7. Post-read TOCTOU verify
    const realPath = await fs.realpath(normalizedPath);
    const postValidation = validateFilePath(realPath, projectRoot);
    if (!postValidation.valid) {
      throw new Error('Path changed during read (TOCTOU)');
    }

    // 8. Tiered response
    const isPreview = stats.size > MAX_FILE_SIZE_FULL;
    const content = isPreview ? sliceFirstNLines(raw, PREVIEW_LINE_COUNT) : raw;

    return {
      content,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      truncated: isPreview,
      encoding: 'utf-8',
      isBinary: false,
    };
  }

  /**
   * Write file content with atomic write and full security checks.
   *
   * Security:
   * - validateFilePath for traversal + sensitive check (SEC-1)
   * - Project-only containment — block writes outside projectRoot (SEC-14)
   * - Block .git/ internal paths (SEC-12)
   * - Device path blocking (SEC-4)
   * - Content size limit (2MB)
   * - Atomic write via tmp + rename (SEC-9)
   */
  async writeFile(
    projectRoot: string,
    filePath: string,
    content: string
  ): Promise<WriteFileResponse> {
    // 1. Path validation
    const validation = validateFilePath(filePath, projectRoot);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const normalizedPath = validation.normalizedPath!;

    // 2. Project-only containment (SEC-14: block ~/.claude writes)
    if (!isPathWithinRoot(normalizedPath, projectRoot)) {
      throw new Error('Path is outside project root');
    }

    // 3. Block .git/ internal paths (SEC-12)
    if (isGitInternalPath(normalizedPath)) {
      throw new Error('Cannot write to .git/ directory');
    }

    // 4. Device path block
    if (isDevicePath(normalizedPath)) {
      throw new Error('Cannot write to device files');
    }

    // 5. Content size check
    const byteLength = Buffer.byteLength(content, 'utf8');
    if (byteLength > MAX_WRITE_SIZE) {
      throw new Error(
        `Content too large (${(byteLength / 1024 / 1024).toFixed(1)}MB). Maximum is 2MB.`
      );
    }

    // 6. Atomic write
    await atomicWriteAsync(normalizedPath, content);

    // 7. Get post-write stats
    const stats = await fs.stat(normalizedPath);
    log.info('File saved:', normalizedPath, `(${stats.size} bytes)`);

    return {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    };
  }

  /**
   * Create a new empty file.
   *
   * Security:
   * - validateFileName for traversal, control chars (SEC-1)
   * - validateFilePath for parent containment (SEC-1)
   * - isPathWithinRoot for project-only containment (SEC-14)
   * - isGitInternalPath to block .git/ writes (SEC-12)
   * - Check parent is directory, file does NOT exist
   */
  async createFile(
    projectRoot: string,
    parentDir: string,
    fileName: string
  ): Promise<CreateFileResponse> {
    // 1. Validate file name
    const nameValidation = validateFileName(fileName);
    if (!nameValidation.valid) {
      throw new Error(nameValidation.error);
    }

    // 2. Validate parent directory path
    const parentValidation = validateFilePath(parentDir, projectRoot);
    if (!parentValidation.valid) {
      throw new Error(parentValidation.error);
    }
    const normalizedParent = parentValidation.normalizedPath!;

    // 3. Build full path
    const fullPath = path.join(normalizedParent, fileName.trim());

    // 4. Project-only containment (SEC-14)
    if (!isPathWithinRoot(fullPath, projectRoot)) {
      throw new Error('Path is outside project root');
    }

    // 5. Block .git/ internal paths (SEC-12)
    if (isGitInternalPath(fullPath)) {
      throw new Error('Cannot create files in .git/ directory');
    }

    // 6. Verify parent is a directory
    const parentStat = await fs.lstat(normalizedParent);
    if (!parentStat.isDirectory()) {
      throw new Error('Parent path is not a directory');
    }

    // 7. Verify file does NOT exist
    try {
      await fs.access(fullPath);
      throw new Error('File already exists');
    } catch (err) {
      // Expected: ENOENT means file doesn't exist (good)
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err; // Re-throw 'File already exists' or other errors
      }
    }

    // 8. Create empty file
    await fs.writeFile(fullPath, '', 'utf8');

    // 9. Get stats
    const stats = await fs.stat(fullPath);
    log.info('File created:', fullPath);

    return { filePath: fullPath, mtimeMs: stats.mtimeMs };
  }

  /**
   * Create a new directory.
   *
   * Same security checks as createFile, but uses fs.mkdir.
   */
  async createDir(
    projectRoot: string,
    parentDir: string,
    dirName: string
  ): Promise<CreateDirResponse> {
    // 1. Validate directory name
    const nameValidation = validateFileName(dirName);
    if (!nameValidation.valid) {
      throw new Error(nameValidation.error);
    }

    // 2. Validate parent directory path
    const parentValidation = validateFilePath(parentDir, projectRoot);
    if (!parentValidation.valid) {
      throw new Error(parentValidation.error);
    }
    const normalizedParent = parentValidation.normalizedPath!;

    // 3. Build full path
    const fullPath = path.join(normalizedParent, dirName.trim());

    // 4. Project-only containment (SEC-14)
    if (!isPathWithinRoot(fullPath, projectRoot)) {
      throw new Error('Path is outside project root');
    }

    // 5. Block .git/ internal paths (SEC-12)
    if (isGitInternalPath(fullPath)) {
      throw new Error('Cannot create directories in .git/ directory');
    }

    // 6. Verify parent is a directory
    const parentStat = await fs.lstat(normalizedParent);
    if (!parentStat.isDirectory()) {
      throw new Error('Parent path is not a directory');
    }

    // 7. Verify directory does NOT exist
    try {
      await fs.access(fullPath);
      throw new Error('Directory already exists');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }

    // 8. Create directory
    await fs.mkdir(fullPath);
    log.info('Directory created:', fullPath);

    return { dirPath: fullPath };
  }

  /**
   * Delete a file or directory by moving it to the system Trash.
   *
   * Security:
   * - validateFilePath for containment (SEC-1)
   * - isPathWithinRoot for project-only containment (SEC-14)
   * - isGitInternalPath to block .git/ deletes (SEC-12)
   * - Uses shell.trashItem for safe, reversible deletion
   */
  async deleteFile(projectRoot: string, filePath: string): Promise<DeleteFileResponse> {
    // 1. Validate file path
    const validation = validateFilePath(filePath, projectRoot);
    if (!validation.valid) {
      throw new Error(validation.error);
    }
    const normalizedPath = validation.normalizedPath!;

    // 2. Project-only containment (SEC-14)
    if (!isPathWithinRoot(normalizedPath, projectRoot)) {
      throw new Error('Path is outside project root');
    }

    // 3. Block .git/ internal paths (SEC-12)
    if (isGitInternalPath(normalizedPath)) {
      throw new Error('Cannot delete files in .git/ directory');
    }

    // 4. Verify path exists
    await fs.lstat(normalizedPath);

    // 5. Move to Trash (safe, reversible)
    await shell.trashItem(normalizedPath);
    log.info('File moved to Trash:', normalizedPath);

    return { deletedPath: normalizedPath };
  }

  /**
   * Move a file or directory to a new location within the project.
   *
   * Security:
   * - validateFilePath for traversal + sensitive check (SEC-1)
   * - isPathWithinRoot for project-only containment (SEC-14)
   * - isGitInternalPath to block .git/ moves (SEC-12)
   * - Parent → child move prevention
   * - Name collision detection
   * - EXDEV cross-device fallback (fs.cp + fs.rm)
   */
  async moveFile(
    projectRoot: string,
    sourcePath: string,
    destDir: string
  ): Promise<MoveFileResponse> {
    // 1. Validate source path
    const srcValidation = validateFilePath(sourcePath, projectRoot);
    if (!srcValidation.valid) {
      throw new Error(srcValidation.error);
    }
    const normalizedSrc = srcValidation.normalizedPath!;

    // 2. Validate dest directory path
    const destValidation = validateFilePath(destDir, projectRoot);
    if (!destValidation.valid) {
      throw new Error(destValidation.error);
    }
    const normalizedDest = destValidation.normalizedPath!;

    // 3. Project containment (SEC-14)
    if (!isPathWithinRoot(normalizedSrc, projectRoot)) {
      throw new Error('Source path is outside project root');
    }
    if (!isPathWithinRoot(normalizedDest, projectRoot)) {
      throw new Error('Destination path is outside project root');
    }

    // 4. Block .git/ paths (SEC-12)
    if (isGitInternalPath(normalizedSrc)) {
      throw new Error('Cannot move files from .git/ directory');
    }
    if (isGitInternalPath(normalizedDest)) {
      throw new Error('Cannot move files into .git/ directory');
    }

    // 5. Verify source exists and determine type
    const srcStat = await fs.lstat(normalizedSrc);
    const isDirectory = srcStat.isDirectory();

    // 6. Verify destination is a directory
    const destStat = await fs.lstat(normalizedDest);
    if (!destStat.isDirectory()) {
      throw new Error('Destination is not a directory');
    }

    // 7. Build new path
    const newPath = path.join(normalizedDest, path.basename(normalizedSrc));

    // 8. Prevent parent → child move (moving dir into itself)
    if (normalizedDest.startsWith(normalizedSrc + path.sep) || normalizedDest === normalizedSrc) {
      throw new Error('Cannot move a directory into itself');
    }

    // 9. Check destination doesn't already exist
    try {
      await fs.access(newPath);
      throw new Error('File already exists at destination');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }

    // 10. Block sensitive destination
    if (matchesSensitivePattern(newPath)) {
      throw new Error('Cannot move to sensitive file location');
    }

    // 11. Perform rename with EXDEV fallback
    try {
      await fs.rename(normalizedSrc, newPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        // Reuse srcStat from step 5 — no need for another fs.lstat
        if (isDirectory) {
          await fs.cp(normalizedSrc, newPath, { recursive: true });
        } else {
          await fs.copyFile(normalizedSrc, newPath);
        }
        await fs.rm(normalizedSrc, { recursive: true, force: true });
      } else {
        throw err;
      }
    }

    log.info('File moved:', normalizedSrc, '→', newPath);
    return { newPath, isDirectory };
  }

  /**
   * Rename a file or directory in place (same parent directory).
   */
  async renameFile(
    projectRoot: string,
    sourcePath: string,
    newName: string
  ): Promise<MoveFileResponse> {
    // 1. Validate new name
    const nameValidation = validateFileName(newName);
    if (!nameValidation.valid) {
      throw new Error(nameValidation.error);
    }

    // 2. Validate source path
    const srcValidation = validateFilePath(sourcePath, projectRoot);
    if (!srcValidation.valid) {
      throw new Error(srcValidation.error);
    }
    const normalizedSrc = srcValidation.normalizedPath!;

    // 3. Project containment
    if (!isPathWithinRoot(normalizedSrc, projectRoot)) {
      throw new Error('Source path is outside project root');
    }

    // 4. Block .git/ paths
    if (isGitInternalPath(normalizedSrc)) {
      throw new Error('Cannot rename files in .git/ directory');
    }

    // 5. Verify source exists
    const srcStat = await fs.lstat(normalizedSrc);
    const isDirectory = srcStat.isDirectory();

    // 6. Build new path (same parent, new name)
    const parentDir = path.dirname(normalizedSrc);
    const newPath = path.join(parentDir, newName);

    // 7. Check new path doesn't already exist
    try {
      await fs.access(newPath);
      throw new Error('A file or folder with that name already exists');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }

    // 8. Block sensitive destination
    if (matchesSensitivePattern(newPath)) {
      throw new Error('Cannot rename to a sensitive file name');
    }

    // 9. Perform rename
    await fs.rename(normalizedSrc, newPath);

    log.info('File renamed:', normalizedSrc, '→', newPath);
    return { newPath, isDirectory };
  }

  /**
   * Read a binary file as base64 for inline preview (images, etc.).
   *
   * Security:
   * - validateFilePath for traversal + sensitive check (SEC-1)
   * - Device path blocking (SEC-4)
   * - lstat + isFile check (SEC-4)
   * - Size limit (10MB)
   * - Post-read TOCTOU realpath verify (SEC-3)
   */
  async readBinaryPreview(projectRoot: string, filePath: string): Promise<BinaryPreviewResult> {
    // 1. Path validation
    const validation = validateFilePath(filePath, projectRoot);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const normalizedPath = validation.normalizedPath!;

    // 2. Device path block
    if (isDevicePath(normalizedPath)) {
      throw new Error('Cannot read device files');
    }

    // 3. File type check
    const stats = await fs.lstat(normalizedPath);
    if (!stats.isFile()) {
      throw new Error('Not a regular file');
    }

    // 4. Size check
    if (stats.size > MAX_PREVIEW_SIZE) {
      throw new Error(
        `File too large for preview (${(stats.size / 1024 / 1024).toFixed(1)}MB). Maximum is 10MB.`
      );
    }

    // 5. MIME type from extension
    const ext = path.extname(normalizedPath).toLowerCase();
    const mimeType = PREVIEW_MIME_MAP[ext];
    if (!mimeType) {
      throw new Error(`Unsupported preview format: ${ext}`);
    }

    // 6. Read file as Buffer → base64
    const buffer = await fs.readFile(normalizedPath);

    // 7. Post-read TOCTOU verify
    const realPath = await fs.realpath(normalizedPath);
    const postValidation = validateFilePath(realPath, projectRoot);
    if (!postValidation.valid) {
      throw new Error('Path changed during read (TOCTOU)');
    }

    return {
      base64: buffer.toString('base64'),
      mimeType,
      size: stats.size,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async resolveSymlinkEntry(
    name: string,
    entryPath: string,
    projectRoot: string
  ): Promise<FileTreeEntry | null> {
    try {
      const realPath = await fs.realpath(entryPath);
      if (!isPathWithinAllowedDirectories(realPath, projectRoot)) return null;
      const realStat = await fs.stat(realPath);
      return this.buildEntry(
        name,
        entryPath,
        realStat.isDirectory() ? 'directory' : 'file',
        realStat.isFile() ? realStat.size : undefined
      );
    } catch {
      return null; // broken symlink
    }
  }

  private buildEntry(
    name: string,
    entryPath: string,
    type: 'file' | 'directory',
    size?: number
  ): FileTreeEntry {
    const entry: FileTreeEntry = { name, path: entryPath, type };
    if (size !== undefined) entry.size = size;
    if (matchesSensitivePattern(entryPath)) entry.isSensitive = true;
    return entry;
  }
}

export { MAX_DIR_ENTRIES, MAX_FILE_SIZE_FULL, MAX_FILE_SIZE_PREVIEW, MAX_WRITE_SIZE };
