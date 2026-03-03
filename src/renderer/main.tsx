import './index.css';

import React from 'react';
import ReactDOM from 'react-dom/client';

import { App } from './App';
import { initializeNotificationListeners } from './store';

declare global {
  interface Window {
    __claudeTeamsUiDidInit?: boolean;
  }
}

// React 18 StrictMode intentionally mounts/unmounts effects twice in dev,
// which can start duplicate IPC init chains. Make initialization a one-time
// module-level side effect guarded by a global flag.
if (!window.__claudeTeamsUiDidInit) {
  window.__claudeTeamsUiDidInit = true;
  if (import.meta.env.DEV) {
    // Intentionally console.warn so it shows up in main terminal via preload forwarding.
    console.warn('[Perf:Renderer] boot renderer/main.tsx');
  }
  initializeNotificationListeners();
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
