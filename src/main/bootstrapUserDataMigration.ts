import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

import { applyElectronDevPathOverrides } from './utils/electronDevPathOverrides';
import { migrateElectronUserDataDirectory } from './utils/electronUserDataMigration';

// Windows GUI executables may show a modal for an early startup exception instead
// of forwarding it to stderr. This scoped diagnostic is written only to the
// disposable, marker-verified packaged smoke directory.
function recordPackagedSmokeBootstrap(result: string): void {
  if (process.env.AGENT_TEAMS_PACKAGED_SMOKE !== '1') return;
  try {
    const isolated = process.env.AGENT_TEAMS_ELECTRON_USER_DATA_DIR;
    if (!isolated) return;
    const root = path.dirname(isolated);
    if (!path.basename(root).startsWith('agent-teams-smoke-TEST-')) return;
    if (fs.readFileSync(path.join(root, '.test-only'), 'utf8') !== 'packaged-app-smoke-test-v1')
      return;
    fs.writeFileSync(path.join(root, 'bootstrap-result.txt'), result, 'utf8');
  } catch {
    // Diagnostics never alter startup or escape the test-owned directory.
  }
}

export const earlyElectronDevPathOverrideResult = (() => {
  try {
    const result = applyElectronDevPathOverrides(app);
    recordPackagedSmokeBootstrap('overrides-ok');
    return result;
  } catch (error) {
    recordPackagedSmokeBootstrap(error instanceof Error ? error.stack ?? error.message : String(error));
    throw error;
  }
})();
export const earlyElectronUserDataMigrationResult = earlyElectronDevPathOverrideResult.userDataDir
  ? {
      currentPath: earlyElectronDevPathOverrideResult.userDataDir,
      legacyPath: null,
      migrated: false,
      fallbackToLegacy: false,
      reason: 'current-path-exists' as const,
    }
  : migrateElectronUserDataDirectory(app);
