import type { TaskChangeReviewDiagnostic } from './contracts.js';
import type { EvidenceEvent, EvidenceNotice } from './ledgerTypes.js';
import {
  createTaskChangeDiagnosticFromWarning,
  mergeTaskChangeReviewDiagnostics,
} from './reviewability.js';

export function addReviewDiagnostic(
  diagnostics: TaskChangeReviewDiagnostic[],
  diagnostic: TaskChangeReviewDiagnostic
): void {
  const existingIndex = diagnostics.findIndex(
    (existing) => existing.code === diagnostic.code && existing.message === diagnostic.message
  );
  if (existingIndex >= 0) {
    const existing = diagnostics[existingIndex];
    if (existing) {
      diagnostics[existingIndex] = mergeTaskChangeReviewDiagnostics(existing, diagnostic);
    }
    return;
  }
  diagnostics.push(diagnostic);
}

export function buildReviewDiagnosticsFromWarnings(
  warnings: string[],
  source: TaskChangeReviewDiagnostic['source']
): TaskChangeReviewDiagnostic[] {
  const diagnostics: TaskChangeReviewDiagnostic[] = [];
  for (const warning of warnings) {
    addReviewDiagnostic(diagnostics, createTaskChangeDiagnosticFromWarning(warning, source));
  }
  return diagnostics;
}

export function diagnosticFromNotice(notice: EvidenceNotice): TaskChangeReviewDiagnostic {
  if (notice.code === 'multi-scope-skipped') {
    return {
      code: 'multi_scope_no_safe_diff',
      severity: 'info',
      reviewBlocking: false,
      message:
        'Activity was observed while multiple task scopes were active, so file edits were not safely assigned to this task.',
      source: 'ledger',
    };
  }
  if (notice.code === 'journal-recovered') {
    return {
      code: 'ledger_integrity_recovered',
      severity: 'warning',
      reviewBlocking: true,
      message: 'The task-change ledger was recovered from malformed journal lines.',
      source: 'ledger',
    };
  }
  if (notice.code === 'writer-lock-stolen') {
    return {
      code: 'unsafe_or_untrusted_evidence',
      severity: 'warning',
      reviewBlocking: true,
      message: 'The task-change ledger writer lock changed while evidence was being recorded.',
      source: 'ledger',
    };
  }
  return createTaskChangeDiagnosticFromWarning(notice.message, 'ledger');
}

export function collectReviewDiagnostics(
  events: EvidenceEvent[],
  notices: EvidenceNotice[],
  options: { recovered: boolean }
): TaskChangeReviewDiagnostic[] {
  const diagnostics: TaskChangeReviewDiagnostic[] = [];
  for (const notice of notices) {
    addReviewDiagnostic(diagnostics, diagnosticFromNotice(notice));
  }
  for (const event of events) {
    for (const warning of event.warnings ?? []) {
      addReviewDiagnostic(diagnostics, createTaskChangeDiagnosticFromWarning(warning, 'ledger'));
    }
    if (event.toolStatus === 'failed') {
      addReviewDiagnostic(diagnostics, {
        code: 'tool_failed_after_edit',
        severity: 'warning',
        reviewBlocking: true,
        message: `Tool ${event.toolUseId} failed after changing files.`,
        source: 'ledger',
      });
    }
    if (event.toolStatus === 'killed') {
      addReviewDiagnostic(diagnostics, {
        code: 'tool_killed_after_edit',
        severity: 'warning',
        reviewBlocking: true,
        message: `Background tool ${event.toolUseId} was killed after changing files.`,
        source: 'ledger',
      });
    }
  }
  if (options.recovered) {
    addReviewDiagnostic(diagnostics, {
      code: 'ledger_integrity_recovered',
      severity: 'warning',
      reviewBlocking: true,
      message: 'The task-change ledger was recovered from malformed journal lines.',
      source: 'ledger',
    });
  }
  return diagnostics;
}

export function withSummaryStateDiagnostics(
  diagnostics: TaskChangeReviewDiagnostic[],
  state: {
    integrity?: 'ok' | 'recovered' | 'partial';
    diffStatCompleteness?: 'complete' | 'partial';
  }
): TaskChangeReviewDiagnostic[] {
  const next = [...diagnostics];
  if (state.diffStatCompleteness === 'partial') {
    addReviewDiagnostic(next, {
      code: 'diff_stat_partial',
      severity: 'warning',
      reviewBlocking: true,
      message: 'Some file change statistics are incomplete.',
      source: 'summary',
    });
  }
  if (state.integrity === 'partial') {
    addReviewDiagnostic(next, {
      code: 'ledger_integrity_partial',
      severity: 'warning',
      reviewBlocking: true,
      message: 'The task-change ledger is partially available.',
      source: 'ledger',
    });
  } else if (state.integrity === 'recovered') {
    addReviewDiagnostic(next, {
      code: 'ledger_integrity_recovered',
      severity: 'warning',
      reviewBlocking: true,
      message: 'The task-change ledger was recovered from malformed journal lines.',
      source: 'ledger',
    });
  }
  return next;
}

export function collectWarnings(
  events: EvidenceEvent[],
  notices: EvidenceNotice[],
  options: { recovered: boolean }
): string[] {
  const warnings = new Set<string>();
  for (const notice of notices) warnings.add(notice.message);
  for (const event of events) {
    for (const warning of event.warnings ?? []) warnings.add(warning);
    if (event.toolStatus === 'failed') {
      warnings.add(`Tool ${event.toolUseId} failed after changing files.`);
    }
    if (event.toolStatus === 'killed') {
      warnings.add(`Background tool ${event.toolUseId} was killed after changing files.`);
    }
  }
  if (options.recovered) {
    warnings.add('Task change ledger recovered from malformed journal lines.');
  }
  return [...warnings];
}
