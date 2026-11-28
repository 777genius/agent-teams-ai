import type { DeliveryBinding } from './contracts.js';

export interface RegisterTeamRuntime {
  commandId: string;
  expectedRevision: string;
  launchId: string;
  members: { memberId: string; principalId: string; delivery: DeliveryBinding }[];
}
export interface TeamRuntimeRegistrationReceipt {
  commandId: string;
  configurationRevision: string;
  launchId: string;
}
export interface TeamRuntimeCapture extends TeamRuntimeRegistrationReceipt {
  members: RegisterTeamRuntime['members'];
}
export interface StoredTeamRuntimeCapture extends TeamRuntimeCapture {
  principalId: string;
  fingerprint: string;
}
