import { createHash } from 'node:crypto';

import { createLogger } from '@shared/utils/logger';

import { decodeClaudeCloseDiagnostics, type OpenCodeCatalogDiagnostic } from './decodeClaudeCloseDiagnostics';

/** The existing RPC UUID becomes observable only after original pending admission. */
export function observeCapturedCatalogRequest(requestId: unknown, method: string, params: unknown,
  retain: (value: OpenCodeCatalogDiagnostic) => void = value =>
    createLogger('Host:OpenCodeCatalog').diagnostic('OpenCode catalog request stage', value)): void {
  try {
    if (method !== 'management.catalog' || typeof requestId !== 'string' ||
        !params || typeof params !== 'object' || Array.isArray(params)) return;
    const provider = Object.getOwnPropertyDescriptor(params, 'providerId');
    const models = Object.getOwnPropertyDescriptor(params, 'includeModels');
    if ((provider && !Object.hasOwn(provider, 'value')) || (models && !Object.hasOwn(models, 'value'))) return;
    const providerId: unknown = provider?.value, includeModels: unknown = models?.value;
    if ((providerId !== undefined && typeof providerId !== 'string') ||
        (includeModels !== undefined && typeof includeModels !== 'boolean')) return;
    retain({ requestIdHash: createHash('sha256').update(requestId, 'utf8').digest('hex'),
      inputKind: providerId !== undefined ? 'explicit-provider' : includeModels === true ? 'include-models' : 'directory',
      phase: 'main-admitted' });
  } catch { /* Passive diagnostics cannot alter original request admission. */ }
}

/** Existing private Host stderr framing; observations never participate in Host custody. */
export function createCapturedHostDiagnostics(hostPid: () => number | undefined) {
  return decodeClaudeCloseDiagnostics(
    observation => {
      createLogger('Host:ClaudeClose').diagnostic('Claude close stage', observation);
    },
    observation => {
      createLogger('Host:ClaudeManagement').diagnostic('Claude management stage', observation);
    },
    observation => {
      const { startIdentity, ...fields } = observation;
      const pid = hostPid();
      if (pid !== undefined)
        createLogger('Host:OpenCodeMetadata').diagnostic('OpenCode metadata stage', {
          ...fields,
          ...(startIdentity === undefined ? {} : { startIdentityHash: createHash('sha256').update(startIdentity, 'utf8').digest('hex') }),
          hostPid: pid,
        });
    },
    observation => {
      const pid = hostPid();
      if (pid !== undefined)
        createLogger('Host:OpenCodeProbe').diagnostic('OpenCode probe phase', { ...observation, hostPid: pid });
    },
    observation => {
      const pid = hostPid();
      if (pid !== undefined)
        createLogger('Host:RuntimeOpen').diagnostic('Runtime open refusal', { ...observation, hostPid: pid });
    },
    observation => {
      const pid = hostPid();
      if (pid !== undefined)
        createLogger('Host:OpenCodeProbeClose').diagnostic('OpenCode probe close failure', { ...observation, hostPid: pid });
    },
    observation => {
      const pid = hostPid();
      if (pid !== undefined)
        createLogger('Host:OpenCodeCatalog').diagnostic('OpenCode catalog request stage', { ...observation, hostPid: pid });
    }
  );
}
