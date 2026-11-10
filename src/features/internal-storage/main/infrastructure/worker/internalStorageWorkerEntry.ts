import { parentPort, workerData } from 'node:worker_threads';

import { loadInternalStorageNativeDriver } from '../internalStorageNativeDriver';

import { InternalStorageWorkerCore } from './InternalStorageWorkerCore';

import type {
  InternalStorageWorkerData,
  InternalStorageWorkerRequest,
  InternalStorageWorkerResponse,
} from './internalStorageWorkerProtocol';

if (!parentPort) {
  throw new Error('internal-storage-worker must run as a worker thread');
}

const port = parentPort;
const data = workerData as InternalStorageWorkerData;

const core = new InternalStorageWorkerCore({
  databasePath: data.databasePath,
  createDatabase: (databasePath) => {
    const Driver = loadInternalStorageNativeDriver();
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
