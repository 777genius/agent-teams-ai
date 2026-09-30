export interface TeamListLifecyclePorts {
  listAliveTeams(): Promise<string[]>;
  stopRunningTeam(teamName: string): Promise<void>;
}
