export interface TeamLaunchFailureDiagnosticsFile {
  label: string;
  path: string;
  content?: string;
  issue?: string;
}

export interface TeamLaunchDiagnosticsObservation {
  label: string;
  content?: string;
  issue?: string;
}

export interface TeamLaunchFailureDiagnosticsBundle {
  teamName: string;
  runId?: string;
  /** Host observations are authorized snapshots, not legacy filesystem artifacts. */
  source?: 'captured-host';
  observations?: TeamLaunchDiagnosticsObservation[];
  latestPath?: string;
  artifactDirectory?: string;
  manifestPath?: string;
  classification?: {
    code?: string;
    confidence?: number;
    evidence?: string[];
  } | null;
  bootstrapTransportBreadcrumb?: {
    lastTransportStage?: string | null;
    submitRejected?: boolean;
    retryable?: boolean | null;
    noStdinWarning?: boolean;
    bootstrapSubmitted?: boolean;
    evidence?: string[];
  } | null;
  files: TeamLaunchFailureDiagnosticsFile[];
}
