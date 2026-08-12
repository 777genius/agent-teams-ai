import '../index.css';

import React, { useCallback, useState } from 'react';
import ReactDOM from 'react-dom/client';

import { HostedAuthGate } from '@features/hosted-access/renderer';
import { LocalizationProvider } from '@features/localization/renderer';
import { HostedApplicationShell } from '@renderer/hosted/HostedApplicationShell';
import { parseBootId, parseDeploymentId } from '@shared/contracts/hosted';

import type { HostedAuthStatus } from '@features/hosted-access/contracts';

const HostedAuthenticatedApplication = (): React.JSX.Element => {
  const [runtimeIdentity, setRuntimeIdentity] = useState<
    Readonly<{ deploymentId: ReturnType<typeof parseDeploymentId>; bootId: ReturnType<typeof parseBootId> }> | undefined
  >();
  const acceptAuthentication = useCallback((auth: HostedAuthStatus): void => {
    if (auth.deploymentId === null || auth.bootId === null) {
      setRuntimeIdentity((current) => (current === undefined ? current : undefined));
      return;
    }
    try {
      const deploymentId = parseDeploymentId(auth.deploymentId);
      const bootId = parseBootId(auth.bootId);
      setRuntimeIdentity((current) =>
        current?.deploymentId === deploymentId && current.bootId === bootId
          ? current
          : { deploymentId, bootId }
      );
    } catch {
      setRuntimeIdentity((current) => (current === undefined ? current : undefined));
    }
  }, []);
  return (
    <HostedAuthGate onAuthenticated={acceptAuthentication}>
      <HostedApplicationShell runtimeIdentity={runtimeIdentity} />
    </HostedAuthGate>
  );
};

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Hosted renderer root is unavailable.');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <LocalizationProvider appConfig={null}>
      <HostedAuthenticatedApplication />
    </LocalizationProvider>
  </React.StrictMode>
);
