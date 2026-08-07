import '../index.css';

import React from 'react';
import ReactDOM from 'react-dom/client';

import { HostedAuthGate } from '@features/hosted-access/renderer';
import { LocalizationProvider } from '@features/localization/renderer';
import { HostedApplicationShell } from '@renderer/hosted/HostedApplicationShell';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Hosted renderer root is unavailable.');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <LocalizationProvider appConfig={null}>
      <HostedAuthGate>
        <HostedApplicationShell />
      </HostedAuthGate>
    </LocalizationProvider>
  </React.StrictMode>
);
