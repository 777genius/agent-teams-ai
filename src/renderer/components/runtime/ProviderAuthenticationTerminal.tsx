import { useAppTranslation } from '@features/localization/renderer';
import { TerminalModal } from '@renderer/components/terminal/TerminalModal';
import { getRuntimeDisplayName } from '@renderer/utils/runtimeDisplayName';

import {
  getProviderTerminalCommand,
  getProviderTerminalLogoutCommand,
} from './providerTerminalCommands';

import type { CliInstallationStatus, CliProviderId } from '@shared/types';

/** Original legacy terminal presentation. Captured native auth is routed before reaching it. */
export const ProviderAuthenticationTerminal = ({
  status,
  multimodelEnabled,
  request,
  label,
  onClose,
}: {
  readonly status: CliInstallationStatus;
  readonly multimodelEnabled: boolean;
  readonly request: { readonly providerId: CliProviderId; readonly action: 'login' | 'logout' };
  readonly label: string;
  readonly onClose: () => void;
}) => {
  const { t } = useAppTranslation('settings');
  if (!status.binaryPath) return null;
  const provider = status.providers.find((row) => row.providerId === request.providerId);
  const command = provider
    ? request.action === 'login'
      ? getProviderTerminalCommand(provider)
      : getProviderTerminalLogoutCommand(provider)
    : null;
  return (
    <TerminalModal
      title={`${getRuntimeDisplayName(status, multimodelEnabled)} ${request.action === 'login' ? t('cliRuntime.providerTerminal.login') : t('cliRuntime.providerTerminal.logout')}: ${label}`}
      command={status.binaryPath}
      args={command?.args}
      env={command?.env}
      onClose={onClose}
      autoCloseOnSuccessMs={3000}
      successMessage={
        request.action === 'login'
          ? t('cliRuntime.providerTerminal.authUpdated')
          : t('cliRuntime.providerTerminal.loggedOut')
      }
      failureMessage={
        request.action === 'login'
          ? t('cliRuntime.providerTerminal.authFailed')
          : t('cliRuntime.providerTerminal.logoutFailed')
      }
    />
  );
};
