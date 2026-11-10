/** Compatibility entrypoint; the portable package owns the canonical implementation. */
export {
  classifyTaskChangeReviewability,
  createTaskChangeDiagnosticFromWarning,
  EMPTY_INTERVAL_NO_EDITS_WARNING,
  mergeTaskChangeReviewDiagnostics,
} from '@agent-teams/task-change-ledger/reviewability';
