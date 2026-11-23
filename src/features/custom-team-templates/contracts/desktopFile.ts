import type { ImportCustomTeamTemplateResult } from './operations';

/**
 * Desktop-only transport addresses for native file import/export.
 *
 * These are deliberately separate from `CUSTOM_TEAM_TEMPLATE_CHANNELS`: the
 * data operations are shared by IPC and HTTP, while native dialogs and
 * filesystem access exist only in the Electron main process. Keeping the
 * addresses apart lets the browser adapter omit them without pretending to
 * implement a file picker it cannot provide.
 */
export const CUSTOM_TEAM_TEMPLATE_FILE_CHANNELS = {
  importFromFile: 'custom-team-templates:import-from-file',
  exportToFile: 'custom-team-templates:export-to-file',
} as const;

export type CustomTeamTemplateFileOperation = keyof typeof CUSTOM_TEAM_TEMPLATE_FILE_CHANNELS;

/**
 * Hard ceiling for one imported portable-template file, in bytes.
 *
 * The ceiling is derived from the established domain limits
 * (`core/domain/templateLimits.ts`) and the worst-case JSON representation of a
 * valid portable template:
 *
 * - `teamPrompt`: 200_000 code units.
 * - 100 members x (`name` 128 + `role` 128 + `workflow` 200_000 code units).
 * - `name`: 128 code units, `description`: 2_000 code units.
 * - `schemaVersion`: a small integer, `format`: a 27-character literal.
 *
 * A JSON string escape is at most 6 ASCII bytes per UTF-16 code unit
 * (`\u00XX`), which dominates both raw UTF-8 (at most 3 bytes per BMP code
 * unit) and surrogate-pair encoding (4 bytes per 2 code units). Counting every
 * field at that worst case gives:
 *
 *   teamPrompt        200_000 x 6            =   1_200_000
 *   members           100 x 200_256 x 6      = 120_153_600
 *   name              128 x 6                =         768
 *   description       2_000 x 6              =      12_000
 *   envelope + keys + JSON punctuation       =       2_000
 *   ----------------------------------------------------------
 *   worst-case total                         ~= 121_368_368 bytes (~115.7 MiB)
 *
 * 128 MiB (134_217_728 bytes) covers that worst case with ~10% headroom and is
 * the same documented ceiling used by the HTTP routes. The size is checked from
 * the opened file descriptor before any content is read into memory.
 */
export const CUSTOM_TEAM_TEMPLATE_MAX_IMPORT_FILE_BYTES = 128 * 1024 * 1024;

/**
 * Outcome of a native-file import request.
 *
 * File-level outcomes (`cancelled`, `invalidJson`, `fileTooLarge`, ...) are
 * distinct from domain outcomes so the caller can tell a user mistake from a
 * storage or domain failure. `nameConflict` carries the sanitized portable
 * content so a rename can be retried through the existing import use case
 * without re-reading the file and without touching the existing template.
 */
export type ImportCustomTeamTemplateFromFileResult =
  | ImportCustomTeamTemplateResult
  | { status: 'cancelled' }
  | { status: 'invalidJson' }
  | { status: 'invalidEncoding' }
  | { status: 'fileTooLarge'; maxBytes: number }
  | { status: 'fileChanged' }
  | { status: 'fileReadFailed' }
  | { status: 'filePickerFailed' };

export interface ExportCustomTeamTemplateToFileRequest {
  /**
   * Saved custom template to export. This is the only value the renderer may
   * supply: the destination directory is chosen by the native save dialog in
   * the main process and never travels across IPC.
   */
  templateId: string;
}

/**
 * Outcome of a native-file export request.
 *
 * `exported` intentionally carries no file path: the renderer never learns
 * where the user saved the file, and the selected path cannot be echoed back
 * into another privileged operation.
 */
export type ExportCustomTeamTemplateToFileResult =
  | { status: 'exported' }
  | { status: 'cancelled' }
  | { status: 'invalidRequest' }
  | { status: 'notFound'; templateId: string }
  | { status: 'unreadableRecord'; templateId: string }
  | { status: 'storageUnavailable' }
  | { status: 'filePickerFailed' }
  | { status: 'fileWriteFailed' };

/**
 * Desktop-only native file API.
 *
 * The Electron preload bridge exposes this as
 * `window.electronAPI.customTeamTemplates.desktopFile`; the browser HTTP
 * adapter deliberately leaves it undefined instead of fabricating a file
 * dialog. Neither method accepts a filesystem path.
 */
export interface CustomTeamTemplatesDesktopFileApi {
  importFromFile(): Promise<ImportCustomTeamTemplateFromFileResult>;
  exportToFile(
    request: ExportCustomTeamTemplateToFileRequest
  ): Promise<ExportCustomTeamTemplateToFileResult>;
}
