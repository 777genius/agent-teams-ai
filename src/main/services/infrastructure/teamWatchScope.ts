/**
 * Decides which team artifacts should be file-watched.
 *
 * Team root/task scope is (teams with a live runtime run) + (teams recently
 * engaged in the UI). Inbox scope uses the same bounded set. A newly launched
 * team can start assigning work before provisioning publishes final `ready`,
 * so excluding the engaged launch window would lose those inbox events and can
 * deadlock an OpenCode teammate waiting for its first task.
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
 * Current bounded set of teams whose inboxes should be watched for live
 * delivery. Recently engaged teams are included because create/launch can
 * produce actionable inbox messages before the run is promoted to `ready`.
 * The engagement TTL still keeps historical idle teams out of the watch set.
 */
export function computeLiveTeamWatchScope(nowMs: number = Date.now()): ReadonlySet<string> | null {
  return computeTeamWatchScope(nowMs);
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
