export interface TeamChangesLoadOptions {
  afterVisibilityRestore?: boolean;
  retryBackfill?: boolean;
  showSpinner?: boolean;
  preserveOnError?: boolean;
  storeSummaries?: boolean;
  reportError?: boolean;
  blockAutoRetryOnError?: boolean;
  maxRequests?: number;
  unknownScanLimit?: number;
  queueDeferredRefresh?: boolean;
  satisfiedTaskIds?: ReadonlySet<string>;
  stagedRefreshPlan?: readonly number[];
}

export function isSilentCounterLoad(options: TeamChangesLoadOptions | null): boolean {
  return Boolean(
    options?.storeSummaries === false &&
    options.reportError === false &&
    options.showSpinner !== true
  );
}
