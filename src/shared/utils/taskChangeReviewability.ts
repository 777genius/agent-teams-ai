import { TASK_CHANGE_DIAGNOSTIC_CODES } from '../types/review';

import type {
  TaskChangeDiagnosticCode,
  TaskChangeDiagnosticSeverity,
  TaskChangeReviewabilityStatus,
  TaskChangeReviewDiagnostic,
  TaskChangeSetV2,
} from '../types';

export const EMPTY_INTERVAL_NO_EDITS_WARNING =
  'No file edits found within persisted workIntervals.';

const MULTI_SCOPE_MESSAGES = [
  'Task change ledger skipped attribution because multiple task scopes were active.',
  'Ledger skipped attribution because multiple task scopes were active.',
] as const;
const TASK_CHANGE_DIAGNOSTIC_CODE_SET = new Set<string>(TASK_CHANGE_DIAGNOSTIC_CODES);

type ReviewabilityInput = Pick<
  TaskChangeSetV2,
  'files' | 'totalFiles' | 'confidence' | 'warnings' | 'scope'
> &
  Partial<Pick<TaskChangeSetV2, 'diffStatCompleteness' | 'provenance' | 'reviewDiagnostics'>>;

interface DiagnosticTemplate {
  code: TaskChangeDiagnosticCode;
  severity: TaskChangeDiagnosticSeverity;
  reviewBlocking: boolean;
  message: string;
}

function templateForLegacyWarning(warning: string): DiagnosticTemplate {
  const trimmed = warning.trim();
  const normalized = trimmed.toLowerCase();

  if (MULTI_SCOPE_MESSAGES.some((message) => message.toLowerCase() === normalized)) {
    return {
      code: 'multi_scope_no_safe_diff',
      severity: 'info',
      reviewBlocking: false,
      message:
        'Activity was observed while multiple task scopes were active, so file edits were not safely assigned to this task.',
    };
  }

  if (normalized === EMPTY_INTERVAL_NO_EDITS_WARNING.toLowerCase()) {
    return {
      code: 'active_task_no_edits_yet',
      severity: 'info',
      reviewBlocking: false,
      message: 'No file edits have been observed in the active task interval yet.',
    };
  }

  if (normalized.includes('timed out')) {
    return {
      code: 'summary_timeout',
      severity: 'warning',
      reviewBlocking: true,
      message: 'The changes scan timed out before it could finish.',
    };
  }

  if (normalized.includes('fell back to journal reconstruction')) {
    return {
      code: 'summary_reconstructed',
      severity: 'info',
      reviewBlocking: false,
      message: 'The change summary was reconstructed from the task-change journal.',
    };
  }

  if (normalized.includes('journal was unavailable')) {
    return {
      code: 'journal_unavailable',
      severity: 'warning',
      reviewBlocking: true,
      message: 'Detailed ledger entries were unavailable for this task.',
    };
  }

  if (normalized.includes('recovered from malformed journal lines')) {
    return {
      code: 'ledger_integrity_recovered',
      severity: 'warning',
      reviewBlocking: true,
      message: 'The task-change ledger was recovered from malformed journal lines.',
    };
  }

  if (
    normalized.includes('freshness did not match') ||
    normalized.includes('partial') ||
    normalized.includes('integrity')
  ) {
    return {
      code: 'ledger_integrity_partial',
      severity: 'warning',
      reviewBlocking: true,
      message: 'The task-change ledger may be incomplete or stale.',
    };
  }

  if (normalized.startsWith('tool ') && normalized.includes(' failed after changing files')) {
    return {
      code: 'tool_failed_after_edit',
      severity: 'warning',
      reviewBlocking: true,
      message: 'A tool failed after changing files.',
    };
  }

  if (
    normalized.startsWith('background tool ') &&
    normalized.includes(' was killed after changing files')
  ) {
    return {
      code: 'tool_killed_after_edit',
      severity: 'warning',
      reviewBlocking: true,
      message: 'A background tool was killed after changing files.',
    };
  }

  return {
    code: 'legacy_warning',
    severity: 'warning',
    reviewBlocking: true,
    message: trimmed || 'The change summary reported an unclassified warning.',
  };
}

export function createTaskChangeDiagnosticFromWarning(
  warning: string,
  source: TaskChangeReviewDiagnostic['source'] = 'legacy'
): TaskChangeReviewDiagnostic {
  const template = templateForLegacyWarning(warning);
  return { ...template, source };
}

function diagnosticKey(diagnostic: TaskChangeReviewDiagnostic): string {
  return `${diagnostic.code}:${diagnostic.message}`;
}

function diagnosticSeverityRank(severity: TaskChangeDiagnosticSeverity): number {
  switch (severity) {
    case 'error':
      return 3;
    case 'warning':
      return 2;
    case 'info':
      return 1;
  }
}

