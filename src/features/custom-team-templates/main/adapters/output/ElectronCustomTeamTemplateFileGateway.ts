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
  /**
   * Snapshot of the open file's metadata.
   *
   * The production adapter requests `{ bigint: true }`, so `size`, `dev`, `ino`,
   * `mtimeNs` and `ctimeNs` are exact bigint values from the filesystem rather
   * than rounded millisecond doubles. `dev`/`ino`/`mtimeNs`/`ctimeNs` are typed
   * as optional so a platform (or a test double) that cannot report one of them
   * degrades that single comparison instead of failing the whole read.
   */
  stat(options: { bigint: true }): Promise<BoundedFileHandleStat>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ): Promise<{ bytesRead: number }>;
}

/** Metadata snapshot used to detect a file that changed while it was read. */
export interface BoundedFileHandleStat {
  isFile(): boolean;
  /** File length in bytes. */
  size: bigint;
  /** Owning device/volume identity, when the platform reports one. */
  dev?: bigint;
  /** Inode/file identity, when the platform reports one. */
  ino?: bigint;
  /** Nanosecond modification time, when the platform reports one. */
  mtimeNs?: bigint;
  /** Nanosecond inode-change time, when the platform reports one. */
  ctimeNs?: bigint;
}

/**
 * Compares one metadata field, skipping it when either snapshot cannot report it.
 *
 * A field that is unavailable on both sides is simply not comparable, so the
 * change detection for it degrades to the remaining fields instead of failing.
 */
function metadataFieldChanged<T>(before: T | undefined, after: T | undefined): boolean {
  if (before === undefined || after === undefined) {
    return false;
  }
  return before !== after;
}

/**
 * Returns true when the two snapshots cannot both describe the same bytes.
 *
 * Identity (`dev`/`ino`) and nanosecond `mtime`/`ctime` are compared in addition
 * to the size, so a same-size rewrite that lands after the first read is still
 * reported. This is best-effort by nature: a rewrite that restores every observed
 * field exactly is indistinguishable from a stable file, so no stronger guarantee
 * than the filesystem's own timestamp resolution is claimed.
 */
function fileChangedBetweenReads(
  before: BoundedFileHandleStat,
  after: BoundedFileHandleStat
): boolean {
  return (
    before.size !== after.size ||
    metadataFieldChanged(before.dev, after.dev) ||
    metadataFieldChanged(before.ino, after.ino) ||
    metadataFieldChanged(before.mtimeNs, after.mtimeNs) ||
    metadataFieldChanged(before.ctimeNs, after.ctimeNs)
  );
}

/**
 * Reads one already-open file with a hard byte ceiling.
 *
 * The size is inspected first, then at most `size + 1` bytes are read so file
 * growth is observable without an unbounded allocation, then the metadata is
 * inspected again. Either check detecting a change yields `changedDuringRead`
 * instead of a partially read template; a read that ends in EOF before the
 * expected length was reached means the file shrank and is reported the same
 * way. Reads loop until the bounded buffer is filled, because one `read` may
 * legitimately return fewer bytes than requested. Strict UTF-8 decoding rejects
 * invalid bytes, and a leading BOM is discarded.
 */
export async function readBoundedUtf8FromFileHandle(
  handle: BoundedReadableFileHandle,
  maxBytes: number
): Promise<CustomTeamTemplateFileReadResult> {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile()) {
    return { status: 'notAFile' };
  }
  const maxBytesBigInt = BigInt(maxBytes);
  if (before.size > maxBytesBigInt) {
    return { status: 'tooLarge', maxBytes };
  }

  // `before.size` is already known to fit the ceiling, so it is safe to narrow
  // it to a number here. The extra byte is the existing growth-detection byte.
  const expectedLength = Number(before.size);
  const readLength = expectedLength + 1;
  const buffer = Buffer.alloc(readLength);

  let bytesReadTotal = 0;
  while (bytesReadTotal < readLength) {
    const { bytesRead } = await handle.read(
      buffer,
      bytesReadTotal,
      readLength - bytesReadTotal,
      bytesReadTotal
    );
    if (bytesRead === 0) {
      break;
    }
    bytesReadTotal += bytesRead;
  }

  if (bytesReadTotal > maxBytes) {
    return { status: 'tooLarge', maxBytes };
  }

  const after = await handle.stat({ bigint: true });
  if (bytesReadTotal !== expectedLength || fileChangedBetweenReads(before, after)) {
    return { status: 'changedDuringRead' };
  }

  const bytes = buffer.subarray(0, bytesReadTotal);
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
  /**
   * Opens the JSON-filtered native import picker.
   *
   * Resolves `null` when the user cancels. The selected path is returned only to
   * the trusted main-process caller and is never sent to the renderer.
   */
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

  /**
   * Opens the native save dialog with the derived safe basename.
   *
   * Resolves `null` when the user cancels; otherwise the chosen destination is
   * used immediately by this process and is never echoed to the renderer.
   */
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

  /**
   * Writes UTF-8 content without exposing a partially written destination.
   *
   * A sibling temporary file is created exclusively (`wx`, mode 0600), flushed
   * with `sync`, closed, and only then renamed over the target. Any failure
   * removes the temporary file and rethrows, so the previous file (if any) is
   * left untouched and no `.tmp` sibling survives.
   */
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
