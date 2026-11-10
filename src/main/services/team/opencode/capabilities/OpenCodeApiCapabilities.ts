import { createHash } from 'crypto';

export interface OpenCodeApiEndpointMap {
  health: boolean;
  sessionCreate: boolean;
  sessionGet: boolean;
  sessionMessageList: boolean;
  sessionPromptAsync: boolean;
  sessionAbort: boolean;
  sessionStatus: boolean;
  permissionList: boolean;
  permissionReply: boolean;
  permissionLegacySessionRespond: boolean;
  sessionEventStream: boolean;
  globalEventStream: boolean;
  mcpList: boolean;
  mcpCreate: boolean;
  experimentalToolIds: boolean;
  experimentalToolList: boolean;
}

export type OpenCodeApiEndpointKey = keyof OpenCodeApiEndpointMap;

export type OpenCodeEndpointEvidence =
  | 'openapi'
  | 'direct_probe'
  | 'undocumented_direct_probe'
  | 'real_e2e'
  | 'missing';

export type OpenCodeApiCapabilitySource =
  | 'openapi_doc'
  | 'sdk_probe'
  | 'direct_probe'
  | 'mixed_openapi_direct_probe';

export interface OpenCodeApiCapabilities {
  version: string | null;
  source: OpenCodeApiCapabilitySource;
  endpoints: OpenCodeApiEndpointMap;
  requiredForTeamLaunch: {
    ready: boolean;
    missing: string[];
  };
  evidence: Record<OpenCodeApiEndpointKey, OpenCodeEndpointEvidence>;
  diagnostics: string[];
}

export interface OpenCodeApiDiscoverySnapshot {
  checkedAt: string;
  opencodeVersion: string | null;
  baseUrlRedacted: string;
  capabilities: OpenCodeApiCapabilities;
  openApiHash: string | null;
}

export interface OpenCodeApiCapabilityDetectorInput {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface OpenCodeApiDiscoverySnapshotInput {
  baseUrl: string;
  checkedAt: string;
  capabilities: OpenCodeApiCapabilities;
  openApiDocument?: unknown;
}

interface OpenApiDocument {
  openapi?: string;
  info?: {
    version?: unknown;
  };
  paths?: Record<string, Record<string, unknown>>;
}

interface RequiredOpenCodeEndpoint {
  key: OpenCodeApiEndpointKey;
  method: 'get' | 'post' | 'delete' | 'patch';
  path: RegExp;
  label: string;
}

interface DirectSafeProbe {
  method: 'GET';
  path: string;
  accept: 'application/json' | 'text/event-stream';
}

const OPENAPI_SPEC_CANDIDATES = ['/doc', '/doc.json', '/openapi.json'] as const;

export const REQUIRED_OPENCODE_ENDPOINTS: RequiredOpenCodeEndpoint[] = [
  { key: 'health', method: 'get', path: /^\/global\/health\/?$/, label: 'GET /global/health' },
  { key: 'sessionCreate', method: 'post', path: /^\/session\/?$/, label: 'POST /session' },
  {
    key: 'sessionGet',
    method: 'get',
    path: /^\/session\/(?:\{[^}]+\}|:[^/]+)\/?$/,
    label: 'GET /session/:id',
  },
  {
    key: 'sessionMessageList',
    method: 'get',
    path: /^\/session\/(?:\{[^}]+\}|:[^/]+)\/message\/?$/,
    label: 'GET /session/:id/message',
  },
  {
    key: 'sessionPromptAsync',
    method: 'post',
    path: /^\/session\/(?:\{[^}]+\}|:[^/]+)\/prompt_async\/?$/,
    label: 'POST /session/:id/prompt_async',
  },
  {
    key: 'sessionAbort',
    method: 'post',
    path: /^\/session\/(?:\{[^}]+\}|:[^/]+)\/abort\/?$/,
    label: 'POST /session/:id/abort',
  },
  {
    key: 'sessionStatus',
    method: 'get',
    path: /^\/session\/status\/?$/,
    label: 'GET /session/status',
  },
  { key: 'permissionList', method: 'get', path: /^\/permission\/?$/, label: 'GET /permission' },
  {
    key: 'permissionReply',
    method: 'post',
    path: /^\/permission\/(?:\{[^}]+\}|:[^/]+)\/reply\/?$/,
    label: 'POST /permission/:requestID/reply',
  },
  {
    key: 'permissionLegacySessionRespond',
    method: 'post',
    path: /^\/session\/(?:\{[^}]+\}|:[^/]+)\/permissions\/(?:\{[^}]+\}|:[^/]+)\/?$/,
    label: 'POST /session/:sessionID/permissions/:permissionID',
  },
  { key: 'sessionEventStream', method: 'get', path: /^\/event\/?$/, label: 'GET /event' },
  {
    key: 'globalEventStream',
    method: 'get',
    path: /^\/global\/event\/?$/,
    label: 'GET /global/event',
  },
  { key: 'mcpList', method: 'get', path: /^\/mcp\/?$/, label: 'GET /mcp' },
  { key: 'mcpCreate', method: 'post', path: /^\/mcp\/?$/, label: 'POST /mcp' },
  {
    key: 'experimentalToolIds',
    method: 'get',
    path: /^\/experimental\/tool\/ids\/?$/,
    label: 'GET /experimental/tool/ids',
  },
  {
    key: 'experimentalToolList',
    method: 'get',
    path: /^\/experimental\/tool\/?$/,
    label: 'GET /experimental/tool',
  },
];

