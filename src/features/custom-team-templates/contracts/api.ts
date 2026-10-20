import type {
  ConfirmCustomTeamTemplateSaveRequest,
  ConfirmCustomTeamTemplateSaveResult,
  ListCustomTeamTemplatesResult,
  PrepareCustomTeamTemplatePreviewRequest,
  PrepareCustomTeamTemplatePreviewResult,
  RecheckCustomTeamTemplateSaveRequest,
  RecheckCustomTeamTemplateSaveResult,
} from './operations';

/**
 * Renderer-facing custom-team-templates API.
 *
 * The renderer calls exactly four operations, and every one of them answers
 * with a closed typed outcome instead of throwing: prepare a preview, confirm
 * (save) it, list the library, and re-check an unresolved save. The source team
 * identity, the reviewed content, the stable template id and the content digest
 * never travel from the renderer: only the preview token, an optional
 * name/description edit, and the re-check token do.
 *
 * Both the preload bridge and the browser HTTP adapter implement this type, so
 * a renderer caller cannot tell IPC and HTTP apart.
 */
export interface CustomTeamTemplatesApi {
  preparePreview(
    request: PrepareCustomTeamTemplatePreviewRequest
  ): Promise<PrepareCustomTeamTemplatePreviewResult>;
  saveTemplate(
    request: ConfirmCustomTeamTemplateSaveRequest
  ): Promise<ConfirmCustomTeamTemplateSaveResult>;
  recheckSave(
    request: RecheckCustomTeamTemplateSaveRequest
  ): Promise<RecheckCustomTeamTemplateSaveResult>;
  listTemplates(): Promise<ListCustomTeamTemplatesResult>;
}
