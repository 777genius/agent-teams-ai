import type { ApplierContext } from './applyContext.js';
import { createTextReject } from './textReject.js';
import { createDecisionApply } from './decisionApply.js';
import { createLedgerRename } from './ledgerRename.js';
import { createLedgerPaths } from './ledgerPaths.js';
import { createFileMutation } from './fileMutation.js';
import { createPublicationIO } from './publicationIO.js';

export class ReviewApplier {
  readonly classifyEditedFileTransition: ApplierContext['classifyEditedFileTransition'];
  readonly classifyRejectedRenameTransition: ApplierContext['classifyRejectedRenameTransition'];
  readonly restoreRejectedRename: ApplierContext['restoreRejectedRename'];
  readonly reapplyRejectedRename: ApplierContext['reapplyRejectedRename'];
  readonly getRejectedRenamePostimages: ApplierContext['getRejectedRenamePostimages'];
  readonly checkConflict: ApplierContext['checkConflict'];
  readonly rejectHunks: ApplierContext['rejectHunks'];
  readonly rejectFile: ApplierContext['rejectFile'];
  readonly previewReject: ApplierContext['previewReject'];
  readonly applyReviewDecisions: ApplierContext['applyReviewDecisions'];
  readonly saveEditedFile: ApplierContext['saveEditedFile'];
  readonly deleteEditedFile: ApplierContext['deleteEditedFile'];
  readonly finalizeReviewDiskTransitions: ApplierContext['finalizeReviewDiskTransitions'];
  readonly finalizeEditedFileTransaction: ApplierContext['finalizeEditedFileTransaction'];
  readonly finalizeRejectedRenameTransaction: ApplierContext['finalizeRejectedRenameTransaction'];
  constructor(options: { assertCurrent?: () => void } = {}) {
    const ctx: ApplierContext = {
      assertCurrent: options.assertCurrent,
      io: createPublicationIO(options.assertCurrent),
      ...createTextReject(() => ctx),
      ...createDecisionApply(() => ctx),
      ...createLedgerRename(() => ctx),
      ...createLedgerPaths(() => ctx),
      ...createFileMutation(() => ctx),
    };
    this.classifyEditedFileTransition = ctx.classifyEditedFileTransition;
    this.classifyRejectedRenameTransition = ctx.classifyRejectedRenameTransition;
    this.restoreRejectedRename = ctx.restoreRejectedRename;
    this.reapplyRejectedRename = ctx.reapplyRejectedRename;
    this.getRejectedRenamePostimages = ctx.getRejectedRenamePostimages;
    this.checkConflict = ctx.checkConflict;
    this.rejectHunks = ctx.rejectHunks;
    this.rejectFile = ctx.rejectFile;
    this.previewReject = ctx.previewReject;
    this.applyReviewDecisions = ctx.applyReviewDecisions;
    this.saveEditedFile = ctx.saveEditedFile;
    this.deleteEditedFile = ctx.deleteEditedFile;
    this.finalizeReviewDiskTransitions = ctx.finalizeReviewDiskTransitions;
    this.finalizeEditedFileTransaction = ctx.finalizeEditedFileTransaction;
    this.finalizeRejectedRenameTransaction = ctx.finalizeRejectedRenameTransaction;
  }
}
