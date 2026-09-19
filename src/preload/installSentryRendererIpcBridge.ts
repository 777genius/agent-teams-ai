import { contextBridge, ipcRenderer } from 'electron';

type SentryIpcChannel = 'start' | 'scope' | 'envelope' | 'status' | 'structured-log' | 'metric';

interface SentryRendererIpcBridge {
  sendRendererStart: () => void;
  sendScope: (scopeJson: string) => void;
  sendEnvelope: (envelope: Uint8Array | string) => void;
  sendStatus: (status: unknown) => void;
  sendStructuredLog: (log: unknown) => void;
  sendMetric: (metric: unknown) => void;
}

declare global {
  interface Window {
    __SENTRY_IPC__?: Record<string, SentryRendererIpcBridge>;
  }
}

const SENTRY_IPC_NAMESPACE = 'sentry-ipc';

function createSentryIpcKey(channel: SentryIpcChannel): string {
  return `${SENTRY_IPC_NAMESPACE}.${channel}`;
}

export function installSentryRendererIpcBridge(): void {
  window.__SENTRY_IPC__ = window.__SENTRY_IPC__ || {};
  if (window.__SENTRY_IPC__[SENTRY_IPC_NAMESPACE]) {
    return;
  }

  window.__SENTRY_IPC__[SENTRY_IPC_NAMESPACE] = {
    sendRendererStart: () => ipcRenderer.send(createSentryIpcKey('start')),
    sendScope: (scopeJson) => ipcRenderer.send(createSentryIpcKey('scope'), scopeJson),
    sendEnvelope: (envelope) => ipcRenderer.send(createSentryIpcKey('envelope'), envelope),
    sendStatus: (status) => ipcRenderer.send(createSentryIpcKey('status'), status),
    sendStructuredLog: (log) => ipcRenderer.send(createSentryIpcKey('structured-log'), log),
    sendMetric: (metric) => ipcRenderer.send(createSentryIpcKey('metric'), metric),
  };

  contextBridge.exposeInMainWorld('__SENTRY_IPC__', window.__SENTRY_IPC__);
}
