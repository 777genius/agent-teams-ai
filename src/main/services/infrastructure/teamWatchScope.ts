/**
 * Decides which teams' team-root and task artifacts should be file-watched.
 *
 * The scope is (teams with a live runtime run) ∪ (teams recently engaged in the
 * UI). FileWatcher always watches the teams root and every team's `inboxes/`
 * regardless of this scope, so cross-team message delivery, the lead inbox→stdin
 * relay, and notifications are unaffected. This module only narrows the heavier
 * per-team team-root (config/kanban/processes/meta) and task watching, which
 * otherwise scales with the number of teams on disk and dominates startup cost.
 *
 * Module-level state mirrors the existing IPC/registry singletons in this layer.
 */

const ENGAGED_TTL_MS = 5 * 60_000;

const engagedAtByTeam = new Map<string, number>();
let aliveTeamsProvider: (() => Iterable<string>) | null = null;
let scopeChangeListener: (() => void) | null = null;

export function setAliveTeamsProvider(provider: (() => Iterable<string>) | null): void {
  aliveTeamsProvider = provider;
}

export function setTeamWatchScopeChangeListener(listener: (() => void) | null): void {
  scopeChangeListener = listener;
}

export function notifyTeamWatchScopeChanged(): void {
  scopeChangeListener?.();
}

function collectAliveTeams(scope: Set<string>): boolean {
  if (!aliveTeamsProvider) {
    return true;
  }
  try {
    for (const teamName of aliveTeamsProvider()) {
      if (teamName) {
        scope.add(teamName);
      }
    }
    return true;
  } catch {
    // A provider failure must never narrow watching. Returning null below is the
    // safe fallback: watch every team, matching the original behavior.
    return false;
  }
}

/**
 * Current set of teams whose team-root/task artifacts should be watched. Prunes
 * engaged entries past their TTL as a side effect of being called.
 */
export function computeTeamWatchScope(nowMs: number = Date.now()): ReadonlySet<string> | null {
  const scope = new Set<string>();
  if (!collectAliveTeams(scope)) {
    return null;
  }
  for (const [teamName, engagedAt] of engagedAtByTeam) {
    if (nowMs - engagedAt <= ENGAGED_TTL_MS) {
      scope.add(teamName);
    } else {
      engagedAtByTeam.delete(teamName);
    }
  }
  return scope;
}

/**
 * Mark a team as engaged in the UI (opened or refreshed). Notifies the scope
 * change listener only when this newly brings the team into scope, so repeated
 * calls for an already-watched team stay cheap and do not churn the watcher.
 */
export function markTeamEngaged(teamName: string, nowMs: number = Date.now()): void {
  if (!teamName) {
    return;
  }
  const currentScope = computeTeamWatchScope(nowMs);
  const wasInScope = currentScope?.has(teamName) === true;
  engagedAtByTeam.set(teamName, nowMs);
  if (!wasInScope) {
    scopeChangeListener?.();
  }
}

/** Test helper: clear engaged state and wiring. */
export function resetTeamWatchScopeForTests(): void {
  engagedAtByTeam.clear();
  aliveTeamsProvider = null;
  scopeChangeListener = null;
}
