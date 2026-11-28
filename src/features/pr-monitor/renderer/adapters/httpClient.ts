import { monitorFailure, PR_MONITOR_ROUTE } from '../../contracts';

import type { PrMonitorApi } from '../../contracts';

export function createPrMonitorHttpClient(
  post: <T>(url: string, body: unknown) => Promise<T>
): PrMonitorApi {
  const nativeOnly = () =>
    Promise.resolve(monitorFailure('unsupported', 'Sign in to GitHub from the desktop app.'));
  return {
    beginLogin: nativeOnly,
    pollLogin: nativeOnly,
    cancelLogin: nativeOnly,
    signOut: nativeOnly,
    describe: (request) => post(PR_MONITOR_ROUTE, { ...request, operation: 'describe' }),
    list: (request) => post(PR_MONITOR_ROUTE, { ...request, operation: 'list' }),
    get: (request) => post(PR_MONITOR_ROUTE, { ...request, operation: 'get' }),
    connect: () =>
      Promise.resolve(
        monitorFailure('unsupported', 'Use the desktop app to connect your GitHub CLI account.')
      ),
    disconnect: () =>
      Promise.resolve(
        monitorFailure('unsupported', 'Use the desktop app to disconnect your GitHub CLI account.')
      ),
  };
}
