'use strict';

const native = require('..');

let scopeId;
let leaseId;

process.on('message', (message) => {
  try {
    if (message.command === 'acquire') {
      scopeId = native.captureScope(message.root);
      const result = native.tryAcquire(scopeId, message.target, message.marker);
      if (result.status === 'acquired') leaseId = result.leaseId;
      process.send({ type: 'result', result });
      if (result.status !== 'acquired') {
        native.closeScope(scopeId);
        process.exit(0);
      }
      return;
    }
    if (message.command === 'assert') {
      native.assertOwned(leaseId);
      process.send({ type: 'asserted' });
      return;
    }
    if (message.command === 'release') {
      if (message.record !== undefined) native.publishRelease(leaseId, message.record);
      native.release(leaseId);
      native.closeScope(scopeId);
      process.send({ type: 'released' });
      process.exit(0);
      return;
    }
    if (message.command === 'abandon') {
      native.abandon(leaseId);
      native.closeScope(scopeId);
      process.send({ type: 'abandoned' });
      process.exit(0);
    }
  } catch (error) {
    process.send({ type: 'error', code: error.code, message: error.message });
    process.exit(1);
  }
});

process.send({ type: 'ready' });
