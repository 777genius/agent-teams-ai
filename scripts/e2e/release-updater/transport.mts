import type { App, CallbackResponse, OnBeforeRequestListenerDetails, Session, session as ElectronSession } from 'electron';

interface UpdaterObserver {
  constructor: { name: string };
  currentVersion: { version: string };
  updateInfoAndProvider?: { info: { version: string }; provider: { constructor: { name: string } } };
  on(event: string, listener: (info: { version?: string; message?: string }) => void): unknown;
}
export interface TransportState {
  bound: string[];
  events: { type: string; version?: string; message?: string }[];
  requests: { session: string; method: string; url: string; redirected: boolean }[];
  roots?: { home: string; userData: string; appImage: string; resources: string; executable: string; version: string; packaged: boolean; arch: string };
  updater?: { class: string; currentVersion: string; provider?: string; version?: string };
  error?: string;
}

// Serialized into the paused original CJS frame. This only observes updater
// state and redirects transport; it never changes app/updater/IPC implementations.
export function transportHook(
  electron: { app: App; session: typeof ElectronSession },
  getUpdater: () => UpdaterObserver,
  origin: string,
  paths: string[],
) {
  if (electron.app.isReady()) throw new Error('App-entry pause happened after ready');
  const state: TransportState = { bound: [], events: [], requests: [] };
  (globalThis as typeof globalThis & { __TEST_nativeUpdater: TransportState }).__TEST_nativeUpdater = state;
  electron.app.prependOnceListener('ready', () => {
    try {
      const updaterSession = electron.session.fromPartition('electron-updater', { cache: false });
      const bind = (session: Session, name: string) => {
        const listener = (details: OnBeforeRequestListenerDetails, callback: (response: CallbackResponse) => void) => {
          const url = new URL(details.url);
          if (url.origin === origin) { callback({}); return; }
          let prefix = '';
          if (url.hostname === 'github.com') prefix = '/github';
          else if (url.hostname === 'api.github.com') prefix = '/api';
          const mirrorPath = prefix + url.pathname;
          const redirected = Boolean(prefix && paths.includes(mirrorPath));
          state.requests.push({ session: name, method: details.method, url: `${url.origin}${url.pathname}`, redirected });
          if (!redirected) { callback({ cancel: true }); return; }
          const destination = new URL(mirrorPath, origin);
          destination.search = url.search;
          destination.searchParams.set('TEST_session', name);
          callback({ redirectURL: destination.href });
        };
        // eslint-disable-next-line sonarjs/no-clear-text-protocols -- Observe and deny external HTTP; only the TEST loopback mirror serves cleartext.
        session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, listener);
        state.bound.push(name);
      };
      bind(electron.session.defaultSession, 'default');
      bind(updaterSession, 'electron-updater');
      if (updaterSession !== electron.session.fromPartition('electron-updater', { cache: false })) throw new Error('Partition identity changed');
      state.roots = { home: electron.app.getPath('home'), userData: electron.app.getPath('userData'), appImage: process.env.APPIMAGE ?? '', resources: process.resourcesPath, executable: process.execPath, version: electron.app.getVersion(), packaged: electron.app.isPackaged, arch: process.arch };
      const updater = getUpdater();
      state.updater = { class: updater.constructor.name, currentVersion: updater.currentVersion.version };
      updater.on('checking-for-update', () => state.events.push({ type: 'checking' }));
      updater.on('error', error => state.events.push({ type: 'error', message: error.message }));
      updater.on('update-available', info => {
        state.events.push({ type: 'available', version: info.version });
        state.updater = { class: updater.constructor.name, currentVersion: updater.currentVersion.version, provider: updater.updateInfoAndProvider?.provider.constructor.name, version: updater.updateInfoAndProvider?.info.version };
      });
    } catch (error) { state.error = String(error); }
  });
  return { scheduledBeforeReady: true };
}
