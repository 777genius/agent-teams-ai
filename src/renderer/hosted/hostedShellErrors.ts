import { HostedWorkspaceRegistryTransportError } from '@features/workspace-registry/renderer';

export function workspaceLoadErrorText(error: unknown): string {
  return error instanceof HostedWorkspaceRegistryTransportError &&
    error.code === 'request_cancelled'
    ? 'Workspace loading was cancelled.'
    : 'Registered workspaces could not be loaded.';
}
