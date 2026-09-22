const { parentPort } = require('node:worker_threads');

if (!parentPort) {
  throw new Error('external-writer-null-worker requires a parent port');
}

parentPort.on('message', (message) => {
  if (message.op === 'externalWriterObservation.consumeCleanHandoff') {
    parentPort.postMessage({ id: message.id, ok: true, result: null });
    return;
  }
  if (message.op === 'ping') {
    parentPort.postMessage({ id: message.id, ok: true, result: { backend: 'sqlite' } });
    return;
  }
  if (message.op === 'close') {
    parentPort.postMessage({ id: message.id, ok: true, result: undefined });
  }
});
