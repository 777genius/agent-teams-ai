import type {
  FileChangeSummary,
  FileEditEvent,
  FileEditTimeline,
  LedgerChangeRelation,
  SnippetDiff,
  TaskChangeScope,
} from './contracts.js';
import {
  groupKeyForSnippet,
  normalizeLedgerFilePath,
  normalizeSummaryChangeKey,
  relationChangeKey,
  relationForSnippets,
  relativePath,
  resolveGroupedDisplayPath,
} from './ledgerPaths.js';
import type {
  LedgerEvent,
  LedgerNotice,
  LedgerSummaryFileV2,
  LedgerSummaryScopeV2,
} from './ledgerTypes.js';
import { diffLines } from 'diff';

export function mapV2SummaryFile(
  file: LedgerSummaryFileV2,
  projectPath?: string
): FileChangeSummary {
  const displayPath = file.displayPath ?? file.filePath;
  const filePath = normalizeLedgerFilePath(file.filePath);
  const agentIds = Array.isArray(file.agentIds) ? file.agentIds : [];
  return {
    filePath,
    relativePath: relativePath(displayPath, projectPath, file.relativePath),
    snippets: [],
    linesAdded: file.linesAdded,
    linesRemoved: file.linesRemoved,
    isNewFile: Boolean(
      file.createdInTask && file.latestOperation !== 'delete' && file.relation?.kind !== 'rename'
    ),
    changeKey: normalizeSummaryChangeKey(file),
    diffStatKnown: file.diffStatKnown,
    ledgerSummary: {
      latestOperation: file.latestOperation,
      createdInTask: file.createdInTask,
      deletedInTask: file.deletedInTask,
      contentAvailability: file.contentAvailability,
      reviewability: file.reviewability,
      ...(file.relation ? { relation: file.relation } : {}),
      ...(file.latestBeforeState ? { beforeState: file.latestBeforeState } : {}),
      ...(file.latestAfterState ? { afterState: file.latestAfterState } : {}),
      ...(file.primaryActorKey ? { primaryActorKey: file.primaryActorKey } : {}),
      ...(agentIds.length > 0 ? { agentIds } : {}),
      ...(file.memberNames ? { memberNames: file.memberNames } : {}),
      ...(file.executionSeqRange ? { executionSeqRange: file.executionSeqRange } : {}),
      ...(file.worktreePath ? { worktreePath: file.worktreePath } : {}),
      ...(file.worktreeBranch ? { worktreeBranch: file.worktreeBranch } : {}),
      ...(file.baseWorkspaceRoot ? { baseWorkspaceRoot: file.baseWorkspaceRoot } : {}),
      ...(file.dirtyLeaderWarning ? { dirtyLeaderWarning: file.dirtyLeaderWarning } : {}),
    },
  };
}

export function mapV2Scope(
  taskId: string,
  scope: LedgerSummaryScopeV2,
  files: LedgerSummaryFileV2[]
): TaskChangeScope {
  const agentIds = Array.isArray(scope.agentIds) ? scope.agentIds : [];
  return {
    taskId,
    memberName:
      scope.memberName ||
      scope.primaryMemberName ||
      scope.primaryAgentId ||
      scope.primaryActorKey ||
      '',
    startLine: 0,
    endLine: 0,
    startTimestamp: scope.startTimestamp,
    endTimestamp: scope.endTimestamp,
    toolUseIds: scope.toolUseIds,
    filePaths: files.map((file) => normalizeLedgerFilePath(file.filePath)),
    confidence: scope.confidence,
    ...(scope.primaryActorKey ? { primaryActorKey: scope.primaryActorKey } : {}),
    ...(scope.primaryAgentId ? { primaryAgentId: scope.primaryAgentId } : {}),
    ...(scope.primaryMemberName ? { primaryMemberName: scope.primaryMemberName } : {}),
    ...(agentIds.length > 0 ? { agentIds } : {}),
    ...(scope.memberNames ? { memberNames: scope.memberNames } : {}),
    ...(scope.toolUseCount !== undefined ? { toolUseCount: scope.toolUseCount } : {}),
    ...(scope.toolUseIdsTruncated ? { toolUseIdsTruncated: true } : {}),
    ...(scope.phaseSet ? { phaseSet: scope.phaseSet } : {}),
    ...(scope.executionSeqRange ? { executionSeqRange: scope.executionSeqRange } : {}),
    ...(scope.confidenceBreakdown ? { confidenceBreakdown: scope.confidenceBreakdown } : {}),
    ...(scope.contributors ? { contributors: scope.contributors } : {}),
    ...(scope.worktreePaths ? { worktreePaths: scope.worktreePaths } : {}),
    ...(scope.worktreeBranches ? { worktreeBranches: scope.worktreeBranches } : {}),
    ...(scope.baseWorkspaceRoots ? { baseWorkspaceRoots: scope.baseWorkspaceRoots } : {}),
    ...(scope.dirtyLeaderWarnings ? { dirtyLeaderWarnings: scope.dirtyLeaderWarnings } : {}),
  };
}

