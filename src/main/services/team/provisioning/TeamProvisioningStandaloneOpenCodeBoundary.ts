import { isOpenCodeLegacyProvisioningRequest } from './TeamProvisioningLaunchCompatibility';

export const STANDALONE_OPENCODE_RUNTIME_ADAPTER_UNAVAILABLE_ERROR_NAME =
  'StandaloneOpenCodeRuntimeAdapterUnavailableError';

export class StandaloneOpenCodeRuntimeAdapterUnavailableError extends Error {
  readonly statusCode = 501;

  constructor() {
    super(
      'OpenCode team launch is not available in standalone mode because the OpenCode runtime adapter is unavailable outside Electron.'
    );
    this.name = STANDALONE_OPENCODE_RUNTIME_ADAPTER_UNAVAILABLE_ERROR_NAME;
  }
}

const standaloneOpenCodeRuntimeAdapterBoundaryEnabledServices = new WeakSet<object>();

export function enableStandaloneOpenCodeRuntimeAdapterBoundary(service: object): void {
  standaloneOpenCodeRuntimeAdapterBoundaryEnabledServices.add(service);
}

export function isStandaloneOpenCodeRuntimeAdapterUnavailableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === STANDALONE_OPENCODE_RUNTIME_ADAPTER_UNAVAILABLE_ERROR_NAME
  );
}

export function assertStandaloneOpenCodeRuntimeAdapterAvailableForRequest(request: {
  providerId?: unknown;
  members?: readonly { providerId?: unknown; provider?: unknown }[];
}): void {
  if (isOpenCodeLegacyProvisioningRequest(request)) {
    throw new StandaloneOpenCodeRuntimeAdapterUnavailableError();
  }
}

export function assertStandaloneOpenCodeRuntimeAdapterAvailableForServiceRequest(
  service: object,
  request: {
    providerId?: unknown;
    members?: readonly { providerId?: unknown; provider?: unknown }[];
  }
): void {
  if (!standaloneOpenCodeRuntimeAdapterBoundaryEnabledServices.has(service)) {
    return;
  }
  assertStandaloneOpenCodeRuntimeAdapterAvailableForRequest(request);
}
