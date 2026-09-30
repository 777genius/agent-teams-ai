import {
  TOKEN_USAGE_SNAPSHOT_ROUTE,
  type TokenUsageSnapshotRequest,
} from '@features/token-usage/contracts';

import type {
  RuntimeProviderCompanionInput,
  RuntimeProviderCompanionStatusDto,
  RuntimeProviderManagementRuntimeId,
} from '@features/runtime-provider-management/contracts';

export function buildTokenUsageSnapshotRoute(request?: TokenUsageSnapshotRequest): string {
  const query = new URLSearchParams();
  if (request?.teamName) query.set('teamName', request.teamName);
  for (const teamName of request?.teamNames ?? []) query.append('teamNames', teamName);
  if (request?.agentId) query.set('agentId', request.agentId);
  if (request?.commandId) query.set('commandId', request.commandId);
  if (request?.commandInvocationId) query.set('commandInvocationId', request.commandInvocationId);
  if (request?.nativeSessionId) query.set('nativeSessionId', request.nativeSessionId);
  if (request?.from) query.set('from', request.from);
  if (request?.to) query.set('to', request.to);
  const suffix = query.toString();
  return suffix ? `${TOKEN_USAGE_SNAPSHOT_ROUTE}?${suffix}` : TOKEN_USAGE_SNAPSHOT_ROUTE;
}

export function createBrowserCompanionStatus(
  input: RuntimeProviderCompanionInput,
  operation: 'status' | 'install' | 'connect' | 'action'
): RuntimeProviderCompanionStatusDto {
  const cursor = input.companionId === 'cursor-agent';
  const displayName = cursor ? 'Cursor Agent CLI' : 'Kiro CLI';
  const action = operation === 'install' ? 'install and connect' : 'connect';
  return {
    companionId: input.companionId,
    displayName,
    phase: 'needs-manual-step',
    installed: false,
    authenticated: false,
    account: null,
    binaryPath: null,
    version: null,
    percent: null,
    message: `${displayName} setup is available in the desktop app.`,
    detail: `Open Agent Teams desktop to ${action} ${displayName}.`,
    error: operation === 'status' ? null : `Native CLI ${action} is not available in browser mode.`,
    manualCommand: cursor
      ? 'curl https://cursor.com/install -fsS | bash'
      : 'curl -fsSL https://cli.kiro.dev/install | bash',
    manualUrl: cursor ? 'https://cursor.com/docs/cli/installation' : 'https://kiro.dev/downloads/',
    updatedAt: new Date().toISOString(),
  };
}

export function createBrowserRuntimeProviderError(
  runtimeId: RuntimeProviderManagementRuntimeId,
  code: 'runtime-unhealthy' | 'unsupported-action'
) {
  return {
    schemaVersion: 1 as const,
    runtimeId,
    error: {
      code,
      message: 'Runtime provider management is not available in browser mode.',
      recoverable: true,
    },
  };
}