const DIRECT_SAFE_PROBES: Partial<Record<OpenCodeApiEndpointKey, DirectSafeProbe>> = {
  health: { method: 'GET', path: '/global/health', accept: 'application/json' },
  sessionStatus: { method: 'GET', path: '/session/status', accept: 'application/json' },
  permissionList: { method: 'GET', path: '/permission/', accept: 'application/json' },
  sessionEventStream: { method: 'GET', path: '/event', accept: 'text/event-stream' },
  globalEventStream: { method: 'GET', path: '/global/event', accept: 'text/event-stream' },
  mcpList: { method: 'GET', path: '/mcp', accept: 'application/json' },
  experimentalToolIds: {
    method: 'GET',
    path: '/experimental/tool/ids',
    accept: 'application/json',
  },
  experimentalToolList: {
    method: 'GET',
    path: '/experimental/tool',
    accept: 'application/json',
  },
};

export async function detectOpenCodeApiCapabilities(
  input: OpenCodeApiCapabilityDetectorInput
): Promise<OpenCodeApiCapabilities> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 5_000;
  const diagnostics: string[] = [];
  const endpoints = createEmptyEndpointMap();
  const evidence = createEmptyEvidenceMap();

  const openApi = await loadOpenApiDocument({
    baseUrl: input.baseUrl,
    fetchImpl,
    timeoutMs,
    diagnostics,
  });

  if (openApi.document?.paths) {
    applyOpenApiEndpointEvidence(openApi.document, endpoints, evidence);
  }

  await runDirectSafeProbes({
    baseUrl: input.baseUrl,
    fetchImpl,
    timeoutMs,
    docAvailable: Boolean(openApi.document),
    endpoints,
    evidence,
    diagnostics,
  });

  if (!endpoints.permissionReply && !endpoints.permissionLegacySessionRespond) {
    diagnostics.push(
      'OpenCode permission response endpoint was not proven by OpenAPI; require real permission E2E before production launch'
    );
  }

  const missing = resolveMissingOpenCodeCapabilities(endpoints);
  const version =
    extractOpenApiVersion(openApi.document) ??
    (await probeOpenCodeHealthVersion(input.baseUrl, fetchImpl, timeoutMs, diagnostics));

  return {
    version,
    source: resolveCapabilitySource(openApi.document, evidence),
    endpoints,
    requiredForTeamLaunch: {
      ready: missing.length === 0,
      missing,
    },
    evidence,
    diagnostics,
  };
}

