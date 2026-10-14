import { CUSTOM_TEAM_TEMPLATE_ROUTES } from '../../contracts';

import type { CustomTeamTemplatesApi } from '../../contracts';

const REQUEST_TIMEOUT_MS = 10_000;

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
  const request = async <T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
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

  return {
    preparePreview: (payload) =>
      request(CUSTOM_TEAM_TEMPLATE_ROUTES.preparePreview, 'POST', payload),
    saveTemplate: (payload) => request(CUSTOM_TEAM_TEMPLATE_ROUTES.saveTemplate, 'POST', payload),
    recheckSave: (payload) => request(CUSTOM_TEAM_TEMPLATE_ROUTES.recheckSave, 'POST', payload),
    listTemplates: () => request(CUSTOM_TEAM_TEMPLATE_ROUTES.listTemplates, 'GET'),
  };
}
