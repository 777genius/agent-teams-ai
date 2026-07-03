/**
 * Decides which team artifacts should be file-watched.
 *
 * Team root/task scope is (teams with a live runtime run) + (teams recently
 * engaged in the UI). Inbox scope is stricter: only teams with a live runtime
 * run. That keeps the expensive per-inbox file watchers tied to teams that can
 * actually produce live runtime activity, while opened idle teams still get
 * their root/task artifacts watched for UI refreshes.
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
 * Current set of teams whose inboxes should be watched live. Inbox writes only
 * need immediate watcher delivery while a runtime is alive; otherwise the next
 * launch or explicit team read can catch up from disk without holding one fd per
 * inbox file for every historical team.
 */
export function computeLiveTeamWatchScope(): ReadonlySet<string> | null {
  const scope = new Set<string>();
  return collectAliveTeams(scope) ? scope : null;
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