export function createOpenCodeApiDiscoverySnapshot(
  input: OpenCodeApiDiscoverySnapshotInput
): OpenCodeApiDiscoverySnapshot {
  return {
    checkedAt: input.checkedAt,
    opencodeVersion: input.capabilities.version,
    baseUrlRedacted: redactUrl(input.baseUrl),
    capabilities: input.capabilities,
    openApiHash: input.openApiDocument === undefined ? null : stableHash(input.openApiDocument),
  };
}

export function applyOpenApiEndpointEvidence(
  document: OpenApiDocument,
  endpoints: OpenCodeApiEndpointMap,
  evidence: Record<OpenCodeApiEndpointKey, OpenCodeEndpointEvidence>
): void {
  for (const [path, methods] of Object.entries(document.paths ?? {})) {
    for (const required of REQUIRED_OPENCODE_ENDPOINTS) {
      if (required.path.test(path) && Boolean(methods[required.method])) {
        endpoints[required.key] = true;
        evidence[required.key] = 'openapi';
      }
    }
  }
}

export function resolveMissingOpenCodeCapabilities(endpoints: OpenCodeApiEndpointMap): string[] {
  const missing: string[] = [];

  for (const endpoint of REQUIRED_OPENCODE_ENDPOINTS) {
    if (endpoint.key === 'permissionLegacySessionRespond') {
      continue;
    }

    if (endpoint.key === 'experimentalToolList') {
      continue;
    }

    if (endpoint.key === 'permissionReply') {
      if (!endpoints.permissionReply && !endpoints.permissionLegacySessionRespond) {
        missing.push('POST permission reply route');
      }
      continue;
    }

    if (endpoint.key === 'experimentalToolIds') {
      if (!endpoints.experimentalToolIds && !endpoints.experimentalToolList) {
        missing.push('GET OpenCode tool availability route');
      }
      continue;
    }

    if (!endpoints[endpoint.key]) {
      missing.push(endpoint.label);
    }
  }

  return missing;
}

export function createEmptyEndpointMap(): OpenCodeApiEndpointMap {
  return {
    health: false,
    sessionCreate: false,
    sessionGet: false,
    sessionMessageList: false,
    sessionPromptAsync: false,
    sessionAbort: false,
    sessionStatus: false,
    permissionList: false,
    permissionReply: false,
    permissionLegacySessionRespond: false,
    sessionEventStream: false,
    globalEventStream: false,
    mcpList: false,
    mcpCreate: false,
    experimentalToolIds: false,
    experimentalToolList: false,
  };
}

function createEmptyEvidenceMap(): Record<OpenCodeApiEndpointKey, OpenCodeEndpointEvidence> {
  return Object.fromEntries(
    (Object.keys(createEmptyEndpointMap()) as OpenCodeApiEndpointKey[]).map((key) => [
      key,
      'missing',
    ])
  ) as Record<OpenCodeApiEndpointKey, OpenCodeEndpointEvidence>;
}

async function loadOpenApiDocument(input: {
  baseUrl: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  diagnostics: string[];
}): Promise<{ document: OpenApiDocument | null; raw: string | null }> {
  for (const candidate of OPENAPI_SPEC_CANDIDATES) {
    try {
      const response = await fetchWithTimeout(input.fetchImpl, buildUrl(input.baseUrl, candidate), {
        timeoutMs: input.timeoutMs,
        requestInit: { headers: { accept: 'application/json' } },
      });
      const text = await response.text();

      if (!response.ok) {
        input.diagnostics.push(`OpenCode ${candidate} returned HTTP ${response.status}`);
        continue;
      }

      if (looksLikeHtml(text)) {
        input.diagnostics.push(`OpenCode ${candidate} returned HTML, expected OpenAPI JSON`);
        continue;
      }

      const parsed = JSON.parse(text) as OpenApiDocument;
      if (parsed.paths && Object.keys(parsed.paths).length > 0) {
        return { document: parsed, raw: text };
      }

      input.diagnostics.push(`OpenCode ${candidate} did not include OpenAPI paths`);
    } catch (error) {
      input.diagnostics.push(`OpenCode ${candidate} probe failed: ${stringifyError(error)}`);
    }
  }

  return { document: null, raw: null };
}

