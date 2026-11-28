/** Browser-safe transport factory. Runtime composition and UI have separate entrypoints. */
export { createPrMonitorHttpClient } from './renderer/adapters/httpClient';
export type { PrMonitorApi } from './contracts';
