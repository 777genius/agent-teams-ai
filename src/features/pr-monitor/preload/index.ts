import { ipcRenderer } from 'electron';

import {
  PR_MONITOR_CHANNEL,
  PR_MONITOR_CONSENT_CHANNEL,
  PR_MONITOR_LOGIN_CHANNEL,
} from '../contracts';

import type { PrMonitorApi } from '../contracts';

export function createPrMonitorBridge(): PrMonitorApi {
  return {
    beginLogin: (request) =>
      ipcRenderer.invoke(PR_MONITOR_LOGIN_CHANNEL, { ...request, operation: 'begin' }),
    pollLogin: (request) =>
      ipcRenderer.invoke(PR_MONITOR_LOGIN_CHANNEL, { ...request, operation: 'poll' }),
    cancelLogin: (request) =>
      ipcRenderer.invoke(PR_MONITOR_LOGIN_CHANNEL, { ...request, operation: 'cancel' }),
    signOut: (request) =>
      ipcRenderer.invoke(PR_MONITOR_LOGIN_CHANNEL, { ...request, operation: 'sign-out' }),
    describe: (request) =>
      ipcRenderer.invoke(PR_MONITOR_CHANNEL, { ...request, operation: 'describe' }),
    list: (request) => ipcRenderer.invoke(PR_MONITOR_CHANNEL, { ...request, operation: 'list' }),
    get: (request) => ipcRenderer.invoke(PR_MONITOR_CHANNEL, { ...request, operation: 'get' }),
    connect: (request) => ipcRenderer.invoke(PR_MONITOR_CONSENT_CHANNEL, request, true),
    disconnect: (request) => ipcRenderer.invoke(PR_MONITOR_CONSENT_CHANNEL, request, false),
  };
}
