import type { CustomProjectFolderModel } from './useCustomProjectFolder';

export type CustomProjectFolderNoticeTone = 'muted' | 'warning' | 'error';

export type CustomProjectFolderNoticeMessage =
  | 'createAutomatically'
  | 'folder.missingCreatedOnSubmit'
  | 'folder.missingRequiredBeforeCreate'
  | 'folder.missingMustExist'
  | 'folder.notDirectory'
  | 'folder.invalid'
  | 'folder.unknown';

export interface CustomProjectFolderNotice {
  tone: CustomProjectFolderNoticeTone;
  message: CustomProjectFolderNoticeMessage;
  canCreate: boolean;
}

type NoticeInput = Pick<
  CustomProjectFolderModel,
  'status' | 'createsMissingOnSubmit' | 'requiredBeforeSubmit'
>;

export function getCustomProjectFolderNotice(input: NoticeInput): CustomProjectFolderNotice | null {
  switch (input.status) {
    case 'missing':
      if (!input.createsMissingOnSubmit) {
        return { tone: 'error', message: 'folder.missingMustExist', canCreate: true };
      }
      return input.requiredBeforeSubmit
        ? { tone: 'warning', message: 'folder.missingRequiredBeforeCreate', canCreate: true }
        : { tone: 'muted', message: 'folder.missingCreatedOnSubmit', canCreate: true };
    case 'not_directory':
      return { tone: 'error', message: 'folder.notDirectory', canCreate: false };
    case 'invalid':
      return { tone: 'warning', message: 'folder.invalid', canCreate: false };
    case 'unknown':
      if (!input.createsMissingOnSubmit) {
        return { tone: 'error', message: 'folder.unknown', canCreate: false };
      }
      return { tone: 'muted', message: 'createAutomatically', canCreate: false };
    case 'idle':
      // Existence is not known here, so only repeat the submit-time guarantee where it holds.
      return input.createsMissingOnSubmit
        ? { tone: 'muted', message: 'createAutomatically', canCreate: false }
        : null;
    case 'checking':
    case 'exists':
      return null;
  }
}
