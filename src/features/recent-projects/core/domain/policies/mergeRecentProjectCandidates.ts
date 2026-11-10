import type { ProviderId } from '../models/ProviderId';
import type { RecentProjectAggregate } from '../models/RecentProjectAggregate';
import type { RecentProjectCandidate } from '../models/RecentProjectCandidate';

function uniquePaths(paths: readonly string[], primaryPath: string): string[] {
  const ordered = [primaryPath, ...paths];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const path of ordered) {
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    result.push(path);
  }

  return result;
}

function uniqueProviders(providerIds: readonly ProviderId[]): ProviderId[] {
  return Array.from(new Set(providerIds));
}

function selectPreferredCandidate(
  candidates: readonly RecentProjectCandidate[]
): RecentProjectCandidate {
  const availableCandidates = candidates.filter(
    (candidate) => candidate.filesystemState !== 'deleted'
  );
  const candidatePool = availableCandidates.length > 0 ? availableCandidates : candidates;
  const existingWorktreeCandidates = candidatePool.filter(
    (candidate) => candidate.openTarget.type === 'existing-worktree'
  );
  const pool = existingWorktreeCandidates.length > 0 ? existingWorktreeCandidates : candidatePool;

  return [...pool].sort((left, right) => {
    if (right.lastActivityAt !== left.lastActivityAt) {
      return right.lastActivityAt - left.lastActivityAt;
    }
    return left.displayName.localeCompare(right.displayName);
  })[0];
}

function mergeBranchName(candidates: readonly RecentProjectCandidate[]): string | undefined {
  const branchNames = Array.from(
    new Set(candidates.map((candidate) => candidate.branchName?.trim()).filter(Boolean))
  );

  return branchNames.length === 1 ? branchNames[0] : undefined;
}

export function mergeRecentProjectCandidates(
  candidates: readonly RecentProjectCandidate[]
): RecentProjectAggregate[] {
  const grouped = new Map<string, RecentProjectCandidate[]>();

  for (const candidate of candidates) {
    if (!candidate.identity || candidate.lastActivityAt <= 0) {
      continue;
    }
    const bucket = grouped.get(candidate.identity);
    if (bucket) {
      bucket.push(candidate);
    } else {
      grouped.set(candidate.identity, [candidate]);
    }
  }

  const aggregates = Array.from(grouped.values()).map((group): RecentProjectAggregate => {
    const preferred = selectPreferredCandidate(group);
    const providerIds = uniqueProviders(group.flatMap((candidate) => candidate.providerIds));
    const sourceKinds = new Set(group.map((candidate) => candidate.sourceKind));

    return {
      identity: preferred.identity,
      displayName: preferred.displayName,
      primaryPath: preferred.primaryPath,
      associatedPaths: uniquePaths(
        group.flatMap((candidate) => candidate.associatedPaths),
        preferred.primaryPath
      ),
      lastActivityAt: Math.max(...group.map((candidate) => candidate.lastActivityAt)),
      providerIds,
      source: sourceKinds.size > 1 ? 'mixed' : sourceKinds.has('codex') ? 'codex' : 'claude',
      openTarget: preferred.openTarget,
      branchName: mergeBranchName(group),
      filesystemState: preferred.filesystemState ?? 'available',
    };
  });

  return aggregates.sort((left, right) => right.lastActivityAt - left.lastActivityAt);
}
