import { HOSTED_AUTH_HEADERS } from '@features/hosted-access/contracts';
import { parseHostedRecentProjectsResult } from '@features/recent-projects/contracts';
import { parseBootId, parseDeploymentId } from '@shared/contracts/hosted';

import type { HostedRecentProjectsResult } from '@features/recent-projects/contracts';
import type { TeamId, WorkspaceId } from '@shared/contracts/hosted';

export const HOSTED_RECENT_PROJECTS_ROUTE = '/api/hosted/v1/dashboard/recent-projects';
export const HOSTED_WORKSPACE_ACCESS_ROUTE = '/api/hosted/v1/workspace-access/project';

export const HOSTED_ACCESS_CAPABILITIES = [
  'directory.read',
  'team.open',
  'configuration.read',
  'configuration.write',
  'promotion.execute',
  'lifecycle.command',
  'task.read',
  'task.write',
  'message.read',
  'message.send',
  'operator.control',
] as const;
export type HostedAccessCapability = (typeof HOSTED_ACCESS_CAPABILITIES)[number];

export interface HostedAccessSnapshot {
  readonly deploymentId: string;
  readonly bootId: string;
  readonly registrationRevision: number;
  readonly mountGeneration: number;
  readonly grantRevision: string;
  readonly teamIdentityRevision?: string;
  readonly capabilities: readonly HostedAccessCapability[];
}

export type HostedDashboardFetch = typeof fetch;

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_response');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== keys.length ||
    Object.keys(record).some((key) => !keys.includes(key))
  ) {
    throw new Error('invalid_response');
  }
  return record;
}

export function parseHostedAccessSnapshot(value: unknown): HostedAccessSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_response');
  const record = value as Record<string, unknown>;
  const keys = [
    'deploymentId',
    'bootId',
    'registrationRevision',
    'mountGeneration',
    'grantRevision',
    'capabilities',
  ];
  if (Object.hasOwn(record, 'teamIdentityRevision')) keys.push('teamIdentityRevision');
  exactRecord(value, keys);
  const deploymentId = parseDeploymentId(record.deploymentId);
  const bootId = parseBootId(record.bootId);
  if (
    !Number.isSafeInteger(record.registrationRevision) ||
    (record.registrationRevision as number) < 1 ||
    !Number.isSafeInteger(record.mountGeneration) ||
    (record.mountGeneration as number) < 1 ||
    typeof record.grantRevision !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.grantRevision) ||
    (record.teamIdentityRevision !== undefined &&
      (typeof record.teamIdentityRevision !== 'string' ||
        !/^[0-9a-f]{64}$/.test(record.teamIdentityRevision))) ||
    !Array.isArray(record.capabilities) ||
    record.capabilities.length > HOSTED_ACCESS_CAPABILITIES.length ||
    record.capabilities.some((capability) => !HOSTED_ACCESS_CAPABILITIES.includes(capability)) ||
    new Set(record.capabilities).size !== record.capabilities.length
  )
    throw new Error('invalid_response');
  return {
    deploymentId,
    bootId,
    registrationRevision: record.registrationRevision as number,
    mountGeneration: record.mountGeneration as number,
    grantRevision: record.grantRevision,
    ...(record.teamIdentityRevision === undefined
      ? {}
      : { teamIdentityRevision: record.teamIdentityRevision }),
    capabilities: record.capabilities as HostedAccessCapability[],
  };
}

export function createHostedDashboardTransport(
  fetchPort: HostedDashboardFetch,
  getCsrfToken: () => string | null
) {
  const post = async (path: string, body: object, signal: AbortSignal): Promise<unknown> => {
    const csrf = getCsrfToken();
    if (!csrf || !/^[A-Za-z0-9_-]{32,512}$/.test(csrf)) throw new Error('access_unavailable');
    const response = await fetchPort(path, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        [HOSTED_AUTH_HEADERS.csrf]: csrf,
      },
      body: JSON.stringify(body),
    });
    if (response.status === 401 || response.status === 403)
      throw new Error('authentication_required');
    if (!response.ok) throw new Error('source_unavailable');
    return response.json();
  };
  return Object.freeze({
    async recent(signal: AbortSignal): Promise<HostedRecentProjectsResult> {
      return parseHostedRecentProjectsResult(
        await post(HOSTED_RECENT_PROJECTS_ROUTE, { schemaVersion: 1 }, signal)
      );
    },
    async access(
      workspaceId: WorkspaceId,
      teamId: TeamId | null,
      signal: AbortSignal
    ): Promise<HostedAccessSnapshot> {
      const access = parseHostedAccessSnapshot(
        await post(
          HOSTED_WORKSPACE_ACCESS_ROUTE,
          teamId === null
            ? { publicWorkspaceId: workspaceId }
            : { publicWorkspaceId: workspaceId, publicTeamId: teamId },
          signal
        )
      );
      if ((teamId === null) !== (access.teamIdentityRevision === undefined))
        throw new Error('invalid_response');
      return access;
    },
  });
}
