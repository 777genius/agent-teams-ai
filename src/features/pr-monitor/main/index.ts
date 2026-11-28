export { createPrMonitorFeature } from './composition/createPrMonitorFeature';
export type { PrMonitorFeature } from './composition/createPrMonitorFeature';
export { registerPrMonitorIpc } from './adapters/input/ipc';
export { registerPrMonitorHttp } from './adapters/input/http';

export { isTrustedRenderer } from './infrastructure/trustedRenderer';
