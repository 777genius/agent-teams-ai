import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import type DatabaseConstructor from 'better-sqlite3';

let nativeDriver: typeof DatabaseConstructor | null = null;
let nativeDriverPinned = false;

// Main and worker bundles are co-located, so both resolve the same external
// driver package. Keep loading lazy to preserve JSON fallback on ABI failures.
export function loadInternalStorageNativeDriver(): typeof DatabaseConstructor {
  if (nativeDriver) return nativeDriver;
  const requireModule = createRequire(
    typeof __filename === 'string' && __filename.length > 0
      ? __filename
      : fileURLToPath(import.meta.url)
  );
  try {
    nativeDriver = requireModule('better-sqlite3') as typeof DatabaseConstructor;
    return nativeDriver;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`better-sqlite3 native module failed to load: ${message}`);
  }
}

/** Retain the native addon in main before a worker can load or unload it. */
export function pinInternalStorageNativeDriver(): void {
  if (nativeDriverPinned) return;
  try {
    const Driver = loadInternalStorageNativeDriver();
    // Requiring the JS constructor alone does not load better_sqlite3.node.
    // A throwaway connection triggers its supported binding loader, whose
    // cached addon remains attached to the main isolate until process exit.
    // Application database ownership stays exclusively in the worker.
    const probe = new Driver(':memory:');
    probe.close();
    nativeDriverPinned = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`better-sqlite3 native module pin failed: ${message}`);
  }
}