export function groupSnippets(
  snippets: SnippetDiff[]
): Map<string, { filePath: string; relation?: LedgerChangeRelation; snippets: SnippetDiff[] }> {
  const grouped = new Map<
    string,
    { filePath: string; relation?: LedgerChangeRelation; snippets: SnippetDiff[] }
  >();
  for (const snippet of snippets) {
    const groupKey = groupKeyForSnippet(snippet);
    const existing = grouped.get(groupKey);
    if (existing) {
      existing.snippets.push(snippet);
    } else {
      grouped.set(groupKey, {
        filePath: snippet.filePath,
        ...(snippet.ledger?.relation ? { relation: snippet.ledger.relation } : {}),
        snippets: [snippet],
      });
    }
  }
  return grouped;
}

export function buildFallbackFilesFromGroupedSnippets(
  grouped: Map<
    string,
    { filePath: string; relation?: LedgerChangeRelation; snippets: SnippetDiff[] }
  >,
  projectPath?: string
): { files: FileChangeSummary[]; totalLinesAdded: number; totalLinesRemoved: number } {
  const files: FileChangeSummary[] = [];
  for (const entry of grouped.values()) {
    const relation = entry.relation ?? relationForSnippets(entry.snippets);
    let linesAdded = 0;
    let linesRemoved = 0;
    for (const snippet of entry.snippets) {
      if (
        typeof snippet.ledger?.linesAdded === 'number' ||
        typeof snippet.ledger?.linesRemoved === 'number'
      ) {
        linesAdded += snippet.ledger?.linesAdded ?? 0;
        linesRemoved += snippet.ledger?.linesRemoved ?? 0;
        continue;
      }
      const { added, removed } = countLineChanges(snippet.oldString, snippet.newString);
      linesAdded += added;
      linesRemoved += removed;
    }
    const displayPath = resolveGroupedDisplayPath(entry.filePath, relation, entry.snippets);
    const worktreeLedger = entry.snippets.find((snippet) => snippet.ledger?.worktreePath)?.ledger;
    const firstLedger = entry.snippets.find((snippet) => snippet.ledger)?.ledger;
    const lastLedger = [...entry.snippets].reverse().find((snippet) => snippet.ledger)?.ledger;
    const baselineExists = firstLedger?.beforeState?.exists;
    const finalExists = lastLedger?.afterState?.exists;
    const isCreatedLifecycle = baselineExists === false && finalExists === true;
    const fallbackIsCreated = entry.snippets.some(
      (snippet) => snippet.type === 'write-new' || snippet.ledger?.operation === 'create'
    );
    files.push({
      filePath: displayPath,
      relativePath: relativePath(displayPath, projectPath),
      snippets: entry.snippets,
      linesAdded,
      linesRemoved,
      isNewFile:
        relation?.kind !== 'rename' &&
        (baselineExists === undefined || finalExists === undefined
          ? fallbackIsCreated
          : isCreatedLifecycle),
      changeKey: relation
        ? relationChangeKey(relation, worktreeLedger?.worktreePath)
        : `path:${displayPath.replace(/\\/g, '/')}`,
      diffStatKnown: true,
      ledgerSummary: {
        ...(relation ? { relation } : {}),
        latestOperation:
          entry.snippets[entry.snippets.length - 1]?.ledger?.operation ??
          (entry.snippets[entry.snippets.length - 1]?.type === 'write-new' ? 'create' : 'modify'),
        ...(worktreeLedger?.worktreePath ? { worktreePath: worktreeLedger.worktreePath } : {}),
        ...(worktreeLedger?.worktreeBranch
          ? { worktreeBranch: worktreeLedger.worktreeBranch }
          : {}),
        ...(worktreeLedger?.baseWorkspaceRoot
          ? { baseWorkspaceRoot: worktreeLedger.baseWorkspaceRoot }
          : {}),
        ...(worktreeLedger?.dirtyLeaderWarning
          ? { dirtyLeaderWarning: worktreeLedger.dirtyLeaderWarning }
          : {}),
      },
      timeline: buildTimeline(displayPath, entry.snippets),
    });
  }
  const totalLinesAdded = files.reduce((sum, file) => sum + file.linesAdded, 0);
  const totalLinesRemoved = files.reduce((sum, file) => sum + file.linesRemoved, 0);
  return { files, totalLinesAdded, totalLinesRemoved };
}

