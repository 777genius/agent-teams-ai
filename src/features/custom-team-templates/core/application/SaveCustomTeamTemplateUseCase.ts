import { CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION } from '@features/custom-team-templates/contracts';

import { validateTemplateName } from '../domain/templateNamePolicy';
import {
  buildTemplatePreviewContent,
  validateTemplateDescription,
} from '../domain/templatePreviewPolicy';

import { CustomTeamTemplateStorageInterruptedError } from './CustomTeamTemplateStorageInterruptedError';
import { checkStoredTemplate } from './reconcileCustomTeamTemplateWrite';
import { waitForStorageSettlement } from './waitForStorageSettlement';

import type {
  CustomTeamTemplatePreviewState,
  InMemoryCustomTeamTemplatePreviewStore,
} from './InMemoryCustomTeamTemplatePreviewStore';
import type {
  CustomTeamTemplateHasher,
  CustomTeamTemplateSnapshotReader,
  CustomTeamTemplateStorageGateway,
} from './ports';
import type { CustomTeamTemplateWriteIdentity } from './reconcileCustomTeamTemplateWrite';
import type {
  ConfirmCustomTeamTemplateSaveResult,
  CreateCustomTeamTemplateRecordRequest,
  CreateCustomTeamTemplateRecordResult,
  CustomTeamTemplatePreviewContent,
  CustomTeamTemplateValidationIssue,
} from '@features/custom-team-templates/contracts';

/**
 * Attempts allowed for one confirmed save.
 *
 * Two attempts is deliberately small: the worker already absorbs write-lock
 * contention with its own five-second busy timeout, so an immediate second
 * attempt only covers a lock that was released in between. Nothing here retries
 * indefinitely, and every attempt reuses the exact same request, which makes
 * the create idempotent by template id.
 */
const TEMPLATE_CREATE_MAX_ATTEMPTS = 2;

export interface SaveCustomTeamTemplateUseCaseDeps {
  /** Null when the SQLite worker bundle is unavailable in this environment. */
  gateway: CustomTeamTemplateStorageGateway | null;
  reader: CustomTeamTemplateSnapshotReader;
  hasher: CustomTeamTemplateHasher;
  previewStore: InMemoryCustomTeamTemplatePreviewStore;
}

/** What one create attempt means for the caller. */
interface WriteDecision {
  /** True when the identical request may be attempted again. */
  retry: boolean;
  result: ConfirmCustomTeamTemplateSaveResult;
}

type ConfirmedProjection =
  | { status: 'confirmed'; preview: CustomTeamTemplatePreviewContent; contentHash: string }
  | { status: 'rejected'; result: ConfirmCustomTeamTemplateSaveResult };

interface ParsedConfirmRequest {
  previewToken: string | null;
  /** Raw, unvalidated name override; `undefined` keeps the reviewed name. */
  name: unknown;
  /** Raw, unvalidated description override; `undefined` keeps the reviewed text. */
  description: unknown;
}

/**
 * Splits the confirmation into its opaque reference and the two optional edits.
 *
 * Only the preview token and the display name/description are accepted from the
 * caller. Anything else an envelope happens to carry (a template id, prompt,
 * member list, digest or timestamp) is ignored rather than read, so a caller
 * cannot assert authoritative content.
 */
function parseConfirmRequest(payload: unknown): ParsedConfirmRequest | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }
  const candidate = payload as { previewToken?: unknown; name?: unknown; description?: unknown };
  const rawToken = candidate.previewToken;
  return {
    previewToken: typeof rawToken === 'string' && rawToken.trim() ? rawToken.trim() : null,
    name: candidate.name,
    description: candidate.description,
  };
}

/**
 * Confirms a reviewed preview and writes the template.
 *
 * The request carries the opaque token plus optional name/description edits:
 * the source team, the reviewed prompt and members, the stable template id and
 * the digest all come from the retained preview state and trusted main-process
 * derivation, so a caller can neither persist content it never reviewed nor
 * rebind the preview to another team. Name and description are validated here
 * exactly like prepare-time input, and only they may change between preview and
 * confirm.
 *
 * Saving is blocked whenever the reviewed projection cannot be reproduced from
 * the current authoritative configuration, and the write itself is one
 * idempotent create keyed by a stable template id, so neither a retry nor a
 * concurrent second confirm can duplicate or overwrite a stored record.
 */
