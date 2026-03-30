/**
 * Editor IPC handlers.
 *
 * Module-level state: `activeProjectRoot` stores the validated project path.
 * Renderer cannot override it — it's set only via `editor:open` with full validation (SEC-5).
 */

import { getClaudeBasePath } from '@main/utils/pathDecoder';
import { isPathWithinRoot } from '@main/utils/pathValidation';
import { safeSendToRenderer } from '@main/utils/safeWebContentsSend';
import {
  EDITOR_CHANGE,
  EDITOR_CLOSE,
  EDITOR_CREATE_DIR,
  EDITOR_CREATE_FILE,
  EDITOR_DELETE_FILE,
  EDITOR_GIT_STATUS,
  EDITOR_LIST_FILES,
  EDITOR_MOVE_FILE,
  EDITOR_OPEN,
  EDITOR_READ_BINARY_PREVIEW,
  EDITOR_READ_DIR,
  EDITOR_READ_FILE,
  EDITOR_RENAME_FILE,
  EDITOR_SEARCH_IN_FILES,
  EDITOR_SET_WATCHED_DIRS,
  EDITOR_SET_WATCHED_FILES,
  EDITOR_WATCH_DIR,
  EDITOR_WRITE_FILE,
  PROJECT_LIST_FILES,
  // eslint-disable-next-line boundaries/element-types -- IPC channel constants are shared between main and preload by design
} from '@preload/constants/ipcChannels';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs/promises';
import * as path from 'path';

import {
  checkFileConflict,
  createSearchAbortController,
  EditorFileWatcher,
  FileSearchService,
  GitStatusService,
  ProjectFileService,
} from '../services/editor';

import { createIpcWrapper } from './ipcWrapper';

import type {
  BinaryPreviewResult,
  CreateDirResponse,
  CreateFileResponse,
  DeleteFileResponse,
  GitStatusResult,
  MoveFileResponse,
  QuickOpenFile,
  ReadDirResult,
  ReadFileResult,
  SearchInFilesOptions,
  SearchInFilesResult,
  WriteFileResponse,
} from '@shared/types/editor';
import type { IpcResult } from '@shared/types/ipc';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';

// =============================================================================
// Module-level state (SEC-5)
// =============================================================================

let activeProjectRoot: string | null = null;

let mainWindowRef: BrowserWindow | null = null;

let activeSearchController: AbortController | null = null;

const projectFileService = new ProjectFileService();
const fileSearchService = new FileSearchService();
const gitStatusService = new GitStatusService();
const editorFileWatcher = new EditorFileWatcher();
const wrapHandler = createIpcWrapper('IPC:editor');
const log = createLogger('IPC:editor');

// =============================================================================
// Handlers
// =============================================================================

/**
 * Initialize editor with validated project path (SEC-15).
 */
async function handleEditorOpen(
  _event: IpcMainInvokeEvent,
  projectPath: string
): Promise<IpcResult<void>> {
  return wrapHandler('open', async () => {
    // Validate projectPath before trusting it
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error('Invalid project path');
    }

    if (!path.isAbsolute(projectPath)) {
      throw new Error('Project path must be absolute');
    }

    const normalized = path.resolve(path.normalize(projectPath));

    // Block filesystem root
    if (normalized === '/' || /^[A-Z]:\\$/i.test(normalized)) {
      throw new Error('Cannot open filesystem root as project');
    }

    // Block ~/.claude directory itself
    const claudeDir = getClaudeBasePath();
    if (isPathWithinRoot(normalized, claudeDir)) {
      throw new Error('Cannot open Claude data directory as project');
    }

    // Verify it's an existing directory
    const stat = await fs.stat(normalized);
    if (!stat.isDirectory()) {
      throw new Error('Project path is not a directory');
    }

    // Stop any previous watcher/git before switching projects
    editorFileWatcher.stop();
    gitStatusService.destroy();

    activeProjectRoot = normalized;
    gitStatusService.init(normalized);
    log.info('Editor opened:', normalized);
  });
}

/**
 * Cleanup editor state.
 */
