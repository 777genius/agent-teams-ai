const KNOWN = new Set([
  'outside-workspace',
  'metadata-path',
  'background-tool',
  'byte-cap',
  'path-cap',
  'symlink',
  'not-directory',
  'nested-workspace',
  'unsupported-file',
  'external-change',
  'read-error',
  'binary',
]);
export const MAX_SNAPSHOT_WARNING_CODES = 16;

/** No raw Git error/path/output is copied into durable capture diagnostics. */
export function snapshotWarningCodes(warnings: readonly string[]): readonly string[] {
  const codes = new Set<string>();
  for (const warning of warnings.slice(0, 64)) {
    const code = KNOWN.has(warning)
      ? warning
      : warning.startsWith('git ') && warning.includes(' timed out after ')
        ? 'git-timeout'
        : warning.startsWith('git ') && warning.includes(' failed to start: ')
          ? 'git-start-failed'
          : warning.startsWith('git ') && warning.includes(' output exceeded ')
            ? 'git-output-cap'
            : warning.includes('path cap reached')
              ? 'git-path-cap'
              : warning === 'Git workspace census unavailable or partial.'
                ? 'git-census-unavailable'
                : warning === 'Unable to read git status for task-change ledger.'
                  ? 'git-status-unavailable'
                  : warning.startsWith('git ') || warning === 'Git workspace census partial record.'
                    ? 'git-record-incomplete'
                    : 'snapshot-warning-unknown';
    codes.add(code);
  }
  const result = [...codes];
  return warnings.length > 64 || result.length > MAX_SNAPSHOT_WARNING_CODES
    ? [...result.slice(0, MAX_SNAPSHOT_WARNING_CODES - 1), 'snapshot-warning-cap']
    : result;
}
