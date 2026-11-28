export interface BackendResumeChoice {
  memberId: string;
  sourceGeneration: string;
  reference: string;
  commandId: string;
}
export interface BackendResumePrepareRequest {
  launchId: string;
  rosterRevision: string;
  resumeId: string;
  members: BackendResumeChoice[];
}
export interface BackendResumePreparation {
  resumeId: string;
  rosterRevision: string;
  members: (BackendResumeChoice & {
    requested: boolean;
    refused?: 'invalid' | 'conflict' | 'hold';
  })[];
}

/** Original restore selections. Absence or released custody alone does not prove success. */
export interface BackendLaunchRestorations {
  launchId: string;
  rosterRevision: string;
  preparations: BackendResumePreparation[];
  restorations: {
    commandId: string;
    memberId: string;
    reference: string;
    sourceGeneration: string;
    selectedGeneration: string;
    current: boolean;
    phase: 'unopened' | 'opening' | 'allocated' | 'closing' | 'closed' | 'held' | 'unavailable';
    custody: 'owned' | 'released' | 'unknown';
    attached: boolean;
  }[];
}
