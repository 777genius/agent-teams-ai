export interface MemberLogStreamTrackingPort {
  setTracking(teamName: string, enabled: boolean): Promise<void>;
}
