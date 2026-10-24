import { EXTENSION_MANAGEMENT_ROUTE } from '../../contracts';

import type { ExtensionManagementAPI } from '../../contracts';

export function createExtensionManagementHttpClient(baseUrl: string): ExtensionManagementAPI {
  async function post<T>(method: keyof ExtensionManagementAPI, request: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}${EXTENSION_MANAGEMENT_ROUTE}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const message =
        body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
          ? body.error
          : `Extension request failed (${response.status}).`;
      throw new Error(message);
    }
    return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
  }
  return {
    capture: (request) => post('capture', request),
    catalog: (request) => post('catalog', request),
    detail: (request) => post('detail', request),
    discoverSkills: (request) => post('discoverSkills', request),
    previewSkill: (request) => post('previewSkill', request),
    environment: (request) => post('environment', request),
    prepare: (request) => post('prepare', request),
    discardPlan: (request) => post('discardPlan', request),
    apply: (request) => post('apply', request),
    operation: (request) => post('operation', request),
    cancel: (request) => post('cancel', request),
  };
}
