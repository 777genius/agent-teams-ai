import type { ExportCustomTeamTemplateResult, ImportCustomTeamTemplateResult } from './operations';

/**
 * Outcome of a browser-file import request.
 *
 * File-level outcomes (`cancelled`, `invalidJson`, `invalidEncoding`,
 * `fileTooLarge`, `fileReadFailed`) are distinct from domain outcomes so the
 * caller can tell a user mistake from a storage or domain failure.
 *
 * `nameConflict` carries the sanitized portable content so a rename can be
 * retried through the existing import use case without re-reading the file.
 */
export type ImportCustomTeamTemplateFromBrowserFileResult =
  | ImportCustomTeamTemplateResult
  | { status: 'cancelled' }
  | { status: 'invalidJson' }
  | { status: 'invalidEncoding' }
  | { status: 'fileTooLarge'; maxBytes: number }
  | { status: 'fileReadFailed' }
  | { status: 'transportFailed' };

/**
 * Outcome of a browser-file export request.
 *
 * `exported` means the portable JSON was downloaded successfully. The renderer
 * never learns a filesystem path.
 */
export type ExportCustomTeamTemplateToBrowserFileResult =
  | { status: 'exported' }
  | { status: 'cancelled' }
  | { status: 'downloadFailed' }
  | { status: 'transportFailed' }
  | { status: 'filePickerFailed' }
  | { status: 'fileWriteFailed' }
  | { status: 'invalidRequest' }
  | Extract<ExportCustomTeamTemplateResult, { status: 'notFound' }>
  | Extract<ExportCustomTeamTemplateResult, { status: 'unreadableRecord' }>
  | Extract<ExportCustomTeamTemplateResult, { status: 'storageUnavailable' }>;

/**
 * Injectable browser download boundary.
 *
 * Kept small and injectable so the export service can be tested without
 * touching the DOM or creating real downloads.
 */
export interface BrowserFileDownload {
  /**
   * Initiates a browser download for `blob` under `fileName`.
   *
   * Resolves once the download has been dispatched. Rejects when the browser
   * cannot start the download.
   */
  download(blob: Blob, fileName: string): Promise<void>;
}

export interface CustomTeamTemplatesBrowserFileApi {
  /**
   * Imports a portable team template from a browser `File` object.
   *
   * The file size is checked before any content is read. The content is
   * decoded as strict UTF-8 (BOM discarded), parsed as JSON, and handed to the
   * existing import use case. Cancellation is reported by the caller not
   * invoking this method; `cancelled` is kept for symmetry with the desktop
   * API and for future selection-based flows.
   */
  importFromFile(file: File): Promise<ImportCustomTeamTemplateFromBrowserFileResult>;

  /**
   * Exports a saved custom template as a portable JSON download.
   *
   * Only the portable fields returned by the export use case are serialized.
   * No local IDs, revisions, hashes or timestamps are included.
   */
  exportToFile(request: {
    templateId: string;
  }): Promise<ExportCustomTeamTemplateToBrowserFileResult>;
}
