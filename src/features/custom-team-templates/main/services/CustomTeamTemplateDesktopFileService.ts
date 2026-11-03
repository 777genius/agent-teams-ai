import { CUSTOM_TEAM_TEMPLATE_MAX_IMPORT_FILE_BYTES } from '@features/custom-team-templates/contracts';

import {
  buildCustomTeamTemplateFileName,
  serializeCustomTeamTemplatePortableFile,
} from '../../core/domain/portableTemplateFile';

import type { CustomTeamTemplateFileGateway } from '../adapters/output/CustomTeamTemplateFileGateway';
import type {
  ExportCustomTeamTemplateResult,
  ExportCustomTeamTemplateToFileResult,
  ImportCustomTeamTemplateFromFileResult,
  ImportCustomTeamTemplateResult,
} from '@features/custom-team-templates/contracts';

const MAX_TEMPLATE_ID_LENGTH = 200;

/**
 * Minimal execute-shaped port for the two existing application use cases.
 *
 * The service deliberately depends on the use cases rather than on the storage
 * gateway: file handling must never duplicate validation or persistence logic.
 */
export interface CustomTeamTemplateImportExecutor {
  execute(payload: unknown): Promise<ImportCustomTeamTemplateResult>;
}

export interface CustomTeamTemplateExportExecutor {
  execute(payload: unknown): Promise<ExportCustomTeamTemplateResult>;
}

export interface CustomTeamTemplateDesktopFileServiceDeps {
  importTemplate: CustomTeamTemplateImportExecutor;
  exportTemplate: CustomTeamTemplateExportExecutor;
  files: CustomTeamTemplateFileGateway;
  /** Overridable only for tests; production uses the documented contract ceiling. */
  maxImportFileBytes?: number;
}

function readTemplateId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }
  // Only `templateId` is read. Any other renderer-supplied property, including
  // a would-be filesystem path, is ignored and never reaches the file gateway.
  const templateId = (payload as { templateId?: unknown }).templateId;
  if (typeof templateId !== 'string') {
    return null;
  }
  const trimmed = templateId.trim();
  if (!trimmed || trimmed.length > MAX_TEMPLATE_ID_LENGTH) {
    return null;
  }
  return trimmed;
}

/**
 * Desktop file workflow shared by the import and export IPC handlers.
 *
 * Import: native picker -> bounded strict-UTF-8 read -> JSON parse -> existing
 * import use case. Export: existing export use case -> native save dialog ->
 * deterministic UTF-8 portable JSON written atomically.
 *
 * Cancellation and every file-level failure are typed outcomes rather than
 * thrown errors, so the renderer can distinguish "user cancelled" from "the
 * file or the store failed". No filesystem path crosses the IPC boundary.
 */
export class CustomTeamTemplateDesktopFileService {
  private readonly maxImportFileBytes: number;

  constructor(private readonly deps: CustomTeamTemplateDesktopFileServiceDeps) {
    this.maxImportFileBytes = deps.maxImportFileBytes ?? CUSTOM_TEAM_TEMPLATE_MAX_IMPORT_FILE_BYTES;
  }

  /**
   * Runs the full native import workflow for one user-initiated attempt.
   *
   * Cancellation is a typed `cancelled` outcome, not an error. File-level
   * failures (picker, read, encoding, size, change-during-read, JSON) are
   * reported before the use case is consulted, and the use case keeps ownership
   * of format/version/field/name/storage semantics. A possibly committed write is
   * surfaced as `unresolvedWriteOutcome` and is never retried here.
   */
  async importFromFile(): Promise<ImportCustomTeamTemplateFromFileResult> {
    let filePath: string | null;
    try {
      filePath = await this.deps.files.pickImportFile();
    } catch {
      return { status: 'filePickerFailed' };
    }
    if (filePath === null) {
      return { status: 'cancelled' };
    }

    let read;
    try {
      read = await this.deps.files.readUtf8File(filePath, this.maxImportFileBytes);
    } catch {
      return { status: 'fileReadFailed' };
    }

    switch (read.status) {
      case 'ok':
        break;
      case 'tooLarge':
        return { status: 'fileTooLarge', maxBytes: read.maxBytes };
      case 'changedDuringRead':
        return { status: 'fileChanged' };
      case 'invalidEncoding':
        return { status: 'invalidEncoding' };
      case 'notAFile':
      case 'readFailed':
        return { status: 'fileReadFailed' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(read.contents);
    } catch {
      return { status: 'invalidJson' };
    }

    // The application use case owns format, version, field, limit, duplicate
    // name and storage semantics. The adapter only parsed the bytes. A truly
    // unexpected throw is still reported as a closed outcome so the IPC handler
    // never rejects.
    try {
      return await this.deps.importTemplate.execute({ portable: parsed });
    } catch {
      return { status: 'storageUnavailable' };
    }
  }

  /**
   * Runs the full native export workflow for one saved template id.
   *
   * The renderer supplies only an id: the destination comes from the native save
   * dialog and never crosses IPC. `exported` deliberately carries no path. Export
   * is read-only, so a failure is never an unresolved write.
   */
  async exportToFile(payload: unknown): Promise<ExportCustomTeamTemplateToFileResult> {
    const templateId = readTemplateId(payload);
    if (!templateId) {
      return { status: 'invalidRequest' };
    }

    let exported;
    try {
      exported = await this.deps.exportTemplate.execute({ templateId });
    } catch {
      return { status: 'storageUnavailable' };
    }
    if (exported.status !== 'exported') {
      return exported;
    }

    let destination: string | null;
    try {
      destination = await this.deps.files.pickExportDestination(
        buildCustomTeamTemplateFileName(exported.portable.name)
      );
    } catch {
      return { status: 'filePickerFailed' };
    }
    if (destination === null) {
      return { status: 'cancelled' };
    }

    try {
      await this.deps.files.writeFileAtomically(
        destination,
        serializeCustomTeamTemplatePortableFile(exported.portable)
      );
    } catch {
      return { status: 'fileWriteFailed' };
    }
    return { status: 'exported' };
  }
}