export class SaveCustomTeamTemplateUseCase {
  constructor(private readonly deps: SaveCustomTeamTemplateUseCaseDeps) {}

  async execute(payload: unknown): Promise<ConfirmCustomTeamTemplateSaveResult> {
    const parsed = parseConfirmRequest(payload);
    if (!parsed?.previewToken) {
      return validationFailed([{ code: 'previewTokenRequired', field: 'previewToken' }]);
    }

    const resolution = this.deps.previewStore.resolve(parsed.previewToken);
    if (resolution.status === 'unknown') {
      return validationFailed([{ code: 'previewTokenUnknown', field: 'previewToken' }]);
    }
    if (resolution.status === 'expired') {
      return validationFailed([{ code: 'previewTokenExpired', field: 'previewToken' }]);
    }
    const state = resolution.state;

    // Display edits are validated before the source is re-read, so obvious input
    // problems are reported without a filesystem access.
    const resolved = this.resolveConfirmedIdentity(parsed, state);
    if (resolved.status === 'rejected') {
      return resolved.result;
    }

    const confirmed = await this.confirmProjection(state);
    if (confirmed.status === 'rejected') {
      return confirmed.result;
    }

    const gateway = this.deps.gateway;
    if (!gateway) {
      // No write was attempted, so the token stays valid for a later retry.
      return { status: 'storageUnavailable' };
    }

    // The stable id is derived from the confirmed identity and the reviewed
    // content, never from the request. Recording it on the retained operation is
    // what lets a later re-check reconcile this exact write rather than a new one.
    const identity = {
      templateId: this.deps.hasher.deriveTemplateId({
        contentHash: confirmed.contentHash,
        nameKey: resolved.nameKey,
        description: resolved.description ?? null,
      }),
      name: resolved.name,
      nameKey: resolved.nameKey,
      ...(resolved.description === undefined ? {} : { description: resolved.description }),
    };

    // The preview can expire or be evicted while the authoritative snapshot is
    // being read, so confirmation is checked rather than assumed: a token that
    // no longer retains its preview must never produce a database record.
    const confirmation = this.deps.previewStore.confirmSave(state.token, identity);
    if (confirmation.status === 'unavailable') {
      return { status: 'stalePreview', sourceTeamName: state.sourceTeamName };
    }
    if (confirmation.status === 'identityMismatch') {
      // A write for this token may already have been dispatched under its
      // recorded identity, so the token can never be rebound to a different
      // template id, name key or description. The original operation stays
      // reconcilable through re-check; saving the new identity requires a
      // fresh preview.
      return validationFailed([{ code: 'previewTokenUnknown', field: 'previewToken' }]);
    }
    // `recorded` (first confirmation) and `alreadyRecorded` (exact-identity
    // retry) both proceed with the identical, idempotent create request.

    const request: CreateCustomTeamTemplateRecordRequest = {
      template: {
        templateId: identity.templateId,
        name: identity.name,
        ...(identity.description === undefined ? {} : { description: identity.description }),
        schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
        teamPrompt: confirmed.preview.teamPrompt,
        members: confirmed.preview.members,
      },
      contentHash: confirmed.contentHash,
    };
    return this.createWithRecovery(gateway, request);
  }

  /**
   * Resolves the display identity the user confirmed.
   *
   * An omitted field keeps the value the preview reviewed; a supplied one is
   * validated with the same policy the prepare step uses, so an edited name can
   * never bypass the uniqueness key or the length and character rules.
   */
  private resolveConfirmedIdentity(
    parsed: ParsedConfirmRequest,
    state: CustomTeamTemplatePreviewState
  ):
    | { status: 'resolved'; name: string; nameKey: string; description?: string }
    | { status: 'rejected'; result: ConfirmCustomTeamTemplateSaveResult } {
    const nameValidation = parsed.name === undefined ? null : validateTemplateName(parsed.name);
    if (nameValidation && !nameValidation.valid) {
      return { status: 'rejected', result: validationFailed(nameValidation.issues) };
    }

    // A non-string description is treated as absent, exactly like prepare: it is
    // optional text and the closed issue union has no "must be a string" code.
    const override = typeof parsed.description === 'string' ? parsed.description : undefined;
    const description = override === undefined ? state.description : override;
    const issues = validateTemplateDescription(description);
    if (issues.length > 0) {
      return { status: 'rejected', result: validationFailed(issues) };
    }
    const trimmed = description?.trim();

    return {
      status: 'resolved',
      name: nameValidation ? nameValidation.value : state.name,
      nameKey: nameValidation ? nameValidation.normalizedKey : state.nameKey,
      ...(trimmed ? { description: trimmed } : {}),
    };
  }

