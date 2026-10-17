/**
 * Internal-storage startup for the Electron main process.
 *
 * The composition root in `src/main/index.ts` is frozen by
 * `scripts/ci/check-source-file-size.mjs`, so storage-backed startup lives here:
 * this module owns creating the storage feature and running the packaged-smoke
 * backend probe, which must happen before any storage-backed feature is composed.
 */
import {
  createInternalStorageFeature,
  type InternalStorageFeature,
} from '@features/internal-storage/main';
import { app } from 'electron';

export function startInternalStorage(): InternalStorageFeature {
  const feature = createInternalStorageFeature({ userDataPath: app.getPath('userData') });
  if (process.env.AGENT_TEAMS_PACKAGED_SMOKE?.trim() === '1') {
    void feature.probeBackend();
  }
  return feature;
}
