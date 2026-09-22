import type { TokenUsageRunDto, TokenUsageRunSourceDto } from '../../contracts';
import type { TokenUsageRunSourceDiscoveryPort } from '../../core/application';

export class CompositeTokenUsageRunSourceDiscovery implements TokenUsageRunSourceDiscoveryPort {
  constructor(private readonly sources: readonly TokenUsageRunSourceDiscoveryPort[]) {}

  async discoverAppRuns(): Promise<TokenUsageRunDto[]> {
    const runs = (await Promise.all(this.sources.map((source) => source.discoverAppRuns()))).flat();
    return mergeRunsByNativeSession(runs);
  }
}

function mergeRunsByNativeSession(runs: readonly TokenUsageRunDto[]): TokenUsageRunDto[] {
  const merged = new Map<string, TokenUsageRunDto>();
  for (const run of runs) {
    const sessionId = run.sources.find((source) => source.nativeSessionId)?.nativeSessionId;
    const identity = sessionId
      ? `${run.teamName ?? ''}\0${run.agentName ?? ''}\0${sessionId}`
      : `run\0${run.appRunId}`;
    const existing = merged.get(identity);
    if (!existing) {
      merged.set(identity, run);
      continue;
    }
    const preferred = preferRun(existing, run);
    const supplemental = preferred === existing ? run : existing;
    const sources = mergeSources(preferred.sources, supplemental.sources, preferred.appRunId);
    merged.set(identity, {
      ...supplemental,
      ...preferred,
      billingMode:
        preferred.billingMode && preferred.billingMode !== 'unknown'
          ? preferred.billingMode
          : supplemental.billingMode,
      model: preferred.model ?? supplemental.model,
      providerBackendId: preferred.providerBackendId ?? supplemental.providerBackendId,
      sources,
    });
  }
  return [...merged.values()];
}

function preferRun(left: TokenUsageRunDto, right: TokenUsageRunDto): TokenUsageRunDto {
  const leftHasDatabase = left.sources.some((source) =>
    source.nativeLogPath?.endsWith('opencode.db')
  );
  const rightHasDatabase = right.sources.some((source) =>
    source.nativeLogPath?.endsWith('opencode.db')
  );
  if (left.source === 'team_launch_state' && right.source !== 'team_launch_state') return left;
  if (right.source === 'team_launch_state' && left.source !== 'team_launch_state') return right;
  if (leftHasDatabase !== rightHasDatabase) return leftHasDatabase ? left : right;
  return left;
}

function mergeSources(
  preferred: readonly TokenUsageRunSourceDto[],
  supplemental: readonly TokenUsageRunSourceDto[],
  appRunId: string
): TokenUsageRunSourceDto[] {
  const sources = new Map<string, TokenUsageRunSourceDto>();
  for (const source of [...supplemental, ...preferred]) {
    const key = source.nativeSessionId ?? source.id;
    const existing = sources.get(key);
    const next = { ...source, appRunId };
    if (
      !existing ||
      (!existing.nativeLogPath?.endsWith('opencode.db') &&
        next.nativeLogPath?.endsWith('opencode.db'))
    ) {
      sources.set(key, next);
    }
  }
  return [...sources.values()];
}
