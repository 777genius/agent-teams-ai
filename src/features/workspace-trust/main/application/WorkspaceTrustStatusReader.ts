import { buildWorkspaceTrustPathCandidates } from '../../core/domain';
import { buildCodexTrustPatches } from '../../core/domain/buildCodexTrustPatches';

import type {
  LaunchTrustRequest,
  LaunchTrustResult,
  ProviderLaunchTrustStatus,
  WorkspaceTrustProjectStatusRequest,
  WorkspaceTrustProjectStatusResult,
} from '../../contracts';
import type { ProviderStateProbe } from '../../core/application';
import type {
  WorkspaceTrustFeatureFlags,
  WorkspaceTrustPathPlatform,
  WorkspaceTrustWorkspace,
} from '../../core/domain';

export type WorkspaceTrustPathResolution =
  | { status: 'resolved'; realPath: string }
  | { status: 'missing' }
  | { status: 'unknown' };

export interface WorkspaceTrustStatusReaderPorts {
  getHomeDir(): string;
  resolvePath(value: string): Promise<WorkspaceTrustPathResolution>;
  resolveGitRoot(cwd: string): Promise<string | null>;
  resolveCanonicalGitRoot(gitRoot: string): Promise<string>;
  platform: WorkspaceTrustPathPlatform;
}

export class WorkspaceTrustStatusReader {
  constructor(
    private readonly input: {
      featureFlags: WorkspaceTrustFeatureFlags;
      stateProbe: ProviderStateProbe;
      ports: WorkspaceTrustStatusReaderPorts;
    }
  ) {}

  async read(
    request: WorkspaceTrustProjectStatusRequest
  ): Promise<WorkspaceTrustProjectStatusResult> {
    const result = await this.readLaunchStatus({ ...request, providerIds: ['anthropic'] });
    const provider = result.providers[0];
    return { status: provider?.providerId === 'anthropic' ? provider.status : 'unknown' };
  }

  async readLaunchStatus(request: LaunchTrustRequest): Promise<LaunchTrustResult> {
    const providerIds = [...new Set(request.providerIds)].sort((left, right) =>
      left.localeCompare(right)
    );
    const flags = this.input.featureFlags;
    const isEnabled = (providerId: string): boolean =>
      flags.enabled && (providerId === 'anthropic' ? flags.claudePty : flags.codexArgs);
    const fallback = (status: 'unknown' | 'not_applicable'): LaunchTrustResult => ({
      providers: providerIds.map((providerId) => ({
        providerId,
        status: isEnabled(providerId) ? status : 'disabled',
      })),
    });
    if (!providerIds.some(isEnabled)) return fallback('unknown');

    try {
      const pathResolution = await this.input.ports.resolvePath(request.projectPath);
      if (pathResolution.status === 'missing') {
        return fallback('not_applicable');
      }
      if (pathResolution.status === 'unknown') {
        return fallback('unknown');
      }
      const realCwd = pathResolution.realPath;

      const resolvedGitRoot = await this.input.ports.resolveGitRoot(realCwd);
      const canonicalGitRoot = resolvedGitRoot
        ? await this.input.ports.resolveCanonicalGitRoot(resolvedGitRoot)
        : null;
      const workspace = buildWorkspaceTrustPathCandidates({
        cwd: request.projectPath,
        realCwd,
        gitRoot: canonicalGitRoot,
        homeDir: this.input.ports.getHomeDir(),
        source: 'team-root',
        platform: this.input.ports.platform,
      })[0];

      if (!workspace) return fallback('unknown');
      return {
        providers: await Promise.all(
          providerIds.map(async (providerId): Promise<ProviderLaunchTrustStatus> => {
            if (!isEnabled(providerId)) return { providerId, status: 'disabled' };
            try {
              if (providerId === 'anthropic')
                return { providerId, status: await this.readClaude(workspace) };
              const patches = buildCodexTrustPatches({
                providers: ['codex'],
                workspaces: [workspace],
                featureFlags: flags,
              });
              return { providerId, status: patches.length ? 'launch_scoped' : 'unknown' };
            } catch {
              return { providerId, status: 'unknown' };
            }
          })
        ),
      };
    } catch {
      return fallback('unknown');
    }
  }

  private async readClaude(
    workspace: WorkspaceTrustWorkspace
  ): Promise<WorkspaceTrustProjectStatusResult['status']> {
    if (!workspace.persistable) return 'not_applicable';
    return (await this.input.stateProbe.readTrustState(workspace)).status;
  }
}