export function mergeTaskChangeReviewDiagnostics(
  existing: TaskChangeReviewDiagnostic,
  incoming: TaskChangeReviewDiagnostic
): TaskChangeReviewDiagnostic {
  if (
    incoming.reviewBlocking &&
    (!existing.reviewBlocking ||
      diagnosticSeverityRank(incoming.severity) > diagnosticSeverityRank(existing.severity))
  ) {
    return incoming;
  }
  if (
    existing.reviewBlocking === incoming.reviewBlocking &&
    diagnosticSeverityRank(incoming.severity) > diagnosticSeverityRank(existing.severity)
  ) {
    return incoming;
  }
  return existing;
}

function addDiagnostic(
  diagnostics: Map<string, TaskChangeReviewDiagnostic>,
  diagnostic: TaskChangeReviewDiagnostic
): void {
  const key = diagnosticKey(diagnostic);
  const existing = diagnostics.get(key);
  if (existing) {
    diagnostics.set(key, mergeTaskChangeReviewDiagnostics(existing, diagnostic));
  } else {
    diagnostics.set(key, diagnostic);
  }
}

function getInputFiles(input: ReviewabilityInput): TaskChangeSetV2['files'] {
  return Array.isArray(input.files) ? input.files : [];
}

function getInputWarnings(input: ReviewabilityInput): string[] {
  return Array.isArray(input.warnings)
    ? input.warnings.filter((warning): warning is string => typeof warning === 'string')
    : [];
}

function isTaskChangeDiagnosticSeverity(value: unknown): value is TaskChangeDiagnosticSeverity {
  return value === 'info' || value === 'warning' || value === 'error';
}

function isTaskChangeDiagnosticSource(
  value: unknown
): value is NonNullable<TaskChangeReviewDiagnostic['source']> {
  return value === 'ledger' || value === 'legacy' || value === 'summary' || value === 'runtime';
}

