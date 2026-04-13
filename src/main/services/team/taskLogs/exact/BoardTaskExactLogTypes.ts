import type { BoardTaskActivityRecord } from '../activity/BoardTaskActivityRecord';
import type { ParsedMessage } from '@main/types';
import type {
  BoardTaskActivityCategory,
  BoardTaskActivityLinkKind,
  BoardTaskActivityTargetRole,
  BoardTaskExactLogActor,
  BoardTaskExactLogSource,
  BoardTaskExactLogSummary,
} from '@shared/types';

export interface BoardTaskExactLogFileVersion {
  filePath: string;
  mtimeMs: number;
  size: number;
}

export interface BoardTaskExactLogAnchor {
  kind: 'tool' | 'message';
  filePath: string;
  messageUuid: string;
  toolUseId?: string;
}

export type BoardTaskExactLogBundleCandidate = {
  id: string;
  timestamp: string;
  actor: BoardTaskExactLogActor;
  source: BoardTaskExactLogSource;
  records: BoardTaskActivityRecord[];
  anchor: BoardTaskExactLogAnchor;
  actionLabel: string;
  actionCategory?: BoardTaskActivityCategory;
  canonicalToolName?: string;
  linkKinds: BoardTaskActivityLinkKind[];
  targetRoles: BoardTaskActivityTargetRole[];
} & ({ canLoadDetail: true; sourceGeneration: string } | { canLoadDetail: false });

export interface BoardTaskExactLogDetailCandidate {
  id: string;
  timestamp: string;
  actor: BoardTaskExactLogActor;
  source: BoardTaskExactLogSource;
  records: BoardTaskActivityRecord[];
  filteredMessages: ParsedMessage[];
}

export function mapCandidateToSummary(
  candidate: BoardTaskExactLogBundleCandidate
): BoardTaskExactLogSummary {
  return candidate.canLoadDetail
    ? {
        id: candidate.id,
        timestamp: candidate.timestamp,
        actor: candidate.actor,
        source: candidate.source,
        anchorKind: candidate.anchor.kind,
        actionLabel: candidate.actionLabel,
        ...(candidate.actionCategory ? { actionCategory: candidate.actionCategory } : {}),
        ...(candidate.canonicalToolName ? { canonicalToolName: candidate.canonicalToolName } : {}),
        linkKinds: candidate.linkKinds,
        canLoadDetail: true,
        sourceGeneration: candidate.sourceGeneration,
      }
    : {
        id: candidate.id,
        timestamp: candidate.timestamp,
        actor: candidate.actor,
        source: candidate.source,
        anchorKind: candidate.anchor.kind,
        actionLabel: candidate.actionLabel,
        ...(candidate.actionCategory ? { actionCategory: candidate.actionCategory } : {}),
        ...(candidate.canonicalToolName ? { canonicalToolName: candidate.canonicalToolName } : {}),
        linkKinds: candidate.linkKinds,
        canLoadDetail: false,
      };
}
