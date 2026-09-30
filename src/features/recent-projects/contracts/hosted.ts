import { parseBootId, parseDeploymentId, parseWorkspaceId } from '@shared/contracts/hosted';

import type { BootId, DeploymentId, WorkspaceId } from '@shared/contracts/hosted';

export interface HostedRecentProjectDto {
  readonly workspaceId: WorkspaceId;
  readonly label: string;
  readonly registrationRevision: number;
  readonly mountGeneration: number;
  readonly sources: readonly {
    readonly provider: 'anthropic' | 'codex';
    readonly observedAt: number;
    readonly confirmedAt: number;
    readonly freshness: 'fresh' | 'stale';
  }[];
  readonly openAvailability: 'available' | 'mount_unavailable';
}

export type HostedRecentProjectsResult =
  | {
      readonly schemaVersion: 1;
      readonly kind: 'recent-projects';
      readonly deploymentId: DeploymentId;
      readonly bootId: BootId;
      readonly readAt: number;
      readonly completeness: 'complete' | 'partial';
      readonly projects: readonly HostedRecentProjectDto[];
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: 'unavailable';
      readonly code: 'source_unavailable' | 'authority_changed';
    };

const MAX_PROJECTS = 120;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('hosted-recent-invalid');
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) {
    throw new TypeError('hosted-recent-invalid');
  }
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new TypeError('hosted-recent-invalid');
  return value as number;
}

/** Exact wire decoder. No paths, branches, remotes, or arbitrary labels cross this boundary. */
export function parseHostedRecentProjectsResult(
  value: unknown,
  now = Date.now()
): HostedRecentProjectsResult {
  const payload = object(value);
  if (payload.schemaVersion !== 1) throw new TypeError('hosted-recent-invalid');
  if (payload.kind === 'unavailable') {
    keys(payload, ['schemaVersion', 'kind', 'code']);
    if (payload.code !== 'source_unavailable' && payload.code !== 'authority_changed') {
      throw new TypeError('hosted-recent-invalid');
    }
    return { schemaVersion: 1, kind: 'unavailable', code: payload.code };
  }
  if (payload.kind !== 'recent-projects') throw new TypeError('hosted-recent-invalid');
  keys(payload, [
    'schemaVersion',
    'kind',
    'deploymentId',
    'bootId',
    'readAt',
    'completeness',
    'projects',
  ]);
  const readAt = payload.readAt;
  if (
    typeof readAt !== 'number' ||
    !Number.isFinite(readAt) ||
    readAt < 0 ||
    readAt > now + MAX_CLOCK_SKEW_MS
  )
    throw new TypeError('hosted-recent-invalid');
  if (payload.completeness !== 'complete' && payload.completeness !== 'partial') {
    throw new TypeError('hosted-recent-invalid');
  }
  if (!Array.isArray(payload.projects) || payload.projects.length > MAX_PROJECTS) {
    throw new TypeError('hosted-recent-invalid');
  }
  const workspaceIds = new Set<string>();
  const projects = payload.projects.map((unknownProject): HostedRecentProjectDto => {
    const project = object(unknownProject);
    keys(project, [
      'workspaceId',
      'label',
      'registrationRevision',
      'mountGeneration',
      'sources',
      'openAvailability',
    ]);
    const workspaceId = parseWorkspaceId(project.workspaceId);
    if (
      workspaceIds.has(workspaceId) ||
      typeof project.label !== 'string' ||
      !/^Workspace [1-9][0-9]{0,5}$/.test(project.label)
    )
      throw new TypeError('hosted-recent-invalid');
    workspaceIds.add(workspaceId);
    if (
      project.openAvailability !== 'available' &&
      project.openAvailability !== 'mount_unavailable'
    ) {
      throw new TypeError('hosted-recent-invalid');
    }
    if (
      !Array.isArray(project.sources) ||
      project.sources.length < 1 ||
      project.sources.length > 2
    ) {
      throw new TypeError('hosted-recent-invalid');
    }
    const providers = new Set<string>();
    const sources = project.sources.map((unknownSource) => {
      const source = object(unknownSource);
      keys(source, ['provider', 'observedAt', 'confirmedAt', 'freshness']);
      if (
        (source.provider !== 'anthropic' && source.provider !== 'codex') ||
        providers.has(source.provider) ||
        (source.freshness !== 'fresh' && source.freshness !== 'stale') ||
        typeof source.observedAt !== 'number' ||
        !Number.isFinite(source.observedAt) ||
        typeof source.confirmedAt !== 'number' ||
        !Number.isFinite(source.confirmedAt) ||
        source.observedAt < 0 ||
        source.observedAt > source.confirmedAt ||
        source.confirmedAt > readAt
      )
        throw new TypeError('hosted-recent-invalid');
      providers.add(source.provider);
      return {
        provider: source.provider as 'anthropic' | 'codex',
        observedAt: source.observedAt,
        confirmedAt: source.confirmedAt,
        freshness: source.freshness as 'fresh' | 'stale',
      };
    });
    return {
      workspaceId,
      label: project.label,
      registrationRevision: revision(project.registrationRevision),
      mountGeneration: revision(project.mountGeneration),
      sources,
      openAvailability: project.openAvailability,
    };
  });
  return {
    schemaVersion: 1,
    kind: 'recent-projects',
    deploymentId: parseDeploymentId(payload.deploymentId),
    bootId: parseBootId(payload.bootId),
    readAt,
    completeness: payload.completeness,
    projects,
  };
}
