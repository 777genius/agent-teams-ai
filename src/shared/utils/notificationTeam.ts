/**
 * Resolves which team an in-app notification belongs to.
 * Team events use `sessionId: team:{name}`, `projectId: {name}`, and optional `target.teamName`.
 */

export interface NotificationTeamIdentity {
  sessionId?: string | null;
  projectId?: string;
  category?: string;
  target?: unknown;
}

function readTargetTeamName(target: unknown): string | null {
  if (!target || typeof target !== 'object') {
    return null;
  }
  const teamName = 'teamName' in target ? target.teamName : undefined;
  return typeof teamName === 'string' && teamName.trim() ? teamName.trim() : null;
}

export function getNotificationTeamName(notification: NotificationTeamIdentity): string | null {
  const targetName = readTargetTeamName(notification.target);
  if (targetName) {
    return targetName;
  }

  const sessionId = notification.sessionId?.trim() ?? '';
  if (sessionId.startsWith('team:')) {
    const name = sessionId.slice('team:'.length).trim();
    return name || null;
  }

  if (notification.category === 'team') {
    const projectId = notification.projectId?.trim();
    return projectId || null;
  }

  return null;
}

export function notificationBelongsToTeam(
  notification: NotificationTeamIdentity,
  teamName: string
): boolean {
  const expected = teamName.trim();
  if (!expected) {
    return false;
  }
  return getNotificationTeamName(notification) === expected;
}
