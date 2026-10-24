// Run with ELECTRON_RUN_AS_NODE=1 <test Electron binary> <this file>.
// Exercises native addon ownership using only a disposable database, without UI.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

const driverModuleUrl = new URL(
  '../../../../src/features/internal-storage/main/infrastructure/internalStorageNativeDriver.ts',
  import.meta.url
);
const { loadInternalStorageNativeDriver, pinInternalStorageNativeDriver } = (await import(
  driverModuleUrl.href
)) as typeof import('../../../../src/features/internal-storage/main/infrastructure/internalStorageNativeDriver');

if (!isMainThread) {
  const data = workerData as { databasePath: string };
  const Driver = loadInternalStorageNativeDriver();
  const db = new Driver(data.databasePath);
  db.exec('CREATE TABLE IF NOT EXISTS smoke (id INTEGER PRIMARY KEY)');
  db.prepare('INSERT INTO smoke DEFAULT VALUES').run();
  const row = db.prepare('SELECT COUNT(*) AS count FROM smoke').get() as { count: number };
  parentPort?.postMessage(row.count);
  // Deliberately retain the open disposable connection until forced termination,
  // exercising native cleanup during isolate disposal rather than graceful close.
  parentPort?.on('message', () => undefined);
} else {
  const sandbox = await mkdtemp(join(tmpdir(), 'sqlite-native-pin-smoke-'));
  try {
    pinInternalStorageNativeDriver();
    const nativeImages = () => {
      const report = process.report?.getReport() as { sharedObjects: string[] };
      return report.sharedObjects.filter((entry) => entry.endsWith('better_sqlite3.node'));
    };
    const pinnedImages = nativeImages();
    assert.equal(pinnedImages.length, 1, 'main must load the actual native binary');
    const cycles = 8;
    for (let cycle = 1; cycle <= cycles; cycle++) {
      pinInternalStorageNativeDriver();
      const worker = new Worker(fileURLToPath(import.meta.url), {
        workerData: { databasePath: join(sandbox, 'worker.db') },
      });
      try {
        const count = await new Promise<number>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('worker startup timed out')), 10_000);
          worker.once('message', (value: number) => {
            clearTimeout(timeout);
            resolve(value);
          });
          worker.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
          worker.once('exit', (code) => {
            clearTimeout(timeout);
            reject(new Error(`worker exited before ready: ${code}`));
          });
        });
        assert.equal(count, cycle, 'each replacement must reopen the disposable database');
      } finally {
        await worker.terminate();
      }
      assert.deepEqual(nativeImages(), pinnedImages, 'native binary must survive worker disposal');
    }
    console.log(
      JSON.stringify({
        electron: process.versions.electron,
        node: process.versions.node,
        modules: process.versions.modules,
        cycles,
        nativeAddonRetained: true,
      })
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}
