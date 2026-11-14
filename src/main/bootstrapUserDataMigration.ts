import { app, crashReporter } from 'electron';
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

function startPackagedNativeCrashReporter(): void {
  const run = process.env.AGENT_TEAMS_PACKAGED_CRASH_RUN;
  if (
    process.platform !== 'win32' ||
    !run ||
    !['cold', 'warm-1', 'warm-2', 'support-repair', 'support-repair-restart'].includes(run)
  ) return;

  let resultPath: string | null = null;
  let state: 'refused' | 'failed' | 'started' = 'refused';
  let uploadToServer: boolean | null = null;
  let directory: { device: string; inode: string; birthtimeNs: string } | null = null;
  const roots = new Map<string, fs.BigIntStats>();
  const rootsCurrent = (): boolean =>
    roots.size === 4 && [...roots].every(([selected, original]) => {
      const now = fs.lstatSync(selected, { bigint: true });
      return now.isDirectory() && !now.isSymbolicLink() &&
        now.dev === original.dev && now.ino === original.ino &&
        now.birthtimeNs === original.birthtimeNs &&
        path.relative(fs.realpathSync.native(selected), path.resolve(selected)) === '';
    });
  try {
    if (!app.isPackaged || app.isReady()) return;
    const { userDataDir, claudeRoot } = earlyElectronDevPathOverrideResult;
    if (!userDataDir || !claudeRoot) return;
    const root = path.dirname(userDataDir);
    if (
      !path.basename(root).startsWith('opencode-diagnostics-e2e-') ||
      path.relative(path.join(root, 'user-data'), userDataDir) !== '' ||
      path.relative(path.join(root, 'home', '.claude'), claudeRoot) !== '' ||
      path.relative(app.getPath('userData'), userDataDir) !== ''
    ) return;
    const crashRoot = path.join(userDataDir, 'crashes');
    if (path.relative(app.getPath('crashDumps'), crashRoot) !== '') return;
    for (const selected of [root, userDataDir, claudeRoot, crashRoot]) {
      const info = fs.lstatSync(selected, { bigint: true });
      if (
        !info.isDirectory() || info.isSymbolicLink() || info.ino === 0n ||
        path.relative(fs.realpathSync.native(selected), path.resolve(selected)) !== ''
      ) return;
      roots.set(selected, info);
    }
    const marker = path.join(root, '.native-crash-test');
    const expected = Buffer.from('opencode-packaged-native-crash-v1\n');
    const same = (left: fs.BigIntStats, right: fs.BigIntStats): boolean =>
      left.isFile() && right.isFile() && !left.isSymbolicLink() && !right.isSymbolicLink() &&
      left.nlink === 1n && right.nlink === 1n && left.ino !== 0n &&
      left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
      left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
    const before = fs.lstatSync(marker, { bigint: true });
    if (
      !same(before, before) || before.size !== BigInt(expected.length) ||
      path.relative(fs.realpathSync.native(marker), marker) !== ''
    ) return;
    const fd = fs.openSync(marker, fs.constants.O_RDONLY);
    try {
      if (!same(before, fs.fstatSync(fd, { bigint: true }))) return;
      const bytes = Buffer.alloc(expected.length + 1);
      const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
      if (
        count !== expected.length || !bytes.subarray(0, count).equals(expected) ||
        !same(before, fs.fstatSync(fd, { bigint: true })) ||
        !same(before, fs.lstatSync(marker, { bigint: true })) ||
        path.relative(fs.realpathSync.native(marker), marker) !== ''
      ) return;
    } finally {
      fs.closeSync(fd);
    }
    if (!rootsCurrent()) return;
    resultPath = path.join(root, `native-crash-${run}.json`);
    const selected = path.join(crashRoot, run);
    try {
      fs.lstatSync(selected);
      return;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    fs.mkdirSync(selected, { mode: 0o700 });
    const info = fs.lstatSync(selected, { bigint: true });
    if (
      !info.isDirectory() || info.isSymbolicLink() || info.ino === 0n ||
      path.relative(fs.realpathSync.native(selected), selected) !== ''
    ) return;
    directory = {
      device: info.dev.toString(),
      inode: info.ino.toString(),
      birthtimeNs: info.birthtimeNs.toString(),
    };
    if (
      !rootsCurrent() || !same(before, fs.lstatSync(marker, { bigint: true })) ||
      path.relative(fs.realpathSync.native(marker), marker) !== ''
    ) return;
    app.setPath('crashDumps', selected);
    crashReporter.start({ uploadToServer: false });
    uploadToServer = crashReporter.getUploadToServer();
    state = uploadToServer === false ? 'started' : 'failed';
  } catch {
    state = 'failed';
  } finally {
    if (resultPath) {
      try {
        const serialized = JSON.stringify({
          schemaVersion: 1,
          observationOnly: true,
          state,
          run,
          pid: process.pid,
          electronVersion: process.versions.electron ?? null,
          uploadToServer,
          directory,
        }) + '\n';
        if (rootsCurrent() && Buffer.byteLength(serialized, 'utf8') <= 4096)
          fs.writeFileSync(resultPath, serialized, { flag: 'wx', mode: 0o600 });
      } catch {
        // Diagnostic failure never replaces the original startup result.
      }
    }
  }
}

startPackagedNativeCrashReporter();
