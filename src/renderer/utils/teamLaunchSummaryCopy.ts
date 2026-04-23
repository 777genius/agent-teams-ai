export function buildPendingRuntimeSummaryCopy(input: {
  confirmedCount?: number | null;
  expectedMemberCount?: number | null;
  memberCount?: number | null;
  runtimeAlivePendingCount?: number | null;
  includePeriod?: boolean;
}): string {
  const pendingCount = input.runtimeAlivePendingCount ?? 0;
  if (pendingCount <= 0) {
    return input.includePeriod
      ? 'Last launch is still reconciling.'
      : 'Last launch is still reconciling';
  }
  const expectedCount = input.expectedMemberCount ?? input.memberCount ?? 0;
  const message = `Last launch is still reconciling - ${input.confirmedCount ?? 0}/${expectedCount} teammates confirmed alive, ${pendingCount} runtime${pendingCount === 1 ? '' : 's'} still awaiting confirmation`;
  return input.includePeriod ? `${message}.` : message;
}
