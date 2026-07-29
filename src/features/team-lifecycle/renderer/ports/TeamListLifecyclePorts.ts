export interface TeamListLifecyclePorts {
  listAliveTeams(): Promise<string[]>;
  stopTeam(teamName: string): Promise<void>;
}
