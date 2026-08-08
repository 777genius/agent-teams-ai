import { isLeadMember } from '@shared/utils/leadDetection';

import type { TeamConfig, TeamSummary } from '@shared/types';

function normalizeProjectPathCandidate(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isSupportedConfigForMutation(
  value: unknown
): value is TeamConfig & Record<string, unknown> {
  if (!isJsonRecord(value) || typeof value.name !== 'string' || value.name.trim() === '') {
    return false;
  }
  return (
    value.members === undefined ||
    (Array.isArray(value.members) &&
      value.members.every((member) => isJsonRecord(member) && typeof member.name === 'string'))
  );
}

export function resolveProjectPathFromConfig(
  config: Pick<TeamConfig, 'projectPath' | 'projectPathHistory' | 'members'>
): string | undefined {
  const direct = normalizeProjectPathCandidate(config.projectPath);
  if (direct) {
    return direct;
  }

  const leadMemberCwd = (config.members ?? []).find((member) => isLeadMember(member))?.cwd;
  const leadResolved = normalizeProjectPathCandidate(leadMemberCwd);
  if (leadResolved) {
    return leadResolved;
  }

  const distinctMemberCwds = Array.from(
    new Set(
      (config.members ?? [])
        .map((member) => normalizeProjectPathCandidate(member.cwd))
        .filter((cwd): cwd is string => Boolean(cwd))
    )
  );
  if (distinctMemberCwds.length === 1) {
    return distinctMemberCwds[0];
  }

  if (Array.isArray(config.projectPathHistory)) {
    for (let i = config.projectPathHistory.length - 1; i >= 0; i--) {
      const historyValue = normalizeProjectPathCandidate(config.projectPathHistory[i]);
      if (historyValue) {
        return historyValue;
      }
    }
  }

  return undefined;
}

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = new Array(workerCount).fill(0).map(async () => {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export function withReadTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Team config read timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function cloneConfig(config: TeamConfig): TeamConfig {
  return structuredClone(config);
}

export function cloneTeamSummaries(teams: readonly TeamSummary[]): TeamSummary[] {
  return structuredClone([...teams]);
}

// Deep-freeze a team-summary snapshot so it can be shared by every listTeams() reader
// (and concurrent in-flight awaiters) instead of deep-cloning all summaries on every
// call -- that per-read structuredClone was the single largest memory allocator during
// launch. Consumers treat the result as read-only (audited: all iterate / map / filter
// / serialize, none mutate), and freezing turns any stray future mutation into a loud
// error instead of silent cross-caller corruption.
export function freezeTeamSummariesDeep(teams: TeamSummary[]): TeamSummary[] {
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
      return;
    }
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      freeze(nested);
    }
  };
  freeze(teams);
  return teams;
}

export function classifyConfigReadTiming(timing: {
  statMs: number | null;
  readMs: number | null;
  parseMs: number | null;
}): string {
  const statMs = timing.statMs ?? 0;
  const readMs = timing.readMs ?? 0;
  const parseMs = timing.parseMs ?? 0;
  if (readMs >= 1_000 && readMs >= statMs * 2 && readMs >= parseMs * 2) {
    return 'io_read_slow';
  }
  if (statMs >= 1_000 && statMs >= readMs * 2 && statMs >= parseMs * 2) {
    return 'io_stat_slow';
  }
  if (parseMs >= 500 && parseMs >= readMs && parseMs >= statMs) {
    return 'json_parse_slow';
  }
  if (statMs + readMs >= 1_000) {
    return 'filesystem_pressure';
  }
  return 'mixed_or_unknown';
}

export function captureConfigReadCaller(): string | null {
  const stack = new Error().stack?.split('\n').slice(2) ?? [];
  const frame = stack.find((line) => {
    const normalized = line.trim();
    return (
      normalized.length > 0 &&
      !normalized.includes('TeamConfigReader.') &&
      !normalized.includes('TeamConfigReader.ts') &&
      !normalized.includes('captureConfigReadCaller') &&
      !normalized.includes('node:internal')
    );
  });
  return frame?.trim().slice(0, 240) ?? null;
}
