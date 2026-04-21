import { normalizePathForComparison } from '@shared/utils/platformPath';

import type { AgentChangeSet, SnippetDiff, TaskChangeSet, TaskChangeSetV2 } from '@shared/types';

export type ReviewChangeSetLike = AgentChangeSet | TaskChangeSet | TaskChangeSetV2;

function encodeFingerprintField(value: string): string {
  return `${value.length}:${value}`;
}

function fingerprintSnippet(snippet: SnippetDiff): string {
  return [
    encodeFingerprintField(normalizePathForComparison(snippet.filePath)),
    encodeFingerprintField(snippet.toolUseId),
    encodeFingerprintField(snippet.timestamp),
    encodeFingerprintField(snippet.type),
    encodeFingerprintField(snippet.oldString),
    encodeFingerprintField(snippet.newString),
    encodeFingerprintField(snippet.replaceAll ? '1' : '0'),
    encodeFingerprintField(snippet.isError ? '1' : '0'),
    encodeFingerprintField(snippet.contextHash ?? ''),
  ].join('|');
}

export function fingerprintReviewChangeSet(changeSet: ReviewChangeSetLike): string {
  return [...changeSet.files]
    .sort((a, b) =>
      normalizePathForComparison(a.filePath).localeCompare(normalizePathForComparison(b.filePath))
    )
    .map((file) =>
      [
        encodeFingerprintField(normalizePathForComparison(file.filePath)),
        ...(file.changeKey ? [encodeFingerprintField(file.changeKey)] : []),
        ...file.snippets.map(fingerprintSnippet),
      ].join('|')
    )
    .join('||');
}

export function getReviewChangeSetIdentityToken(
  changeSet: ReviewChangeSetLike | null | undefined
): string | null {
  if (!changeSet) {
    return null;
  }

  const provenance = 'provenance' in changeSet ? changeSet.provenance : undefined;
  if (provenance?.sourceFingerprint) {
    return `provenance:${provenance.sourceKind}:${provenance.sourceFingerprint}`;
  }

  return `content:${fingerprintReviewChangeSet(changeSet)}`;
}

export function buildReviewDecisionScopeToken(params: {
  mode: 'agent' | 'task';
  taskId?: string;
  memberName?: string;
  requestSignature?: string | null;
  changeSet: ReviewChangeSetLike | null | undefined;
}): string | null {
  const identity = getReviewChangeSetIdentityToken(params.changeSet);
  if (!identity) {
    return null;
  }

  if (params.mode === 'task') {
    return `task:${params.taskId ?? ''}:${params.requestSignature ?? ''}:${identity}`;
  }

  return `agent:${params.memberName ?? ''}:${identity}`;
}
