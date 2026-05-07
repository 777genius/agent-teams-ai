import type { MemberLogStreamTrackingPort } from '../ports/MemberLogStreamTrackingPort';

export class SetMemberLogStreamTrackingUseCase {
  constructor(private readonly tracking: MemberLogStreamTrackingPort) {}

  async execute(teamName: string, enabled: boolean): Promise<void> {
    await this.tracking.setTracking(teamName, enabled);
  }
}
