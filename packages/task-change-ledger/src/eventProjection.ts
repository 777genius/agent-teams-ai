import { nativeCaptureQualification } from './nativeCaptureProof.js';
import { LedgerFileReader } from './LedgerFileReader.js';
import { TASK_CHANGE_LEDGER_READ_LIMITS } from './artifactPaths.js';
import type { SnippetDiff } from './contracts.js';
import { normalizeLedgerFilePath } from './ledgerPaths.js';
import type { EvidenceEvent } from './ledgerTypes.js';

export async function buildSnippets(
  files: LedgerFileReader,
  projectDir: string,
  events: EvidenceEvent[]
): Promise<SnippetDiff[]> {
  const snippets = new Array<SnippetDiff>(events.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex++;
      if (index >= events.length) return;
      const event = events[index];
      const unqualified = nativeCaptureQualification(event) === 'unqualified';
      const beforeContent = unqualified ? null : await files.readContentRef(projectDir, event.before);
      const afterContent = unqualified ? null : await files.readContentRef(projectDir, event.after);
      snippets[index] = eventToSnippet(event, beforeContent, afterContent);
    }
  };
  await Promise.all(
    Array.from(
      {
        length: Math.min(TASK_CHANGE_LEDGER_READ_LIMITS.blobConcurrency, events.length),
      },
      worker
    )
  );
  return snippets;
}

export function projectJournalEventsForUi<T extends EvidenceEvent>(events: T[]): T[] {
  const selectedBySourceImportKey = new Map<string, { event: T; index: number; rank: number }>();
  const passthrough: { event: T; index: number }[] = [];

  events.forEach((event, index) => {
    const sourceImportKey = sourceImportKeyForEvent(event);
    if (!sourceImportKey) {
      if (event.suppressed !== true) {
        passthrough.push({ event, index });
      }
      return;
    }
    const rank = projectionRankForEvent(event);
    const existing = selectedBySourceImportKey.get(sourceImportKey);
    if (!existing || rank >= existing.rank) {
      selectedBySourceImportKey.set(sourceImportKey, { event, index, rank });
    }
  });

  return [
    ...passthrough,
    ...[...selectedBySourceImportKey.values()]
      .filter(({ event }) => event.suppressed !== true)
      .map(({ event, index }) => ({ event, index })),
  ]
    .sort((left, right) => left.index - right.index)
    .map(({ event }) => event);
}

export function sourceImportKeyForEvent(event: EvidenceEvent): string | null {
  if (
    event.sourceImportKey &&
    (event.sourceRuntime === 'opencode' ||
      event.sourceProvider === 'opencode' ||
      event.source === 'opencode_toolpart_write' ||
      event.source === 'opencode_toolpart_edit' ||
      event.source === 'opencode_toolpart_apply_patch')
  ) {
    return event.sourceImportKey;
  }
  return null;
}

export function projectionRankForEvent(event: EvidenceEvent): number {
  return event.suppressed === true ? Number.MAX_SAFE_INTEGER : evidenceRankForEvent(event);
}

export function evidenceRankForEvent(event: EvidenceEvent): number {
  const hasFullText = hasFullTextEvidence(event);

  switch (event.evidenceProof) {
    case 'opencode-snapshot':
      return hasFullText ? 50 : 35;
    case 'inverse-apply-patch-chain':
    case 'inverse-edit-chain':
    case 'toolpart-chain':
      return hasFullText ? 40 : 25;
    case 'metadata-only-fallback':
      return 10;
    default:
      return hasFullText ? 30 : 5;
  }
}

export function hasFullTextEvidence(
  event: Pick<EvidenceEvent, 'before' | 'after' | 'operation'>
): boolean {
  if (event.operation === 'create') {
    return event.after !== null;
  }
  if (event.operation === 'delete') {
    return event.before !== null;
  }
  return event.before !== null && event.after !== null;
}

export function eventToSnippet(
  event: EvidenceEvent,
  beforeContent: string | null,
  afterContent: string | null
): SnippetDiff {
  const filePath = normalizeLedgerFilePath(event.filePath);
  let nativeCapture = nativeCaptureQualification(event);
  if (nativeCapture === 'qualified' && (afterContent === null ||
    (event.operation === 'modify' && beforeContent === null))) nativeCapture = 'unqualified';
  if (nativeCapture === 'unqualified') { beforeContent = null; afterContent = null; }
  return {
    toolUseId: event.toolUseId,
    filePath,
    toolName: mapToolName(event.source),
    type: mapSnippetType(event),
    oldString: nativeCapture === 'unqualified' ? '' : event.oldString ?? beforeContent ?? '',
    newString: nativeCapture === 'unqualified' ? '' : event.newString ?? afterContent ?? '',
    replaceAll: event.replaceAll ?? false,
    timestamp: event.timestamp,
    isError: false,
    ledger: {
      eventId: event.eventId,
      ...(nativeCapture ? { nativeCapture } : {}),
      ...(event.agentId ? { actorId: event.agentId } : {}),
      ...(event.memberName ? { actorName: event.memberName } : {}),
      ...('taskId' in event ? { taskId: event.taskId } : { inputId: event.inputId }),
      source: event.confidence === 'exact' ? 'ledger-exact' : 'ledger-snapshot',
      confidence: event.confidence,
      originalFullContent: beforeContent,
      modifiedFullContent: afterContent,
      beforeHash: event.before?.sha256 ?? null,
      afterHash: event.after?.sha256 ?? null,
      operation: event.operation,
      beforeState: event.beforeState,
      afterState: event.afterState,
      relation: event.relation,
      executionSeq: event.executionSeq,
      linesAdded: event.linesAdded,
      linesRemoved: event.linesRemoved,
      worktreePath: event.worktreePath,
      worktreeBranch: event.worktreeBranch,
      baseWorkspaceRoot: event.baseWorkspaceRoot,
      dirtyLeaderWarning: event.dirtyLeaderWarning,
      textAvailability:
        beforeContent !== null && afterContent !== null
          ? 'full-text'
          : event.oldString !== undefined || event.newString !== undefined
            ? 'patch-text'
            : 'unavailable',
    },
  };
}

export function mapToolName(eventSource: EvidenceEvent['source']): SnippetDiff['toolName'] {
  switch (eventSource) {
    case 'file_edit':
      return 'Edit';
    case 'file_write':
    case 'opencode_toolpart_write':
      return 'Write';
    case 'notebook_edit':
      return 'NotebookEdit';
    case 'opencode_toolpart_edit':
    case 'opencode_toolpart_apply_patch':
      return 'Edit';
    case 'bash_simulated_sed':
    case 'shell_snapshot':
      return 'Bash';
    case 'powershell_snapshot':
      return 'PowerShell';
    case 'post_tool_hook_snapshot':
      return 'PostToolUse';
  }
}

export function mapSnippetType(event: EvidenceEvent): SnippetDiff['type'] {
  if (event.source === 'file_write' || event.source === 'opencode_toolpart_write') {
    return event.operation === 'create' ? 'write-new' : 'write-update';
  }
  if (event.source === 'notebook_edit') {
    return 'notebook-edit';
  }
  if (event.source === 'shell_snapshot' || event.source === 'powershell_snapshot') {
    return 'shell-snapshot';
  }
  if (event.source === 'post_tool_hook_snapshot') {
    return 'hook-snapshot';
  }
  return 'edit';
}
