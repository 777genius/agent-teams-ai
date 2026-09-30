export interface TeamBranchTrackingRendererPorts {
  setTracking(projectPath: string, enabled: boolean): Promise<void>;
}
