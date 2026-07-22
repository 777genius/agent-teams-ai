import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';

import { InternalStorageWorkerCore } from './InternalStorageWorkerCore';

import type {
  InternalStorageWorkerData,
  InternalStorageWorkerRequest,
  InternalStorageWorkerResponse,
} from './internalStorageWorkerProtocol';
import type DatabaseConstructor from 'better-sqlite3';

if (!parentPort) {
  throw new Error('internal-storage-worker must run as a worker thread');
}

const port = parentPort;
const data = workerData as InternalStorageWorkerData;

let nativeDriver: typeof DatabaseConstructor | null = null;

// Loaded lazily so an ABI mismatch (e.g. after an Electron upgrade before
// electron-rebuild ran) surfaces as a failed op the client can fall back on,
// instead of crashing the worker at startup.
function loadNativeDriver(): typeof DatabaseConstructor {
  if (nativeDriver) {
    return nativeDriver;
  }
  const requireModule = createRequire(
    typeof __filename === 'string' && __filename.length > 0
      ? __filename
      : fileURLToPath(import.meta.url)
  );
  try {
    nativeDriver = requireModule('better-sqlite3') as typeof DatabaseConstructor;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`better-sqlite3 native module failed to load: ${message}`);
  }
  return nativeDriver;
}

const core = new InternalStorageWorkerCore({
  databasePath: data.databasePath,
  createDatabase: (databasePath) => {
    const Driver = loadNativeDriver();
    return new Driver(databasePath);
  },
});

port.on('message', (message: InternalStorageWorkerRequest) => {
  let response: InternalStorageWorkerResponse;
  try {
    const result = core.handle(message.op, message.payload);
    response = { id: message.id, ok: true, result };
  } catch (error) {
    response = {
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  port.postMessage(response);
});

process.on('exit', () => {
  try {
    core.close();
  } catch {
    // WAL recovery handles an unclean close on the next open.
  }
});
