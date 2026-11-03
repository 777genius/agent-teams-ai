import { CUSTOM_TEAM_TEMPLATE_MAX_IMPORT_FILE_BYTES } from '@features/custom-team-templates/contracts';

import {
  buildCustomTeamTemplateFileName,
  serializeCustomTeamTemplatePortableFile,
} from '../../core/domain/portableTemplateFile';

import type {
  ExportCustomTeamTemplateResult,
  ImportCustomTeamTemplateResult,
} from '../../contracts';
import type {
  BrowserFileDownload,
  CustomTeamTemplatesBrowserFileApi,
  ExportCustomTeamTemplateToBrowserFileResult,
  ImportCustomTeamTemplateFromBrowserFileResult,
} from '../../contracts/browserFile';

const UTF8_BOM = [0xef, 0xbb, 0xbf];

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return (
    bytes.length >= UTF8_BOM.length &&
    bytes[0] === UTF8_BOM[0] &&
    bytes[1] === UTF8_BOM[1] &&
    bytes[2] === UTF8_BOM[2]
  );
}

function stripUtf8Bom(bytes: Uint8Array): Uint8Array {
  return hasUtf8Bom(bytes) ? bytes.subarray(UTF8_BOM.length) : bytes;
}

export interface CustomTeamTemplateBrowserFileServiceDeps {
  importTemplate: (payload: unknown) => Promise<ImportCustomTeamTemplateResult>;
  exportTemplate: (payload: unknown) => Promise<ExportCustomTeamTemplateResult>;
  download?: BrowserFileDownload;
  maxImportFileBytes?: number;
}

/**
 * Default browser download implementation.
 *
 * Creates a temporary object URL, triggers a download via an anchor element,
 * removes the anchor, and revokes the object URL to avoid leaks.
 */
export class DefaultBrowserFileDownload implements BrowserFileDownload {
  /**
   * Triggers one download and releases the object URL afterwards.
   *
   * The anchor is always removed, and the URL is revoked on a short delay so the
   * browser has time to consume it. Rejects when the download cannot start, which
   * the caller reports as `downloadFailed`.
   */
  async download(blob: Blob, fileName: string): Promise<void> {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    try {
      anchor.click();
    } finally {
      document.body.removeChild(anchor);
      // Revoke after a short delay so the browser has time to consume the
      // object URL for the download before it is released.
      setTimeout(() => URL.revokeObjectURL(url), 100);
    }
  }
}

/**
 * Browser-specific custom team template file import/export.
 *
 * Mirrors the desktop file workflow (`CustomTeamTemplateDesktopFileService`)
 * using only browser-platform APIs: `File`, `Blob`, `URL`, `TextDecoder` and
 * `document`. No Node.js fs/path, no Electron, and no filesystem paths cross
 * this boundary.
 *
 * The import and export executors are injected so the service stays
 * transport-agnostic: in production they delegate to the composed import/export
 * use cases via the HTTP API adapter, and in tests they can be stubbed to
 * return any typed outcome.
 */
export class CustomTeamTemplateBrowserFileService implements CustomTeamTemplatesBrowserFileApi {
  private readonly maxImportFileBytes: number;
  private readonly download: BrowserFileDownload;
  private readonly importExecutor: (payload: unknown) => Promise<ImportCustomTeamTemplateResult>;
  private readonly exportExecutor: (payload: unknown) => Promise<ExportCustomTeamTemplateResult>;

  constructor(deps: CustomTeamTemplateBrowserFileServiceDeps) {
    this.maxImportFileBytes = deps.maxImportFileBytes ?? CUSTOM_TEAM_TEMPLATE_MAX_IMPORT_FILE_BYTES;
    this.download = deps.download ?? new DefaultBrowserFileDownload();
    this.importExecutor = deps.importTemplate;
    this.exportExecutor = deps.exportTemplate;
  }

  /**
   * Reads one browser `File` and hands the parsed document to the import use case.
   *
   * The size ceiling is enforced before any bytes are read, the payload must be
   * strict UTF-8 (BOM discarded) and valid JSON, and a rejected transport call is
   * reported as `unresolvedWriteOutcome` because the request was already
   * dispatched and may have committed. It never reports a write as definitely
   * failed when it is unknown.
   */
  async importFromFile(file: File): Promise<ImportCustomTeamTemplateFromBrowserFileResult> {
    // Reject oversized files before any content is read into memory.
    if (file.size > this.maxImportFileBytes) {
      return { status: 'fileTooLarge', maxBytes: this.maxImportFileBytes };
    }

    let buffer: ArrayBuffer;
    try {
      buffer = await file.arrayBuffer();
    } catch {
      return { status: 'fileReadFailed' };
    }

    const bytes = new Uint8Array(buffer);
    const withoutBom = stripUtf8Bom(bytes);

    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(withoutBom);
    } catch {
      return { status: 'invalidEncoding' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { status: 'invalidJson' };
    }

    let result: ImportCustomTeamTemplateResult;
    try {
      result = await this.importExecutor({ portable: parsed });
    } catch {
      // The request was already dispatched, so a timeout, network failure or
      // non-2xx response cannot prove the server did not commit the import.
      // Report the write as unresolved instead of a definitive failure so the
      // renderer blocks a second import. The browser never learns the
      // server-assigned id, so it reconciles against an empty id.
      return { status: 'unresolvedWriteOutcome', templateId: '' };
    }
    return result;
  }

  /**
   * Exports one saved template as a portable JSON download.
   *
   * Only the portable fields the export use case returns are serialized, and the
   * filename is derived locally from the template name. Export is read-only, so
   * a failure is never reported as an unresolved write.
   */
  async exportToFile(request: {
    templateId: string;
  }): Promise<ExportCustomTeamTemplateToBrowserFileResult> {
    let exported: ExportCustomTeamTemplateResult;
    try {
      exported = await this.exportExecutor(request);
    } catch {
      // A transport failure is distinct from a domain storageUnavailable
      // outcome. Export is read-only, so it is never an unresolved write.
      return { status: 'transportFailed' };
    }

    if (exported.status !== 'exported') {
      return exported;
    }

    const contents = serializeCustomTeamTemplatePortableFile(exported.portable);
    const blob = new Blob([contents], { type: 'application/json' });
    const fileName = buildCustomTeamTemplateFileName(exported.portable.name);

    try {
      await this.download.download(blob, fileName);
    } catch {
      return { status: 'downloadFailed' };
    }

    return { status: 'exported' };
  }
}