function normalizeReviewDiagnosticInput(value: unknown): TaskChangeReviewDiagnostic | null {
  if (typeof value === 'string') {
    const message = value.trim();
    return message ? createTaskChangeDiagnosticFromWarning(message) : null;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Partial<TaskChangeReviewDiagnostic>;
  const message = typeof candidate.message === 'string' ? candidate.message.trim() : '';
  if (!message) {
    return null;
  }

  const source = isTaskChangeDiagnosticSource(candidate.source) ? { source: candidate.source } : {};
  if (
    typeof candidate.code === 'string' &&
    TASK_CHANGE_DIAGNOSTIC_CODE_SET.has(candidate.code) &&
    isTaskChangeDiagnosticSeverity(candidate.severity) &&
    typeof candidate.reviewBlocking === 'boolean'
  ) {
    return {
      code: candidate.code,
      severity: candidate.severity,
      reviewBlocking: candidate.reviewBlocking,
      message,
      ...source,
    };
  }

  return {
    code: 'legacy_warning',
    severity: 'warning',
    reviewBlocking: true,
    message,
    ...source,
  };
}

function getInputReviewDiagnostics(input: ReviewabilityInput): TaskChangeReviewDiagnostic[] {
  if (!Array.isArray(input.reviewDiagnostics)) {
    return [];
  }
  return input.reviewDiagnostics
    .map(normalizeReviewDiagnosticInput)
    .filter((diagnostic): diagnostic is TaskChangeReviewDiagnostic => diagnostic !== null);
}

function getInputToolUseIds(input: ReviewabilityInput): string[] {
  const scope = input.scope as Partial<TaskChangeSetV2['scope']> | undefined;
  return Array.isArray(scope?.toolUseIds) ? scope.toolUseIds : [];
}

function getInputStartTimestamp(input: ReviewabilityInput): string {
  const scope = input.scope as Partial<TaskChangeSetV2['scope']> | undefined;
  return typeof scope?.startTimestamp === 'string' ? scope.startTimestamp : '';
}

function getInputEndTimestamp(input: ReviewabilityInput): string {
  const scope = input.scope as Partial<TaskChangeSetV2['scope']> | undefined;
  return typeof scope?.endTimestamp === 'string' ? scope.endTimestamp : '';
}

function getInputTotalFiles(input: ReviewabilityInput, fileCount: number): number {
  const totalFiles = Number(input.totalFiles);
  if (!Number.isFinite(totalFiles) || totalFiles < 0) {
    return fileCount;
  }
  return Math.trunc(totalFiles);
}

function collectDiagnostics(input: ReviewabilityInput): TaskChangeReviewDiagnostic[] {
  const diagnostics = new Map<string, TaskChangeReviewDiagnostic>();

  for (const diagnostic of getInputReviewDiagnostics(input)) {
    addDiagnostic(diagnostics, diagnostic);
  }

  for (const warning of getInputWarnings(input)) {
    const diagnostic = createTaskChangeDiagnosticFromWarning(warning);
    addDiagnostic(diagnostics, diagnostic);
  }

  if (input.diffStatCompleteness === 'partial') {
    const diagnostic: TaskChangeReviewDiagnostic = {
      code: 'diff_stat_partial',
      severity: 'warning',
      reviewBlocking: true,
      message: 'Some file change statistics are incomplete.',
      source: 'summary',
    };
    addDiagnostic(diagnostics, diagnostic);
  }

  if (input.provenance?.integrity === 'partial') {
    const diagnostic: TaskChangeReviewDiagnostic = {
      code: 'ledger_integrity_partial',
      severity: 'warning',
      reviewBlocking: true,
      message: 'The task-change ledger is partially available.',
      source: 'ledger',
    };
    addDiagnostic(diagnostics, diagnostic);
  } else if (input.provenance?.integrity === 'recovered') {
    const diagnostic: TaskChangeReviewDiagnostic = {
      code: 'ledger_integrity_recovered',
      severity: 'warning',
      reviewBlocking: true,
      message: 'The task-change ledger was recovered from malformed journal lines.',
      source: 'ledger',
    };
    addDiagnostic(diagnostics, diagnostic);
  }

  const fileCount = getInputFiles(input).length;
  const totalFiles = getInputTotalFiles(input, fileCount);
  if (totalFiles > fileCount) {
    const missingFileCount = totalFiles - fileCount;
    const diagnostic: TaskChangeReviewDiagnostic = {
      code: 'unsafe_or_untrusted_evidence',
      severity: 'warning',
      reviewBlocking: true,
      message:
        missingFileCount === 1
          ? 'The change summary reported one file without safe review details.'
          : `The change summary reported ${missingFileCount} files without safe review details.`,
      source: 'summary',
    };
    addDiagnostic(diagnostics, diagnostic);
  }

  return [...diagnostics.values()];
}

function isActiveIntervalWithoutFileEdits(
  input: ReviewabilityInput,
  diagnostics: TaskChangeReviewDiagnostic[]
): boolean {
  return (
    getInputFiles(input).length === 0 &&
    diagnostics.some((diagnostic) => diagnostic.code === 'active_task_no_edits_yet') &&
    Boolean(getInputStartTimestamp(input)) &&
    !getInputEndTimestamp(input) &&
    getInputToolUseIds(input).length === 0
  );
}

export function classifyTaskChangeReviewability(
  input: ReviewabilityInput
): TaskChangeReviewabilityStatus {
  const diagnostics = collectDiagnostics(input);
  const blockingDiagnostics = diagnostics.filter((diagnostic) => diagnostic.reviewBlocking);
  const hasFiles = getInputFiles(input).length > 0;

  if (blockingDiagnostics.length > 0) {
    return {
      reviewability: 'attention_required',
      reasonCode: 'blocking_diagnostics',
      userAction: hasFiles ? 'review_diff' : 'inspect_diagnostics',
      severity: 'warning',
      message: hasFiles ? 'Changes may be incomplete.' : 'Changes need attention.',
      diagnostics,
    };
  }

  if (isActiveIntervalWithoutFileEdits(input, diagnostics)) {
    return {
      reviewability: 'unknown',
      reasonCode: 'pending_no_edits_yet',
      userAction: 'wait_or_refresh',
      severity: 'none',
      message: 'No file edits have been observed yet.',
      diagnostics,
    };
  }

  if (hasFiles) {
    return {
      reviewability: 'reviewable',
      reasonCode:
        diagnostics.length > 0 ? 'files_changed_with_non_blocking_diagnostics' : 'files_changed',
      userAction: 'review_diff',
      severity: 'success',
      message: 'Reviewable file changes are available.',
      diagnostics,
    };
  }

  if (diagnostics.length > 0) {
    return {
      reviewability: 'diagnostic_only',
      reasonCode: 'diagnostic_only',
      userAction: 'inspect_diagnostics',
      severity: 'info',
      message: 'No safe diff is available for this task.',
      diagnostics,
    };
  }

  if (input.confidence === 'high' || input.confidence === 'medium') {
    return {
      reviewability: 'none',
      reasonCode: 'confirmed_no_changes',
      userAction: 'nothing',
      severity: 'none',
      message: 'No reviewable file changes were found.',
      diagnostics,
    };
  }

  return {
    reviewability: 'unknown',
    reasonCode: 'low_confidence',
    userAction: 'wait_or_refresh',
    severity: 'none',
    message: 'The change summary is not confident enough yet.',
    diagnostics,
  };
}