  /**
   * Re-reads the authoritative source and re-applies the allowlist policy.
   *
   * A preview whose projection no longer matches what the user reviewed is
   * stale, and its token is forgotten so it can never save the refreshed data.
   * The comparison is on canonical content, not on a file revision: a change
   * that cannot alter the projection (say, a removed member's model preference)
   * must not force the user to review the same template again.
   */
  private async confirmProjection(
    state: CustomTeamTemplatePreviewState
  ): Promise<ConfirmedProjection> {
    const read = await this.deps.reader.readSnapshot(state.sourceTeamName);
    if (read.status === 'sourceUnavailable') {
      return {
        status: 'rejected',
        result: { status: 'sourceUnavailable', sourceTeamName: state.sourceTeamName },
      };
    }
    if (read.status === 'configurationChanged') {
      return { status: 'rejected', result: this.stale(state) };
    }

    const rebuilt = buildTemplatePreviewContent({
      snapshot: read.snapshot,
      name: state.name,
      description: state.description,
    });
    if (rebuilt.status === 'rosterUnreadable') {
      return {
        status: 'rejected',
        result: { status: 'rosterUnreadable', sourceTeamName: rebuilt.sourceTeamName },
      };
    }
    if (rebuilt.status === 'validationFailed') {
      return { status: 'rejected', result: validationFailed(rebuilt.issues) };
    }
    if (rebuilt.preview.canonicalContent !== state.canonicalContent) {
      return { status: 'rejected', result: this.stale(state) };
    }

    const contentHash = this.deps.hasher.hashCanonicalContent(rebuilt.preview.canonicalContent);
    if (contentHash !== state.contentHash) {
      // The stored digest and the freshly computed digest agree only if the
      // reviewed content and the hashing adapter are unchanged; otherwise the
      // confirmed preview can no longer be trusted.
      return { status: 'rejected', result: this.stale(state) };
    }

    return { status: 'confirmed', preview: rebuilt.preview, contentHash };
  }

  private stale(state: CustomTeamTemplatePreviewState): ConfirmCustomTeamTemplateSaveResult {
    this.deps.previewStore.invalidate(state.token);
    return { status: 'stalePreview', sourceTeamName: state.sourceTeamName };
  }

  private async createWithRecovery(
    gateway: CustomTeamTemplateStorageGateway,
    request: CreateCustomTeamTemplateRecordRequest
  ): Promise<ConfirmCustomTeamTemplateSaveResult> {
    const templateId = request.template.templateId;
    for (let attempt = 1; attempt <= TEMPLATE_CREATE_MAX_ATTEMPTS; attempt++) {
      let decision: WriteDecision;
      try {
        decision = mapCreateResult(await gateway.customTeamTemplateCreate(request));
      } catch (error) {
        decision = await this.classifyFailure(gateway, request, error);
      }
      if (!decision.retry || attempt === TEMPLATE_CREATE_MAX_ATTEMPTS) {
        return decision.result;
      }
    }
    return { status: 'unresolvedWriteOutcome', templateId };
  }