async function handleEditorClose(): Promise<IpcResult<void>> {
  return wrapHandler('close', async () => {
    editorFileWatcher.stop();
    gitStatusService.destroy();
    activeProjectRoot = null;
    log.info('Editor closed');
  });
}

/**
 * Read directory listing (depth=1, lazy).
 */
async function handleEditorReadDir(
  _event: IpcMainInvokeEvent,
  dirPath: string,
  maxEntries?: number
): Promise<IpcResult<ReadDirResult>> {
  return wrapHandler('readDir', async () => {
    if (!activeProjectRoot) throw new Error('Editor not initialized');
    return projectFileService.readDir(activeProjectRoot, dirPath, maxEntries ?? undefined);
  });
}

/**
 * Read file content with binary detection.
 */
async function handleEditorReadFile(
  _event: IpcMainInvokeEvent,
  filePath: string
): Promise<IpcResult<ReadFileResult>> {
  return wrapHandler('readFile', async () => {
    if (!activeProjectRoot) throw new Error('Editor not initialized');
    return projectFileService.readFile(activeProjectRoot, filePath);
  });
}

/**
 * Write file content with atomic write (SEC-9, SEC-12, SEC-14).
 * Optional baselineMtimeMs enables conflict detection before writing.
 */
async function handleEditorWriteFile(
  _event: IpcMainInvokeEvent,
  filePath: string,
  content: string,
  baselineMtimeMs?: number
): Promise<IpcResult<WriteFileResponse>> {
  return wrapHandler('writeFile', async () => {
    if (!activeProjectRoot) throw new Error('Editor not initialized');

    // Conflict detection: check if file was modified externally since last read/save
    if (baselineMtimeMs !== undefined && baselineMtimeMs > 0) {
      const conflict = await checkFileConflict(filePath, baselineMtimeMs);
      if (conflict.hasConflict) {
        if (conflict.deleted) {
          throw new Error('CONFLICT_DELETED: File was deleted externally');
        }
        throw new Error('CONFLICT: File was modified externally');
      }
    }

    return projectFileService.writeFile(activeProjectRoot, filePath, content);
  });
}

/**
 * Create a new file in the project.
 */
async function handleEditorCreateFile(
  _event: IpcMainInvokeEvent,
  parentDir: string,
  fileName: string
): Promise<IpcResult<CreateFileResponse>> {
  return wrapHandler('createFile', async () => {
    if (!activeProjectRoot) throw new Error('Editor not initialized');
    return projectFileService.createFile(activeProjectRoot, parentDir, fileName);
  });
}

/**
 * Create a new directory in the project.
 */
async function handleEditorCreateDir(
  _event: IpcMainInvokeEvent,
  parentDir: string,
  dirName: string
): Promise<IpcResult<CreateDirResponse>> {
  return wrapHandler('createDir', async () => {
    if (!activeProjectRoot) throw new Error('Editor not initialized');
    return projectFileService.createDir(activeProjectRoot, parentDir, dirName);
  });
}

/**
 * Delete a file or directory (move to Trash).
 */
async function handleEditorDeleteFile(
  _event: IpcMainInvokeEvent,
  filePath: string
): Promise<IpcResult<DeleteFileResponse>> {
  return wrapHandler('deleteFile', async () => {
    if (!activeProjectRoot) throw new Error('Editor not initialized');
    return projectFileService.deleteFile(activeProjectRoot, filePath);
  });
}

/**
 * Move a file or directory to a new location.
 */
async function handleEditorMoveFile(
  _event: IpcMainInvokeEvent,
  sourcePath: string,
  destDir: string
): Promise<IpcResult<MoveFileResponse>> {
  return wrapHandler('moveFile', async () => {
    if (!activeProjectRoot) throw new Error('Editor not initialized');
    return projectFileService.moveFile(activeProjectRoot, sourcePath, destDir);
  });
}

/**
 * Rename a file or directory in place.
 */
async function handleEditorRenameFile(
  _event: IpcMainInvokeEvent,
  sourcePath: string,
  newName: string
): Promise<IpcResult<MoveFileResponse>> {
  return wrapHandler('renameFile', async () => {
    if (!activeProjectRoot) throw new Error('Editor not initialized');
    return projectFileService.renameFile(activeProjectRoot, sourcePath, newName);
  });
}

