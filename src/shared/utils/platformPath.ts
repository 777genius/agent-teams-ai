/** Compatibility entrypoint; the portable package owns the canonical implementation. */
export {
  splitPath,
  isWindowsishPath,
  isAbsoluteOrHomePath,
  normalizePathForComparison,
  stripTrailingSeparators,
  getPreferredSeparator,
  joinPath,
  isPathPrefix,
  getRelativePathWithinPrefix,
  getBasename,
  getDirname,
  lastSeparatorIndex,
} from '@agent-teams/task-change-ledger/platform-path';
