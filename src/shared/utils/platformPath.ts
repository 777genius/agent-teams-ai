/** Compatibility entrypoint; the portable package owns the canonical implementation. */
export {
  getBasename,
  getDirname,
  getPreferredSeparator,
  getRelativePathWithinPrefix,
  isAbsoluteOrHomePath,
  isPathPrefix,
  isWindowsishPath,
  joinPath,
  lastSeparatorIndex,
  normalizePathForComparison,
  splitPath,
  stripTrailingSeparators,
} from '@agent-teams/task-change-ledger/platform-path';