/**
 * Search in files (literal string search, SEC-8 timeout).
 */
async function handleEditorSearchInFiles(
  _event: IpcMainInvokeEvent,
  options: SearchInFilesOptions
): Promise<IpcResult<SearchInFilesResult>> {
  return wrapHandler('searchInFiles', async () => {
    if (!activeProjectRoot) throw new Error('Editor not initialized');

    // Cancel any in-flight search
    if (activeSearchController) {
      activeSearchController.abort();
    }

    const controller = createSearchAbortController();
    activeSearchController = controller;

    try {
      return await fileSearchService.searchInFiles(activeProjectRoot, options, controller.signal);
    } finally {
      if (activeSearchController === controller) {
        activeSearchController = null;
      }
    }
  });
}

/**
 * List all project files recursively (for Quick Open).
 */
async function handleEditorListFiles(): Promise<IpcResult<QuickOpenFile[]>> {
  return wrapHandler('listFiles', async () => {
    if (!activeProjectRoot) throw new Error('Editor not initialized');
    return fileSearchService.listFiles(activeProjectRoot);
  });
}

/**
 * List project files by explicit path (for @file mentions).
 * Independent of editor state — works without editor:open.
 */
async function handleProjectListFiles(
  _event: IpcMainInvokeEvent,
  projectPath: string
): Promise<IpcResult<QuickOpenFile[]>> {
  return wrapHandler('project:listFiles', async () => {
    if (typeof projectPath !== 'string' || projectPath.length === 0) {
      throw new Error('projectPath is required');
    }
    const normalized = path.resolve(projectPath);
    await fs.access(normalized);
    return fileSearchService.listFiles(normalized);
  });
}

/**
 * Get git status for current project (cached 5s).
 */
async function handleEditorGitStatus(): Promise<IpcResult<GitStatusResult>> {
  return wrapHandler('gitStatus', async () => {
    if (!activeProjectRoot) throw new Error('Editor not initialized');
    return gitStatusService.getStatus();
  });
}

/**
 * Read binary file as base64 for inline preview.
 */
async function handleEditorReadBinaryPreview(
  _event: IpcMainInvokeEvent,
  filePath: string
): Promise<IpcResult<BinaryPreviewResult>> {
  return wrapHandler('readBinaryPreview', async () => {
    if (!activeProjectRoot) throw new Error('Editor not initialized');
    return projectFileService.readBinaryPreview(activeProjectRoot, filePath);
  });
}

/**
 * Enable/disable file watcher for current project.
 */
async function handleEditorWatchDir(
  _event: IpcMainInvokeEvent,
  enable: boolean
): Promise<IpcResult<void>> {
  return wrapHandler('watchDir', async () => {
    if (!activeProjectRoot) throw new Error('Editor not initialized');

    if (enable) {
      editorFileWatcher.start(activeProjectRoot, (event) => {
        // Structural changes (create/delete): immediate invalidation.
        // Content changes: debounced (500ms) to coalesce rapid saves/builds.
        if (event.type === 'create' || event.type === 'delete') {
          gitStatusService.invalidateCache();
          if (activeProjectRoot) {
            fileSearchService.invalidateListFilesCache(activeProjectRoot);
          }
        } else {
          gitStatusService.invalidateCacheDebounced();
        }

        // Forward event to renderer
        safeSendToRenderer(mainWindowRef, EDITOR_CHANGE, event);
      });
    } else {
      editorFileWatcher.stop();
    }
  });
}

/**
 * Update watched file list (open tabs).
 */
async function handleEditorSetWatchedFiles(
  _event: IpcMainInvokeEvent,
  filePaths: string[]
): Promise<IpcResult<void>> {
  return wrapHandler('setWatchedFiles', async () => {
    if (!activeProjectRoot) throw new Error('Editor not initialized');
    editorFileWatcher.setWatchedFiles(Array.isArray(filePaths) ? filePaths : []);
  });
}

/**
 * Update watched directory list (shallow, depth=0).
 */
