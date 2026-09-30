import type { TeamRosterMutationDependencies } from '../TeamRosterMutationDependencies';

export class UpdateTeamRosterMemberRole {
  constructor(private readonly dependencies: TeamRosterMutationDependencies) {}

  async execute(teamName: string, memberName: string, role: string | undefined): Promise<void> {
    await this.dependencies.lifecycle.runMutation(teamName, async () => {
      const { oldRole, changed } = await this.dependencies.repository.updateMemberRole(
        teamName,
        memberName,
        role
      );
      if (!changed) return;

      this.dependencies.cache.invalidate(teamName);
      if (!this.dependencies.runtime.isAlive(teamName)) return;

      const oldDesc = oldRole ? `"${oldRole}"` : 'none';
      const newDesc = role ? `"${role}"` : 'none';
      const message = `Teammate "${memberName}" role changed from ${oldDesc} to ${newDesc}. This will take effect on next launch.`;
      try {
        await this.dependencies.messaging.notifyLead(teamName, message);
      } catch {
        this.dependencies.logger.warn(
          `Failed to notify lead about role change for "${memberName}" in ${teamName}`
        );
      }
    });
  }
}
