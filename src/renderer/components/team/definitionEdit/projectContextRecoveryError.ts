/** IPC failures retain their structured refusal independently of the translated notice text. */
export function isProjectContextRecoveryError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('failure' in error)) return false;
  const failure = error.failure;
  return Boolean(
    failure &&
    typeof failure === 'object' &&
    'code' in failure &&
    failure.code === 'TEAM_PROJECT_CONTEXT_UNRECONCILED'
  );
}
