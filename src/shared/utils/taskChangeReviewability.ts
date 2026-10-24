/** Compatibility entrypoint; the portable package owns the canonical implementation. */
export {
  EMPTY_INTERVAL_NO_EDITS_WARNING,
  createTaskChangeDiagnosticFromWarning,
  mergeTaskChangeReviewDiagnostics,
  classifyTaskChangeReviewability,
} from '@agent-teams/task-change-ledger/reviewability';