  /**
   * Decides what an exception means for the confirmed save.
   *
   * An interruption that never started is safe to retry with the identical
   * request; anything that may have reached the database is reconciled by the
   * stable template id instead of being retried blind, and anything that cannot
   * be verified is reported as unresolved rather than as success or absence.
   */
  private async classifyFailure(
    gateway: CustomTeamTemplateStorageGateway,
    request: CreateCustomTeamTemplateRecordRequest,
    error: unknown
  ): Promise<WriteDecision> {
    if (error instanceof CustomTeamTemplateStorageInterruptedError) {
      // The settlement promise is bounded: a worker whose termination was never
      // confirmed can leave it pending forever, and a save request must always
      // settle within a finite time.
      const settlement = await waitForStorageSettlement(error.settled);
      if (settlement === 'timedOut') {
        // The failed writer never confirmed it stopped, so nothing is retried
        // on that ambiguity: a `not_started` interruption is reported as
        // refused storage and an `unknown` one keeps its honest unresolved
        // outcome. No second write is issued merely because settlement timed
        // out.
        return error.execution === 'not_started'
          ? { retry: false, result: { status: 'storageUnavailable' } }
          : {
              retry: false,
              result: {
                status: 'unresolvedWriteOutcome',
                templateId: request.template.templateId,
              },
            };
      }
      if (error.execution === 'not_started') {
        // Nothing reached the database, and the failed writer has settled, so
        // the retry reaches a live writer; reuse the identical request.
        return { retry: true, result: { status: 'storageUnavailable' } };
      }
    }
    return this.reconcile(gateway, request);
  }

  /**
   * Reconciles an uncertain write by template id, without ever inventing an
   * outcome.
   *
   * The classification (equivalent record, conflicting record, confirmed
   * absence, or still-unreadable) is shared with the re-check use case so a
   * confirmed save and a later re-check can never disagree about the same
   * operation.
   */
  private async reconcile(
    gateway: CustomTeamTemplateStorageGateway,
    request: CreateCustomTeamTemplateRecordRequest
  ): Promise<WriteDecision> {
    const check = await checkStoredTemplate(gateway, toWriteIdentity(request), this.deps.hasher);
    switch (check.status) {
      case 'saved':
        return { retry: false, result: { status: 'alreadySaved', template: check.template } };
      case 'conflict':
        return {
          retry: false,
          result: { status: 'templateIdConflict', templateId: check.templateId },
        };
      case 'absent':
        // Definitive absence while the store is readable: the write did not
        // persist, so one more identical attempt is allowed, and an attempt
        // that runs out is honestly reported as refused storage rather than as
        // an unknown outcome — absence was proven, not left uncertain.
        return {
          retry: true,
          result: { status: 'storageUnavailable' },
        };
      case 'unresolved':
        return {
          retry: false,
          result: { status: 'unresolvedWriteOutcome', templateId: check.templateId },
        };
    }
  }
}

/** The immutable identity a confirmed create request is reconciled against. */
export function toWriteIdentity(
  request: CreateCustomTeamTemplateRecordRequest
): CustomTeamTemplateWriteIdentity {
  return {
    templateId: request.template.templateId,
    name: request.template.name,
    description: request.template.description,
    contentHash: request.contentHash,
  };
}

/**
 * Maps a persistence outcome onto the application contract.
 *
 * A retryable outcome is not an error the user caused, so it keeps the request
 * eligible for one more attempt; when attempts are exhausted the store is
 * reported as unavailable, which is the honest reading of "nothing was
 * persisted".
 */
function mapCreateResult(result: CreateCustomTeamTemplateRecordResult): WriteDecision {
  switch (result.status) {
    case 'created':
      return { retry: false, result: { status: 'created', template: result.template } };
    case 'alreadySaved':
      return { retry: false, result: { status: 'alreadySaved', template: result.template } };
    case 'conflict':
      return result.reason === 'nameTaken'
        ? {
            retry: false,
            result: { status: 'nameConflict', existingTemplateId: result.existingTemplateId },
          }
        : {
            retry: false,
            result: { status: 'templateIdConflict', templateId: result.existingTemplateId },
          };
    case 'existingRecordUnreadable':
      // The stored record may be this save or a conflicting one; neither can be
      // claimed, so the outcome stays unresolved.
      return {
        retry: false,
        result: { status: 'unresolvedWriteOutcome', templateId: result.templateId },
      };
    case 'retryable':
      return { retry: true, result: { status: 'storageUnavailable' } };
  }
}

function validationFailed(
  issues: readonly CustomTeamTemplateValidationIssue[]
): ConfirmCustomTeamTemplateSaveResult {
  return { status: 'validationFailed', issues };
}
