export interface TeamGraphTaskNotificationPort {
  notifyTeam(teamName: string, message: string): Promise<void>;
}
