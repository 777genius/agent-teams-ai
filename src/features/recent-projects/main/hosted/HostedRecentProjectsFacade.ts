import { parseWorkspaceId } from '@shared/contracts/hosted';

import type { HostedRecentProjectDto, HostedRecentProjectsResult } from '../../contracts/hosted';
import type {
  HostedRecentAuthorityPort,
  HostedRecentAuthoritySnapshot,
  HostedRecentGrantPort,
  HostedRecentMetadataSource,
  HostedRecentProvider,
  HostedRecentRootAttributionPort,
  HostedRecentRootBoundary,
  HostedRecentWorkspaceOwner,
} from './ports';

const CACHE_TTL_MS = 10_000;
const SAFE_LABEL = /^Workspace [1-9][0-9]{0,5}$/;

interface AdmittedRow {
  readonly owner: HostedRecentWorkspaceOwner;
  readonly publicWorkspaceId: HostedRecentProjectDto['workspaceId'];
  readonly label: string;
  readonly sources: Map<
    HostedRecentProvider,
    { observedAt: number; confirmedAt: number; freshness: 'fresh' | 'stale' }
  >;
}

interface CacheEntry {
  readonly key: string;
  readonly expiresAt: number;
  readonly rows: readonly {
    readonly runtimeWorkspaceId: HostedRecentProjectDto['workspaceId'];
    readonly dto: HostedRecentProjectDto;
  }[];
  readonly completeness: 'complete' | 'partial';
}

function sameFence(a: HostedRecentAuthoritySnapshot, b: HostedRecentAuthoritySnapshot): boolean {
  return (
    a.authorityFingerprint === b.authorityFingerprint &&
    a.deploymentId === b.deploymentId &&
    a.bootId === b.bootId &&
    a.registrationRevision === b.registrationRevision &&
    a.mountGeneration === b.mountGeneration &&
    a.grantRevision === b.grantRevision
  );
}

function keyFor(
  snapshot: HostedRecentAuthoritySnapshot,
  boundary: HostedRecentRootBoundary
): string {
  return JSON.stringify([
    snapshot.authorityFingerprint,
    snapshot.deploymentId,
    snapshot.bootId,
    snapshot.registrationRevision,
    snapshot.mountGeneration,
    snapshot.grantRevision,
    boundary.rootFingerprint,
  ]);
}

const unavailable = (
  code: 'source_unavailable' | 'authority_changed'
): HostedRecentProjectsResult => ({ schemaVersion: 1, kind: 'unavailable', code });

export class HostedRecentProjectsFacade {
  #cache: CacheEntry | null = null;
  #generation = 0;

  constructor(
    private readonly authority: HostedRecentAuthorityPort,
    private readonly roots: HostedRecentRootAttributionPort,
    private readonly grants: HostedRecentGrantPort,
    private readonly sources: readonly HostedRecentMetadataSource[],
    private readonly now: () => number = Date.now
  ) {
    if (
      sources.length !== 2 ||
      !sources.some((source) => source.provider === 'anthropic') ||
      !sources.some((source) => source.provider === 'codex')
    ) {
      throw new TypeError('hosted-recent-sources-invalid');
    }
  }

  private async capture(): Promise<{
    snapshot: HostedRecentAuthoritySnapshot;
    boundary: HostedRecentRootBoundary;
  } | null> {
    const snapshot = await this.authority.current();
    if (!snapshot) return null;
    const boundary = await this.roots.resolve(snapshot);
    return boundary ? { snapshot, boundary } : null;
  }

  private async stillCurrent(
    snapshot: HostedRecentAuthoritySnapshot,
    boundary: HostedRecentRootBoundary
  ): Promise<boolean> {
    const latest = await this.capture();
    return (
      !!latest &&
      sameFence(snapshot, latest.snapshot) &&
      boundary.rootFingerprint === latest.boundary.rootFingerprint
    );
  }

  private async projectRows(
    snapshot: HostedRecentAuthoritySnapshot,
    rows: CacheEntry['rows'],
    stale: boolean,
    readAt: number
  ): Promise<HostedRecentProjectDto[]> {
    const projected: HostedRecentProjectDto[] = [];
    for (const { runtimeWorkspaceId, dto } of rows) {
      const grant = await this.grants.projectGrantedWorkspace(snapshot, runtimeWorkspaceId);
      if (!grant || grant.workspaceId !== dto.workspaceId || !SAFE_LABEL.test(grant.label))
        continue;
      const sources = dto.sources
        .filter((source) => source.observedAt <= source.confirmedAt && source.confirmedAt <= readAt)
        .map((source) => ({ ...source, freshness: stale ? ('stale' as const) : source.freshness }));
      if (sources.length) projected.push({ ...dto, label: grant.label, sources });
    }
    return projected;
  }

