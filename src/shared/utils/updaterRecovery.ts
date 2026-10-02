/** Recovery policy for updater diagnostics. Unknown failures remain generic. */
export type UpdaterFailureKind = 'signature' | 'network' | 'generic';

export const APP_DOWNLOAD_URL = 'https://agentteams.live/#download';

export function classifyUpdaterFailure(error: string): UpdaterFailureKind {
  if (
    /ERR_UPDATER_INVALID_SIGNATURE|improperly signed|code signature|codesign|signature (?:verification|validation|mismatch)|(?:signing|team) (?:identity|identifier).*(?:mismatch|differ|does not match|doesn't match|did not match)|failed to satisfy specified code requirement/i.test(
      error
    )
  ) {
    return 'signature';
  }

  const networkCode =
    /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ERR_NETWORK|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_RESET|ERR_CONNECTION_TIMED_OUT)\b/i;
  const networkMessage = /network (?:error|failure)|(?:request|connection) timed out/i;
  const httpStatus = /(?:HTTP(?: status)?|status(?: code)?|server returned)\s*(?:429|5\d\d)\b/i;
  const separatedHttpStatus =
    /(?:HTTP(?: status)?|status(?: code)?|server returned)\s*[:=]\s*(?:429|5\d\d)\b/i;
  const leadingHttpStatus = /^(?:429|5\d\d) [a-z]/i;

  if (
    networkCode.test(error) ||
    networkMessage.test(error) ||
    httpStatus.test(error) ||
    separatedHttpStatus.test(error) ||
    leadingHttpStatus.test(error)
  ) {
    return 'network';
  }

  return 'generic';
}
