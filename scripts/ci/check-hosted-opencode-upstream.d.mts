export interface HostedOpenCodeUpstreamResult {
  readonly drifted: boolean;
  readonly latestTag: string;
  readonly latestUrl: string;
  readonly pinnedTag: string;
}

export function compareVersions(left: readonly number[], right: readonly number[]): number;

export function inspectOpenCodeUpstream(
  lock: unknown,
  release: unknown
): HostedOpenCodeUpstreamResult;

export function renderReport(result: HostedOpenCodeUpstreamResult): string;
