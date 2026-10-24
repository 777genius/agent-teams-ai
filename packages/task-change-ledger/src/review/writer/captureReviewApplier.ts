import type { ReviewApplierPort } from './ports.js';

/** Captures the mechanism once; a missing optional Desktop dependency fails at use, never borrows another owner. */
export function captureReviewApplier(source?: ReviewApplierPort | null): ReviewApplierPort {
  const required = () => {
    if (!source) throw new Error('ReviewApplierService not initialized');
    return source;
  };
  return {
    classifyEditedFileTransition: (
      ...args: Parameters<ReviewApplierPort['classifyEditedFileTransition']>
    ) => required().classifyEditedFileTransition(...args),
    classifyRejectedRenameTransition: (
      ...args: Parameters<ReviewApplierPort['classifyRejectedRenameTransition']>
    ) => required().classifyRejectedRenameTransition(...args),
    restoreRejectedRename: (...args: Parameters<ReviewApplierPort['restoreRejectedRename']>) =>
      required().restoreRejectedRename(...args),
    reapplyRejectedRename: (...args: Parameters<ReviewApplierPort['reapplyRejectedRename']>) =>
      required().reapplyRejectedRename(...args),
    getRejectedRenamePostimages: (
      ...args: Parameters<ReviewApplierPort['getRejectedRenamePostimages']>
    ) => required().getRejectedRenamePostimages(...args),
    checkConflict: (...args: Parameters<ReviewApplierPort['checkConflict']>) =>
      required().checkConflict(...args),
    rejectHunks: (...args: Parameters<ReviewApplierPort['rejectHunks']>) =>
      required().rejectHunks(...args),
    rejectFile: (...args: Parameters<ReviewApplierPort['rejectFile']>) =>
      required().rejectFile(...args),
    previewReject: (...args: Parameters<ReviewApplierPort['previewReject']>) =>
      required().previewReject(...args),
    applyReviewDecisions: (...args: Parameters<ReviewApplierPort['applyReviewDecisions']>) =>
      required().applyReviewDecisions(...args),
    saveEditedFile: (...args: Parameters<ReviewApplierPort['saveEditedFile']>) =>
      required().saveEditedFile(...args),
    deleteEditedFile: (...args: Parameters<ReviewApplierPort['deleteEditedFile']>) =>
      required().deleteEditedFile(...args),
    finalizeReviewDiskTransitions: (
      ...args: Parameters<ReviewApplierPort['finalizeReviewDiskTransitions']>
    ) => required().finalizeReviewDiskTransitions?.(...args) ?? Promise.resolve(),
    finalizeEditedFileTransaction: (
      ...args: Parameters<ReviewApplierPort['finalizeEditedFileTransaction']>
    ) => required().finalizeEditedFileTransaction?.(...args) ?? Promise.resolve(),
    finalizeRejectedRenameTransaction: (
      ...args: Parameters<ReviewApplierPort['finalizeRejectedRenameTransaction']>
    ) => required().finalizeRejectedRenameTransaction?.(...args) ?? Promise.resolve(),
  };
}
