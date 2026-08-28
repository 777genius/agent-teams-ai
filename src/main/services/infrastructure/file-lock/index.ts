export { DesktopFileLockNativeAdapter } from './DesktopFileLockNativeAdapter';
export type { FileLockNativeAcquireResult, FileLockNativePort } from './FileLockNativePort';
export {
  buildFileLockV3Record,
  classifyFileLockRecord,
  FILE_LOCK_V3_BRAND,
  FILE_LOCK_V3_LEGACY_TIMESTAMP,
  type FileLockRecordClassification,
} from './fileLockRecordPolicy';
