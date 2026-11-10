/**
 * User-facing validation failure raised before a team launch starts
 * (provider compatibility, member limits, model/effort selection).
 *
 * The HTTP layer matches this by `error.name` (like RuntimeStaleEvidenceError)
 * so it can map the failure to 422 and return the message verbatim instead of
 * an opaque "Internal server error".
 */
export class TeamLaunchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamLaunchValidationError';
  }
}
