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

  // A specific HTTP response takes precedence over generic network wording.
  const httpStatus = /(?:HTTP(?: status)?|status(?: code)?|server returned)\s*(\d{3})\b/i;
  const separatedHttpStatus =
    /(?:HTTP(?: status)?|status(?: code)?|server returned)\s*[:=]\s*(\d{3})\b/i;
  const leadingHttpStatus = /^(\d{3}) [a-z]/i;
  const httpMatch =
    httpStatus.exec(error) ?? separatedHttpStatus.exec(error) ?? leadingHttpStatus.exec(error);
  if (httpMatch) {
    const statusCode = Number(httpMatch[1]);
    return statusCode === 429 || (statusCode >= 500 && statusCode < 600) ? 'network' : 'generic';
  }

  const networkCode =
    /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ERR_NETWORK|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_RESET|ERR_CONNECTION_TIMED_OUT)\b/i;
  const networkMessage = /network (?:error|failure)|(?:request|connection) timed out/i;
  if (networkCode.test(error) || networkMessage.test(error)) {
    return 'network';
  }

  return 'generic';
}
