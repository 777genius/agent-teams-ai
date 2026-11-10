import type { ProviderId } from './ProviderId';
import type { RecentProjectFilesystemState } from './RecentProjectFilesystemState';
import type { RecentProjectOpenTarget } from './RecentProjectOpenTarget';

export interface RecentProjectCandidate {
  identity: string;
  displayName: string;
  primaryPath: string;
  associatedPaths: string[];
  lastActivityAt: number;
  providerIds: ProviderId[];
  sourceKind: 'claude' | 'codex';
  openTarget: RecentProjectOpenTarget;
  branchName?: string;
  filesystemState?: RecentProjectFilesystemState;
}
