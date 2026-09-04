export interface LeadRelayCaptureOwner {
  leadRelayCapture?: { rejectOnce(error: string): void } | null;
}

/** Cancel only this run's capture; a replacement run owns its own capture. */
export function cancelRunLeadRelayCapture(run: LeadRelayCaptureOwner): void {
  run.leadRelayCapture?.rejectOnce('Lead relay run stopped');
  run.leadRelayCapture = null;
}