async function handleEditorSetWatchedDirs(
  _event: IpcMainInvokeEvent,
  dirPaths: string[]
): Promise<IpcResult<void>> {
  return wrapHandler('setWatchedDirs', async () => {
    if (!activeProjectRoot) throw new Error('Editor not initialized');
    editorFileWatcher.setWatchedDirs(Array.isArray(dirPaths) ? dirPaths : []);
  });
}

// =============================================================================
// Registration
// =============================================================================

export function initializeEditorHandlers(): void {
  // No external dependencies needed — service created at module level
}

/**
 * Set main window reference for forwarding watcher events.
 * Called from main/index.ts after window creation.
 */
export function setEditorMainWindow(win: BrowserWindow | null): void {
  mainWindowRef = win;
}

export function registerEditorHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(EDITOR_OPEN, handleEditorOpen);
  ipcMain.handle(EDITOR_CLOSE, handleEditorClose);
  ipcMain.handle(EDITOR_READ_DIR, handleEditorReadDir);
  ipcMain.handle(EDITOR_READ_FILE, handleEditorReadFile);
  ipcMain.handle(EDITOR_WRITE_FILE, handleEditorWriteFile);
  ipcMain.handle(EDITOR_CREATE_FILE, handleEditorCreateFile);
  ipcMain.handle(EDITOR_CREATE_DIR, handleEditorCreateDir);
  ipcMain.handle(EDITOR_DELETE_FILE, handleEditorDeleteFile);
  ipcMain.handle(EDITOR_MOVE_FILE, handleEditorMoveFile);
  ipcMain.handle(EDITOR_RENAME_FILE, handleEditorRenameFile);
  ipcMain.handle(EDITOR_SEARCH_IN_FILES, handleEditorSearchInFiles);
  ipcMain.handle(EDITOR_LIST_FILES, handleEditorListFiles);
  ipcMain.handle(EDITOR_READ_BINARY_PREVIEW, handleEditorReadBinaryPreview);
  ipcMain.handle(EDITOR_GIT_STATUS, handleEditorGitStatus);
  ipcMain.handle(EDITOR_WATCH_DIR, handleEditorWatchDir);
  ipcMain.handle(EDITOR_SET_WATCHED_FILES, handleEditorSetWatchedFiles);
  ipcMain.handle(EDITOR_SET_WATCHED_DIRS, handleEditorSetWatchedDirs);
  ipcMain.handle(PROJECT_LIST_FILES, handleProjectListFiles);
}

export function removeEditorHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler(EDITOR_OPEN);
  ipcMain.removeHandler(EDITOR_CLOSE);
  ipcMain.removeHandler(EDITOR_READ_DIR);
  ipcMain.removeHandler(EDITOR_READ_FILE);
  ipcMain.removeHandler(EDITOR_WRITE_FILE);
  ipcMain.removeHandler(EDITOR_CREATE_FILE);
  ipcMain.removeHandler(EDITOR_CREATE_DIR);
  ipcMain.removeHandler(EDITOR_DELETE_FILE);
  ipcMain.removeHandler(EDITOR_MOVE_FILE);
  ipcMain.removeHandler(EDITOR_RENAME_FILE);
  ipcMain.removeHandler(EDITOR_SEARCH_IN_FILES);
  ipcMain.removeHandler(EDITOR_LIST_FILES);
  ipcMain.removeHandler(EDITOR_READ_BINARY_PREVIEW);
  ipcMain.removeHandler(EDITOR_GIT_STATUS);
  ipcMain.removeHandler(EDITOR_WATCH_DIR);
  ipcMain.removeHandler(EDITOR_SET_WATCHED_FILES);
  ipcMain.removeHandler(EDITOR_SET_WATCHED_DIRS);
  ipcMain.removeHandler(PROJECT_LIST_FILES);
}

/**
 * Reset editor state (called from mainWindow.on('closed')).
 * Prevents state leak when Cmd+Q on macOS.
 */
export function cleanupEditorState(): void {
  editorFileWatcher.stop();
  gitStatusService.destroy();
  activeProjectRoot = null;
}
