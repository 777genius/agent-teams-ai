/**
 * Resolves which team an in-app notification belongs to.
 * Team events use `sessionId: team:{name}`, `projectId: {name}`, and optional `target.teamName`.
 */

export interface NotificationTeamIdentity {
  sessionId?: string | null;
  projectId?: string;
  category?: string;
  target?: { teamName?: string } | null;
}

export function getNotificationTeamName(notification: NotificationTeamIdentity): string | null {
  const targetName = notification.target?.teamName?.trim();
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
