import { app } from 'electron';

import { applyElectronDevPathOverrides } from './utils/electronDevPathOverrides';
import { migrateElectronUserDataDirectory } from './utils/electronUserDataMigration';

export const earlyElectronDevPathOverrideResult = applyElectronDevPathOverrides(app);
export const earlyElectronUserDataMigrationResult = earlyElectronDevPathOverrideResult.userDataDir
  ? {
      currentPath: earlyElectronDevPathOverrideResult.userDataDir,
      legacyPath: null,
      migrated: false,
      fallbackToLegacy: false,
      reason: 'current-path-exists' as const,
    }
  : migrateElectronUserDataDirectory(app);
