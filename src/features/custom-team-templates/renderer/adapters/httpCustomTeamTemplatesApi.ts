import { CUSTOM_TEAM_TEMPLATE_ROUTES } from '../../contracts';

import { CustomTeamTemplateBrowserFileService } from './browserCustomTeamTemplatesFile';

import type {
  CustomTeamTemplatesApi,
  ExportCustomTeamTemplateResult,
  ImportCustomTeamTemplateResult,
} from '../../contracts';

const REQUEST_TIMEOUT_MS = 10_000;
// Portable files can reach 128 MiB; uploading/downloading them needs more time
// than a metadata request, while a stalled transfer must still settle.
const FILE_TRANSFER_TIMEOUT_MS = 120_000;

/**
 * Browser-mode counterpart of the preload bridge.
 *
 * The routes return the same typed outcomes over HTTP that IPC returns over
 * channels, so this adapter simply forwards the payload and parses the body.
 * A non-2xx response is a transport failure, not a domain outcome: the typed
 * outcomes (including `storageUnavailable`) always arrive with a 200, so an
 * error here can never be mistaken for an empty library or a completed save.
 */
export function createHttpCustomTeamTemplatesApi(baseUrl: string): CustomTeamTemplatesApi {
  const request = async <T>(
    path: string,
    method: 'GET' | 'POST',
    body?: string,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`custom team templates request failed: HTTP ${response.status}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  };

  const post = async <T>(path: string, payload: unknown): Promise<T> =>
    request(path, 'POST', JSON.stringify(payload));

  const importTemplate = async (payload: unknown): Promise<ImportCustomTeamTemplateResult> => {
    let body: string | undefined;
    try {
      body = JSON.stringify(payload);
    } catch {
      // Deep JSON can parse successfully but fail to serialize. No request has
      // been sent, so this is a definitive input failure, never a possible write.
      return { status: 'unsupportedFormat' };
    }
    return request(
      CUSTOM_TEAM_TEMPLATE_ROUTES.importTemplate,
      'POST',
      body,
      FILE_TRANSFER_TIMEOUT_MS
    );
  };
  const exportTemplate = async (payload: unknown): Promise<ExportCustomTeamTemplateResult> =>
    request(
      CUSTOM_TEAM_TEMPLATE_ROUTES.exportTemplate,
      'POST',
      JSON.stringify(payload),
      FILE_TRANSFER_TIMEOUT_MS
    );

  const browserFile = new CustomTeamTemplateBrowserFileService({
    importTemplate,
    exportTemplate,
  });

  return {
    preparePreview: (payload) => post(CUSTOM_TEAM_TEMPLATE_ROUTES.preparePreview, payload),
    saveTemplate: (payload) => post(CUSTOM_TEAM_TEMPLATE_ROUTES.saveTemplate, payload),
    recheckSave: (payload) => post(CUSTOM_TEAM_TEMPLATE_ROUTES.recheckSave, payload),
    listTemplates: () => request(CUSTOM_TEAM_TEMPLATE_ROUTES.listTemplates, 'GET'),
    updateTemplate: (payload) => post(CUSTOM_TEAM_TEMPLATE_ROUTES.updateTemplate, payload),
    deleteTemplate: (payload) => post(CUSTOM_TEAM_TEMPLATE_ROUTES.deleteTemplate, payload),
    duplicateTemplate: (payload) => post(CUSTOM_TEAM_TEMPLATE_ROUTES.duplicateTemplate, payload),
    copyBuiltinTemplate: (payload) =>
      post(CUSTOM_TEAM_TEMPLATE_ROUTES.copyBuiltinTemplate, payload),
    exportTemplate: (payload) => exportTemplate(payload),
    importTemplate: (payload) => importTemplate(payload),
    browserFile,
  };
}