export function buildFallbackScope(
  taskId: string,
  files: FileChangeSummary[],
  events: LedgerEvent[],
  notices: LedgerNotice[]
): TaskChangeScope {
  const primaryMemberName = events.find((event) => event.memberName)?.memberName;
  const primaryAgentId = events.find((event) => event.agentId)?.agentId;
  const worktreePaths = [
    ...new Set(events.flatMap((event) => (event.worktreePath ? [event.worktreePath] : []))),
  ].sort();
  const worktreeBranches = [
    ...new Set(events.flatMap((event) => (event.worktreeBranch ? [event.worktreeBranch] : []))),
  ].sort();
  const baseWorkspaceRoots = [
    ...new Set(
      events.flatMap((event) => (event.baseWorkspaceRoot ? [event.baseWorkspaceRoot] : []))
    ),
  ].sort();
  const dirtyLeaderWarnings = [
    ...new Set(
      events.flatMap((event) => (event.dirtyLeaderWarning ? [event.dirtyLeaderWarning] : []))
    ),
  ].sort();
  return {
    taskId,
    memberName: primaryMemberName ?? primaryAgentId ?? '',
    startLine: 0,
    endLine: 0,
    startTimestamp: events[0]?.timestamp ?? notices[0]?.timestamp ?? '',
    endTimestamp:
      events[events.length - 1]?.timestamp ?? notices[notices.length - 1]?.timestamp ?? '',
    toolUseIds: [
      ...new Set([
        ...events.map((event) => event.toolUseId),
        ...notices.flatMap((notice) => (notice.toolUseId ? [notice.toolUseId] : [])),
      ]),
    ],
    filePaths: files.map((file) => file.filePath),
    confidence: {
      tier: events.some((event) => event.confidence !== 'exact') ? 2 : 1,
      label: events.some((event) => event.confidence !== 'exact') ? 'medium' : 'high',
      reason: 'Scoped by orchestrator task-change ledger',
    },
    ...(primaryMemberName ? { primaryMemberName } : {}),
    ...(primaryAgentId ? { primaryAgentId } : {}),
    ...(events.some((event) => !!event.memberName)
      ? {
          memberNames: [
            ...new Set(events.flatMap((event) => (event.memberName ? [event.memberName] : []))),
          ].sort(),
        }
      : {}),
    ...(events.length > 0
      ? {
          executionSeqRange: {
            start: Math.min(...events.map((event) => event.executionSeq)),
            end: Math.max(...events.map((event) => event.executionSeq)),
          },
        }
      : {}),
    ...(worktreePaths.length > 0 ? { worktreePaths } : {}),
    ...(worktreeBranches.length > 0 ? { worktreeBranches } : {}),
    ...(baseWorkspaceRoots.length > 0 ? { baseWorkspaceRoots } : {}),
    ...(dirtyLeaderWarnings.length > 0 ? { dirtyLeaderWarnings } : {}),
  };
}

export function buildTimeline(filePath: string, snippets: SnippetDiff[]): FileEditTimeline {
  const events: FileEditEvent[] = snippets.map((snippet, index) => {
    const { added, removed } = countLineChanges(snippet.oldString, snippet.newString);
    return {
      toolUseId: snippet.toolUseId,
      toolName: snippet.toolName,
      timestamp: snippet.timestamp,
      summary: summaryForSnippet(snippet, added, removed),
      linesAdded: added,
      linesRemoved: removed,
      snippetIndex: index,
    };
  });
  const firstMs = Date.parse(events[0]?.timestamp ?? '');
  const lastMs = Date.parse(events[events.length - 1]?.timestamp ?? '');
  return {
    filePath,
    events,
    durationMs:
      Number.isFinite(firstMs) && Number.isFinite(lastMs) ? Math.max(0, lastMs - firstMs) : 0,
  };
}

export function summaryForSnippet(snippet: SnippetDiff, added: number, removed: number): string {
  if (snippet.type === 'write-new') return `Created file (${added} lines)`;
  if (snippet.type === 'write-update') return `Rewrote file (+${added}/-${removed})`;
  if (snippet.type === 'shell-snapshot') {
    return `${snippet.toolName === 'PowerShell' ? 'PowerShell' : 'Shell'} changed file (+${added}/-${removed})`;
  }
  if (snippet.type === 'hook-snapshot') return `Hook changed file (+${added}/-${removed})`;
  if (snippet.type === 'notebook-edit') return `Edited notebook (+${added}/-${removed})`;
  return `Edited file (+${added}/-${removed})`;
}

export function countLineChanges(
  before: string,
  after: string
): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const change of diffLines(before, after)) {
    if (change.added) added += change.count ?? 0;
    if (change.removed) removed += change.count ?? 0;
  }
  return { added, removed };
}
