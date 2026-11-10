// Public store-independent facade for renderer lifecycle cleanup.
export { captureQueueNamespace as captureManualQueueNamespace } from './renderer/adapters/queueBinding';
export { discardManualMessageQueueNamespace } from './renderer/adapters/queueRepository';
