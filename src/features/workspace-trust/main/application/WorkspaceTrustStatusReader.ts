import { buildWorkspaceTrustPathCandidates } from '../../core/domain';

import type {
  WorkspaceTrustProjectStatusRequest,
  WorkspaceTrustProjectStatusResult,
} from '../../contracts';
import type { ProviderStateProbe } from '../../core/application';
import type { WorkspaceTrustPathPlatform } from '../../core/domain';

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
      enabled: boolean;
      stateProbe: ProviderStateProbe;
      ports: WorkspaceTrustStatusReaderPorts;
    }
  ) {}

  async read(
    request: WorkspaceTrustProjectStatusRequest
  ): Promise<WorkspaceTrustProjectStatusResult> {
    if (!this.input.enabled) {
      return { status: 'disabled' };
    }

    try {
      const pathResolution = await this.input.ports.resolvePath(request.projectPath);
      if (pathResolution.status === 'missing') {
        return { status: 'not_applicable' };
      }
      if (pathResolution.status === 'unknown') {
        return { status: 'unknown' };
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

      if (!workspace?.persistable) {
        return { status: 'not_applicable' };
      }

      const trustState = await this.input.stateProbe.readTrustState(workspace);
      return { status: trustState.status };
    } catch {
      return { status: 'unknown' };
    }
  }
}
