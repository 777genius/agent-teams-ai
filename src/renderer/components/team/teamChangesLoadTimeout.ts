// Main-process team summary batches have a 30s deadline; keep the renderer guard above it.
export const TEAM_CHANGES_LOAD_TIMEOUT_MS = 35_000;

export function withTeamChangesLoadTimeout<T>(
  promise: Promise<T>,
  timeoutMs = TEAM_CHANGES_LOAD_TIMEOUT_MS
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('Team changes request timed out. Refresh to try again.'));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  });
}
