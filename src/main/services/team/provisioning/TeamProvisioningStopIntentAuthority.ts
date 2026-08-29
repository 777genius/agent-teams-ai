/**
 * Serializes the short authorization/publication phase of per-team stops.
 * Long-running provider work deliberately does not hold this lock.
 */
export class TeamProvisioningStopIntentAuthority {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly generationByTeam = new Map<string, number>();

  getGeneration(teamName: string): number {
    return this.generationByTeam.get(this.getKey(teamName)) ?? 0;
  }

  async authorizeAndPublish(
    teamName: string,
    authorize: () => Promise<void>,
    onAuthorized: () => void
  ): Promise<void> {
    const teamKey = this.getKey(teamName);
    const previous = this.tails.get(teamKey);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(teamKey, current);
    if (previous) {
      await previous;
    }

    try {
      await authorize();
      this.generationByTeam.set(teamKey, this.getGeneration(teamName) + 1);
      onAuthorized();
    } finally {
      release();
      if (this.tails.get(teamKey) === current) {
        this.tails.delete(teamKey);
      }
    }
  }

  private getKey(teamName: string): string {
    return teamName.trim().toLowerCase();
  }
}
