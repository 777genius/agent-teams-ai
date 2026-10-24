import { writeBackupManifestSync as writePortable } from '@agent-teams/legacy-agent-host/lifecycle';
import { createLogger } from '@shared/utils/logger';

import type { BackupManifest } from '@agent-teams/legacy-agent-host/lifecycle';
export type {
  BackupManifest,
  BackupManifestWriteOptions,
} from '@agent-teams/legacy-agent-host/lifecycle';
export {
  getBackupManifestPath,
  readBackupManifest,
  readBackupManifestStrict,
  readBackupManifestStrictSync,
  readBackupManifestSync,
  writeBackupManifest,
  writeBackupManifestStrictAware,
} from '@agent-teams/legacy-agent-host/lifecycle';
const logger = createLogger('TeamBackupService');
export function writeBackupManifestSync(backupDir: string, manifest: BackupManifest): void {
  writePortable(backupDir, manifest, (message) => logger.warn(message));
}
