export interface LeadRelayCaptureOwner {
  leadRelayCapture?: { rejectOnce(error: string): void } | null;
}

const pendingRelayCancellations = new WeakMap<LeadRelayCaptureOwner, () => void>();

/** Keep cancellation live even when reply capture finishes before transport delivery. */
export function observeRunLeadRelayCancellation(run: LeadRelayCaptureOwner): {
  cancelled: Promise<never>;
  isCancelled(): boolean;
  dispose(): void;
} {
  let didCancel = false;
  let cancel!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => {
      didCancel = true;
      reject(new Error('Lead relay run stopped'));
    };
  });
  pendingRelayCancellations.set(run, cancel);
  return {
    cancelled,
    isCancelled: () => didCancel,
    dispose: () => {
      if (pendingRelayCancellations.get(run) === cancel) pendingRelayCancellations.delete(run);
    },
  };
}

/** Cancel only this run's capture; a replacement run owns its own capture. */
export function cancelRunLeadRelayCapture(run: LeadRelayCaptureOwner): void {
  pendingRelayCancellations.get(run)?.();
  run.leadRelayCapture?.rejectOnce('Lead relay run stopped');
  run.leadRelayCapture = null;
}
