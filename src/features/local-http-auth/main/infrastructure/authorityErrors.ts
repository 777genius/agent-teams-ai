/** A failed optional discovery refresh left this exact committed generation intact. */
export class RetainedApiPublicationError extends Error {
  constructor(
    readonly referencePath: string,
    cause: unknown,
  ) {
    super('API manual discovery refresh failed; committed authority retained', {
      cause,
    });
    this.name = 'RetainedApiPublicationError';
  }
}
