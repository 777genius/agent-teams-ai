import { findTemplateNameConflict, validateTemplateName } from '../domain/templateNamePolicy';
import {
  buildTemplatePreviewContent,
  validateTemplateDescription,
} from '../domain/templatePreviewPolicy';

import type { InMemoryCustomTeamTemplatePreviewStore } from './InMemoryCustomTeamTemplatePreviewStore';
import type {
  CustomTeamTemplateHasher,
  CustomTeamTemplateSnapshotReader,
  CustomTeamTemplateStorageGateway,
} from './ports';
import type {
  CustomTeamTemplateValidationIssue,
  PrepareCustomTeamTemplatePreviewResult,
} from '@features/custom-team-templates/contracts';

export interface PrepareCustomTemplatePreviewUseCaseDeps {
  /** Null when the SQLite worker bundle is unavailable in this environment. */
  gateway: CustomTeamTemplateStorageGateway | null;
  reader: CustomTeamTemplateSnapshotReader;
  hasher: CustomTeamTemplateHasher;
  previewStore: InMemoryCustomTeamTemplatePreviewStore;
}

interface ParsedPrepareRequest {
  sourceTeamName: string;
  name: unknown;
  description: unknown;
}

function parsePrepareRequest(payload: unknown): ParsedPrepareRequest | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }
  const candidate = payload as { sourceTeamName?: unknown; name?: unknown; description?: unknown };
  const sourceTeamName =
    typeof candidate.sourceTeamName === 'string' ? candidate.sourceTeamName.trim() : '';
  if (!sourceTeamName) {
    return null;
  }
  return { sourceTeamName, name: candidate.name, description: candidate.description };
}

/**
 * Builds the preview a user reviews before saving a template.
 *
 * The renderer never supplies authoritative member data, prompt content,
 * timestamps, the template id or a content digest: everything is read from the
 * saved configuration of the source team and retained behind an opaque token.
 *
 * Ordering is deliberate. Obvious input problems are reported before any
 * filesystem access, then the source snapshot is read, then the allowlisted
 * projection is built. The library is read last (it is a read, never a write)
 * so a name conflict is reported before the user confirms, while a library that
 * cannot be read fails closed instead of issuing a preview that could not be
 * saved.
 */
export class PrepareCustomTemplatePreviewUseCase {
  constructor(private readonly deps: PrepareCustomTemplatePreviewUseCaseDeps) {}

  async execute(payload: unknown): Promise<PrepareCustomTeamTemplatePreviewResult> {
    const request = parsePrepareRequest(payload);
    if (!request) {
      return validationFailed([{ code: 'sourceTeamNameInvalid', field: 'sourceTeamName' }]);
    }

    const nameValidation = validateTemplateName(request.name);
    // A non-string description is treated as absent: it is optional text and
    // the closed issue union has no "must be a string" code for it. Transport
    // type enforcement belongs to the Phase 3 adapter.
    const description = typeof request.description === 'string' ? request.description : undefined;
    const descriptionIssues = validateTemplateDescription(description);
    if (!nameValidation.valid || descriptionIssues.length > 0) {
      return validationFailed([
        ...(nameValidation.valid ? [] : nameValidation.issues),
        ...descriptionIssues,
      ]);
    }

    const read = await this.deps.reader.readSnapshot(request.sourceTeamName);
    if (read.status === 'sourceUnavailable') {
      return { status: 'sourceUnavailable', sourceTeamName: request.sourceTeamName };
    }
    if (read.status === 'configurationChanged') {
      // The snapshot cannot be attributed to one consistent state, and the
      // prepare contract has no transient-race status, so the source is
      // reported unavailable and the caller retries from a fresh start.
      return { status: 'sourceUnavailable', sourceTeamName: read.sourceTeamName };
    }

    const preview = buildTemplatePreviewContent({
      snapshot: read.snapshot,
      name: nameValidation.value,
      description,
    });
    if (preview.status === 'rosterUnreadable') {
      return { status: 'rosterUnreadable', sourceTeamName: preview.sourceTeamName };
    }
    if (preview.status === 'validationFailed') {
      return validationFailed(preview.issues);
    }

    const conflict = await this.findNameConflict(preview.preview.name);
    if (conflict === 'unavailable') {
      return { status: 'storageUnavailable' };
    }
    if (conflict) {
      return { status: 'nameConflict', existingTemplateId: conflict.templateId };
    }

    const contentHash = this.deps.hasher.hashCanonicalContent(preview.preview.canonicalContent);
    const state = this.deps.previewStore.issue({
      sourceTeamName: read.snapshot.sourceTeamName,
      templateId: this.deps.hasher.deriveTemplateId({
        contentHash,
        nameKey: nameValidation.normalizedKey,
        description: preview.preview.description ?? null,
      }),
      name: preview.preview.name,
      nameKey: nameValidation.normalizedKey,
      ...(preview.preview.description ? { description: preview.preview.description } : {}),
      canonicalContent: preview.preview.canonicalContent,
      contentHash,
    });

    return {
      status: 'previewReady',
      preview: { ...preview.preview, previewToken: state.token },
    };
  }

  /**
   * Reports a case-insensitive name conflict, or `unavailable` when the library
   * cannot be read. Unreadable stored records make this check inconclusive
   * rather than negative: the definitive check still runs inside the atomic
   * create, which reports `nameTaken`.
   */
  private async findNameConflict(
    name: string
  ): Promise<{ templateId: string } | null | 'unavailable'> {
    const gateway = this.deps.gateway;
    if (!gateway) {
      return 'unavailable';
    }
    try {
      const listed = await gateway.customTeamTemplateList();
      return findTemplateNameConflict(name, listed.templates);
    } catch {
      return 'unavailable';
    }
  }
}

function validationFailed(
  issues: readonly CustomTeamTemplateValidationIssue[]
): PrepareCustomTeamTemplatePreviewResult {
  return { status: 'validationFailed', issues };
}