  async list(): Promise<HostedRecentProjectsResult> {
    const requestGeneration = ++this.#generation;
    let captured: Awaited<ReturnType<HostedRecentProjectsFacade['capture']>>;
    try {
      captured = await this.capture();
    } catch {
      if (requestGeneration === this.#generation) this.#cache = null;
      return unavailable('source_unavailable');
    }
    if (!captured) {
      if (requestGeneration === this.#generation) this.#cache = null;
      return unavailable('source_unavailable');
    }
    if (requestGeneration !== this.#generation) return unavailable('authority_changed');
    const { snapshot, boundary } = captured;
    const cacheKey = keyFor(snapshot, boundary);
    if (this.#cache?.key !== cacheKey) this.#cache = null;
    const readAt = this.now();
    if (this.#cache && readAt < this.#cache.expiresAt) {
      try {
        const projects = await this.projectRows(snapshot, this.#cache.rows, false, readAt);
        if (requestGeneration !== this.#generation) return unavailable('authority_changed');
        if (projects.length !== this.#cache.rows.length) this.#cache = null;
        const current = await this.stillCurrent(snapshot, boundary);
        if (requestGeneration !== this.#generation || !current) {
          if (requestGeneration === this.#generation) this.#cache = null;
          return unavailable('authority_changed');
        }
        return {
          schemaVersion: 1,
          kind: 'recent-projects',
          deploymentId: snapshot.deploymentId,
          bootId: snapshot.bootId,
          readAt,
          completeness: this.#cache?.completeness ?? 'partial',
          projects,
        };
      } catch {
        if (requestGeneration === this.#generation) this.#cache = null;
        return unavailable('source_unavailable');
      }
    }

    const previous = this.#cache;
    const rows = new Map<string, AdmittedRow>();
    let completeness: 'complete' | 'partial' = 'complete';
    try {
      for (const source of this.sources) {
        const result = await source.read(async (fact) => {
          // The injected root port must canonicalize and attribute against every registered root.
          const owner = await boundary.attribute(fact.cwd);
          if (!owner || !owner.mountAvailable) return;
          const grant = await this.grants.projectGrantedWorkspace(
            snapshot,
            owner.runtimeWorkspaceId
          );
          if (!grant || !SAFE_LABEL.test(grant.label)) return;
          if (
            !Number.isFinite(fact.observedAt) ||
            fact.observedAt < 0 ||
            fact.observedAt > readAt
          ) {
            completeness = 'partial';
            return;
          }
          const publicId = parseWorkspaceId(grant.workspaceId);
          const row = rows.get(owner.runtimeWorkspaceId) ?? {
            owner,
            publicWorkspaceId: publicId,
            label: grant.label,
            sources: new Map<
              HostedRecentProvider,
              { observedAt: number; confirmedAt: number; freshness: 'fresh' | 'stale' }
            >(),
          };
          const prior = row.sources.get(source.provider);
          if (!prior || fact.observedAt > prior.observedAt) {
            row.sources.set(source.provider, {
              observedAt: fact.observedAt,
              confirmedAt: readAt,
              freshness: 'fresh',
            });
          }
          rows.set(owner.runtimeWorkspaceId, row);
        });
        if (result.status !== 'complete') completeness = 'partial';
        if (result.status !== 'complete' && previous) {
          for (const { runtimeWorkspaceId, dto: cached } of previous.rows) {
            const grant = await this.grants.projectGrantedWorkspace(snapshot, runtimeWorkspaceId);
            if (!grant || grant.workspaceId !== cached.workspaceId || !SAFE_LABEL.test(grant.label))
              continue;
            const owner: HostedRecentWorkspaceOwner = {
              runtimeWorkspaceId,
              registrationRevision: cached.registrationRevision,
              mountGeneration: cached.mountGeneration,
              mountAvailable: cached.openAvailability === 'available',
            };
            const row = rows.get(runtimeWorkspaceId) ?? {
              owner,
              publicWorkspaceId: cached.workspaceId,
              label: grant.label,
              sources: new Map<
                HostedRecentProvider,
                { observedAt: number; confirmedAt: number; freshness: 'fresh' | 'stale' }
              >(),
            };
            const cachedSource = cached.sources.find((item) => item.provider === source.provider);
            const scannedSource = row.sources.get(source.provider);
            if (
              cachedSource &&
              (!scannedSource || cachedSource.observedAt > scannedSource.observedAt)
            ) {
              row.sources.set(source.provider, {
                observedAt: cachedSource.observedAt,
                confirmedAt: cachedSource.confirmedAt,
                freshness: 'stale',
              });
              rows.set(runtimeWorkspaceId, row);
            }
          }
        }
      }
      const current = await this.stillCurrent(snapshot, boundary);
      if (requestGeneration !== this.#generation || !current) {
        if (requestGeneration === this.#generation) this.#cache = null;
        return unavailable('authority_changed');
      }
    } catch {
      if (requestGeneration === this.#generation) this.#cache = null;
      return unavailable('source_unavailable');
    }
    const cacheRows = [...rows.values()]
      .map((row): CacheEntry['rows'][number] => ({
        runtimeWorkspaceId: row.owner.runtimeWorkspaceId,
        dto: {
          workspaceId: row.publicWorkspaceId,
          label: row.label,
          registrationRevision: row.owner.registrationRevision,
          mountGeneration: row.owner.mountGeneration,
          openAvailability: row.owner.mountAvailable ? 'available' : 'mount_unavailable',
          sources: [...row.sources].map(([provider, fact]) => ({ provider, ...fact })),
        },
      }))
      .sort(
        (a, b) =>
          Math.max(...b.dto.sources.map((source) => source.observedAt)) -
          Math.max(...a.dto.sources.map((source) => source.observedAt))
      )
      .slice(0, 120);
    let projects: HostedRecentProjectDto[];
    try {
      projects = await this.projectRows(snapshot, cacheRows, false, readAt);
      const current = await this.stillCurrent(snapshot, boundary);
      if (requestGeneration !== this.#generation || !current) {
        if (requestGeneration === this.#generation) this.#cache = null;
        return unavailable('authority_changed');
      }
    } catch {
      if (requestGeneration === this.#generation) this.#cache = null;
      return unavailable('source_unavailable');
    }
    this.#cache = {
      key: cacheKey,
      expiresAt: readAt + CACHE_TTL_MS,
      rows: cacheRows,
      completeness,
    };
    return {
      schemaVersion: 1,
      kind: 'recent-projects',
      deploymentId: snapshot.deploymentId,
      bootId: snapshot.bootId,
      readAt,
      completeness,
      projects,
    };
  }
}
