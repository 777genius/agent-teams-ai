import { useEffect, useRef } from 'react';

import { useRuntimeProviderManagement } from './hooks/useRuntimeProviderManagement';
import { ProviderSetupFormPanel } from './ui/RuntimeProviderManagementPanelView';

/** Existing sign-in form over the captured Claude owner; native command/profile never reaches UI. */
export const CapturedClaudeAuthenticationPanel = ({
  open,
  projectPath,
  action,
  connectionContextToken,
  captureError,
  onChanged,
}: {
  readonly open: boolean;
  readonly projectPath: string | null;
  readonly action: 'login' | 'logout';
  readonly connectionContextToken?: string;
  readonly captureError?: string;
  readonly onChanged?: () => Promise<boolean | void> | boolean | void;
}) => {
  const [state, actions] = useRuntimeProviderManagement({
    runtimeId: 'claude',
    enabled: open && !!connectionContextToken && !captureError,
    connectionContextToken,
    projectPath,
    initialProviderId: 'anthropic',
    initialProviderAction: action === 'login' ? 'connect' : 'select',
    loadViewOnEnable: false,
    searchDirectoryOnQueryChange: false,
    onProviderChanged: onChanged,
  });
  const dispatched = useRef(false);
  const forget = actions.forgetProvider;
  useEffect(() => {
    if (
      open &&
      connectionContextToken &&
      !captureError &&
      action === 'logout' &&
      !dispatched.current
    ) {
      dispatched.current = true; // Original explicit sign-out only, including uncertain results.
      void forget('anthropic');
    }
  }, [action, captureError, connectionContextToken, forget, open]);
  const cancel = useRef(actions.cancelConnect);
  cancel.current = actions.cancelConnect;
  useEffect(() => () => cancel.current(), []);
  if (captureError || !connectionContextToken)
    return (
      <div role="alert" className="text-xs text-text-secondary">
        {captureError ?? 'Refresh the original Claude account before signing in.'}
      </div>
    );
  if (action === 'logout')
    return (
      <div role="status" className="text-xs text-text-secondary">
        {state.error ?? state.warningMessage ?? state.successMessage ?? 'Signing out…'}
      </div>
    );
  return (
    <ProviderSetupFormPanel
      provider={{ providerId: 'anthropic', displayName: 'Claude' }}
      state={state}
      actions={actions}
      busy={state.savingProviderId === 'anthropic'}
      disabled={!open}
    />
  );
};
