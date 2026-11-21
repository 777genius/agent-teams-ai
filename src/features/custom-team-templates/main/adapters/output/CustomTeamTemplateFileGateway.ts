/**
 * Trusted main-process file boundary for portable template import/export.
 *
 * File paths are an implementation detail of this port: they are chosen by a
 * native dialog, used immediately by the same main-process caller, and never
 * returned to the renderer. The renderer therefore cannot name, guess or
 * traverse to a filesystem location, and no IPC contract accepts a path.
 *
 * Implementations must bound every read, reject directory picks, and treat a
 * file that changes between the size check and the read as a failure rather
 * than returning a partially read template.
 */

export type CustomTeamTemplateFileReadResult =
  | { status: 'ok'; contents: string }
  | { status: 'tooLarge'; maxBytes: number }
  | { status: 'changedDuringRead' }
  | { status: 'notAFile' }
  | { status: 'invalidEncoding' }
  | { status: 'readFailed' };

export interface CustomTeamTemplateFileGateway {
  /** Opens the native import picker. `null` means the user cancelled. */
  pickImportFile(): Promise<string | null>;
  /**
   * Reads one file as strict UTF-8, refusing anything larger than `maxBytes`
   * before content is loaded. A UTF-8 BOM is discarded.
   */
  readUtf8File(filePath: string, maxBytes: number): Promise<CustomTeamTemplateFileReadResult>;
  /**
   * Opens the native save dialog with a suggested basename. `null` means the
   * user cancelled.
   */
  pickExportDestination(suggestedFileName: string): Promise<string | null>;
  /**
   * Writes UTF-8 content without ever leaving a partially written final file:
   * a sibling temporary file is written and flushed first, then renamed into
   * place.
   */
  writeFileAtomically(filePath: string, contents: string): Promise<void>;
}
