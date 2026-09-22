import { normalizePathForComparison, stripTrailingSeparators } from '@shared/utils/platformPath';

import type { TeamBranchTrackingRendererPorts } from '../ports/TeamBranchTrackingRendererPorts';

interface TrackedPath {
  projectPath: string;
  refCount: number;
}

export interface TeamBranchTrackingRegistration {
  update(projectPaths: readonly string[]): void;
  dispose(): void;
}

function getPathEntries(projectPaths: readonly string[]): Map<string, string> {
  const entries = new Map<string, string>();
  for (const projectPath of projectPaths) {
    const exactPath = projectPath.trim();
    if (!exactPath) continue;
    const key = stripTrailingSeparators(normalizePathForComparison(exactPath));
    if (key && !entries.has(key)) {
      entries.set(key, exactPath);
    }
  }
  return entries;
}

export class TeamBranchTrackingCoordinator {
  private readonly trackedPaths = new Map<string, TrackedPath>();

  constructor(private readonly ports: TeamBranchTrackingRendererPorts) {}

  register(projectPaths: readonly string[] = []): TeamBranchTrackingRegistration {
    let keys = new Set<string>();
    let disposed = false;

    const update = (nextProjectPaths: readonly string[]): void => {
      if (disposed) return;
      const nextEntries = getPathEntries(nextProjectPaths);

      for (const key of keys) {
        if (!nextEntries.has(key)) {
          this.release(key);
        }
      }
      for (const [key, projectPath] of nextEntries) {
        if (!keys.has(key)) {
          this.acquire(key, projectPath);
        }
      }

      keys = new Set(nextEntries.keys());
    };

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      for (const key of keys) {
        this.release(key);
      }
      keys.clear();
    };

    const registration = { update, dispose };
    registration.update(projectPaths);
    return registration;
  }

  private acquire(key: string, projectPath: string): void {
    const current = this.trackedPaths.get(key);
    if (current) {
      current.refCount += 1;
      return;
    }

    this.trackedPaths.set(key, { projectPath, refCount: 1 });
    void this.requestTracking(projectPath, true);
  }

  private release(key: string): void {
    const current = this.trackedPaths.get(key);
    if (!current) return;
    if (current.refCount > 1) {
      current.refCount -= 1;
      return;
    }

    this.trackedPaths.delete(key);
    void this.requestTracking(current.projectPath, false);
  }

  private async requestTracking(projectPath: string, enabled: boolean): Promise<void> {
    try {
      await this.ports.setTracking(projectPath, enabled);
    } catch {
      // Tracking is best-effort; registrations remain authoritative after a failed request.
    }
  }
}
