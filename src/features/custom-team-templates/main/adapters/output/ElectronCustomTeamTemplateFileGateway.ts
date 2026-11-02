import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { BrowserWindow, dialog } from 'electron';

import type {
  CustomTeamTemplateFileGateway,
  CustomTeamTemplateFileReadResult,
} from './CustomTeamTemplateFileGateway';
import type { FileHandle } from 'node:fs/promises';

const IMPORT_DIALOG_TITLE = 'Import Team Template';
const EXPORT_DIALOG_TITLE = 'Export Team Template';
const TEMPLATE_JSON_FILTERS: Electron.FileFilter[] = [
  { name: 'Team Template JSON', extensions: ['json'] },
];

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

/** The subset of `FileHandle` the bounded UTF-8 reader needs. */
export interface BoundedReadableFileHandle {
  stat(): Promise<{ isFile(): boolean; size: number }>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ): Promise<{ bytesRead: number }>;
}

/**
 * Reads one already-open file with a hard byte ceiling.
 *
 * The size is inspected first, then at most `size + 1` bytes are read so file
 * growth is observable without an unbounded allocation, then the size is
 * inspected again. Either check detecting a change yields `changedDuringRead`
 * instead of a partial template. Strict UTF-8 decoding rejects invalid bytes,
 * and a leading BOM is discarded.
 */
export async function readBoundedUtf8FromFileHandle(
  handle: BoundedReadableFileHandle,
  maxBytes: number
): Promise<CustomTeamTemplateFileReadResult> {
  const before = await handle.stat();
  if (!before.isFile()) {
    return { status: 'notAFile' };
  }
  if (before.size > maxBytes) {
    return { status: 'tooLarge', maxBytes };
  }

  const readLength = Math.min(before.size + 1, maxBytes + 1);
  const buffer = Buffer.alloc(readLength);
  const { bytesRead } = await handle.read(buffer, 0, readLength, 0);
  if (bytesRead > maxBytes) {
    return { status: 'tooLarge', maxBytes };
  }

  const after = await handle.stat();
  if (bytesRead > before.size || after.size !== before.size) {
    return { status: 'changedDuringRead' };
  }

  const bytes = buffer.subarray(0, bytesRead);
  const withoutBom =
    bytes.length >= UTF8_BOM.length &&
    bytes[0] === UTF8_BOM[0] &&
    bytes[1] === UTF8_BOM[1] &&
    bytes[2] === UTF8_BOM[2]
      ? bytes.subarray(UTF8_BOM.length)
      : bytes;

  try {
    return { status: 'ok', contents: new TextDecoder('utf-8', { fatal: true }).decode(withoutBom) };
  } catch {
    return { status: 'invalidEncoding' };
  }
}

/**
 * Electron implementation of the trusted file boundary.
 *
 * Dialogs are parented to the focused window when one exists, which keeps the
 * sheet modal on macOS and prevents an orphaned dialog on Windows/Linux. Every
 * failure is reported as a typed outcome or a rejected promise; no path is ever
 * returned to the caller for display or reuse.
 */
export class ElectronCustomTeamTemplateFileGateway implements CustomTeamTemplateFileGateway {
  async pickImportFile(): Promise<string | null> {
    const options: Electron.OpenDialogOptions = {
      title: IMPORT_DIALOG_TITLE,
      buttonLabel: 'Import',
      properties: ['openFile'],
      filters: TEMPLATE_JSON_FILTERS,
    };
    const focusedWindow = BrowserWindow.getFocusedWindow();
    const result = focusedWindow
      ? await dialog.showOpenDialog(focusedWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled) {
      return null;
    }
    return result.filePaths[0] ?? null;
  }

  async readUtf8File(
    filePath: string,
    maxBytes: number
  ): Promise<CustomTeamTemplateFileReadResult> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(filePath, 'r');
      return await readBoundedUtf8FromFileHandle(handle, maxBytes);
    } catch {
      return { status: 'readFailed' };
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // The read outcome is already decided; a close failure cannot change it.
        }
      }
    }
  }

  async pickExportDestination(suggestedFileName: string): Promise<string | null> {
    const options: Electron.SaveDialogOptions = {
      title: EXPORT_DIALOG_TITLE,
      buttonLabel: 'Export',
      defaultPath: suggestedFileName,
      filters: TEMPLATE_JSON_FILTERS,
    };
    const focusedWindow = BrowserWindow.getFocusedWindow();
    const result = focusedWindow
      ? await dialog.showSaveDialog(focusedWindow, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled) {
      return null;
    }
    return result.filePath ?? null;
  }

  async writeFileAtomically(filePath: string, contents: string): Promise<void> {
    const directory = path.dirname(filePath);
    const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, filePath);
    } catch (error) {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // Best effort cleanup; the original failure is what matters.
        }
      }
      try {
        await unlink(temporaryPath);
      } catch {
        // The temporary file may never have been created.
      }
      throw error;
    }
  }
}