async function runDirectSafeProbes(input: {
  baseUrl: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  docAvailable: boolean;
  endpoints: OpenCodeApiEndpointMap;
  evidence: Record<OpenCodeApiEndpointKey, OpenCodeEndpointEvidence>;
  diagnostics: string[];
}): Promise<void> {
  for (const [key, probe] of Object.entries(DIRECT_SAFE_PROBES) as [
    OpenCodeApiEndpointKey,
    DirectSafeProbe,
  ][]) {
    if (input.endpoints[key]) {
      continue;
    }

    try {
      const response = await fetchWithTimeout(
        input.fetchImpl,
        buildUrl(input.baseUrl, probe.path),
        {
          timeoutMs: input.timeoutMs,
          requestInit: {
            method: probe.method,
            headers: { accept: probe.accept },
          },
        }
      );
      await cancelResponseBody(response);

      if (!response.ok) {
        input.diagnostics.push(
          `OpenCode direct probe ${probe.path} returned HTTP ${response.status}`
        );
        continue;
      }

      input.endpoints[key] = true;
      input.evidence[key] = input.docAvailable ? 'undocumented_direct_probe' : 'direct_probe';
    } catch (error) {
      input.diagnostics.push(
        `OpenCode direct probe ${probe.path} failed: ${stringifyError(error)}`
      );
    }
  }
}

async function probeOpenCodeHealthVersion(
  baseUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  diagnostics: string[]
): Promise<string | null> {
  try {
    const response = await fetchWithTimeout(fetchImpl, buildUrl(baseUrl, '/global/health'), {
      timeoutMs,
      requestInit: { headers: { accept: 'application/json' } },
    });
    const text = await response.text();
    if (!response.ok) {
      diagnostics.push(`OpenCode health version probe returned HTTP ${response.status}`);
      return null;
    }
    const parsed = JSON.parse(text) as unknown;
    return extractHealthVersion(parsed);
  } catch (error) {
    diagnostics.push(`OpenCode health version probe failed: ${stringifyError(error)}`);
    return null;
  }
}

function extractOpenApiVersion(document: OpenApiDocument | null): string | null {
  return typeof document?.info?.version === 'string' && document.info.version.trim().length > 0
    ? document.info.version
    : null;
}

function extractHealthVersion(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.version === 'string' && value.version.trim().length > 0) {
    return value.version;
  }
  if (
    isRecord(value.build) &&
    typeof value.build.version === 'string' &&
    value.build.version.trim().length > 0
  ) {
    return value.build.version;
  }
  if (
    isRecord(value.data) &&
    typeof value.data.version === 'string' &&
    value.data.version.trim().length > 0
  ) {
    return value.data.version;
  }
  return null;
}

function resolveCapabilitySource(
  document: OpenApiDocument | null,
  evidence: Record<OpenCodeApiEndpointKey, OpenCodeEndpointEvidence>
): OpenCodeApiCapabilitySource {
  if (!document) {
    return 'direct_probe';
  }
  return Object.values(evidence).some((item) => item === 'undocumented_direct_probe')
    ? 'mixed_openapi_direct_probe'
    : 'openapi_doc';
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  options: {
    timeoutMs: number;
    requestInit?: RequestInit;
  }
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    return await fetchImpl(url, {
      ...options.requestInit,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort cleanup for SSE probes after headers are proven.
  }
}

function buildUrl(baseUrl: string, path: string): string {
  return new URL(path, normalizeBaseUrl(baseUrl)).toString();
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function looksLikeHtml(text: string): boolean {
  return text.trimStart().startsWith('<');
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const redactedCredential = 'redacted';
    if (parsed.username) {
      parsed.username = redactedCredential;
    }
    if (parsed.password) {
      parsed.password = redactedCredential;
    }
    return parsed.toString();
  } catch {
    return '<invalid-url>';
  }
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(stableJsonStringify(value)).digest('hex');
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(',')}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJsonStringify(item)}`)
    .join(',')}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
