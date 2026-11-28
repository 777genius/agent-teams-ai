/** Browser-safe transport factory. Runtime composition and UI have separate entrypoints. */
export type { PrMonitorApi } from './contracts';
export { createPrMonitorHttpClient } from './renderer/adapters/httpClient';
