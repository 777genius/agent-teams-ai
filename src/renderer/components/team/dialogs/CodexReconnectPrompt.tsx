import React from 'react';

import { CodexLoginLinkCopyButton } from '@renderer/components/runtime/CodexLoginLinkCopyButton';
import { LogIn } from 'lucide-react';

import type { ProvisioningProviderCheck } from './ProvisioningProviderStatusList';
import type { CliInstallationStatus, TeamProviderId } from '@shared/types';

function containsReconnectCue(text: string | null | undefined): boolean {
  if (!text) {
    return false;
  }

  const lower = text.toLowerCase();
  return lower.includes('session needs reconnect') || lower.includes('reconnect chatgpt');
}

export function shouldShowCodexReconnectPrompt({
  effectiveCliStatus,
  selectedProviderIds,
  prepareMessage,
  prepareChecks,
}: {
  effectiveCliStatus: CliInstallationStatus | null;
  selectedProviderIds: readonly TeamProviderId[];
  prepareMessage: string | null;
  prepareChecks: readonly ProvisioningProviderCheck[];
}): boolean {
  if (!selectedProviderIds.includes('codex')) {
    return false;
  }

  const codexProvider = effectiveCliStatus?.providers.find(
    (provider) => provider.providerId === 'codex'
  );
  const codexConnection = codexProvider?.connection?.codex;
  const loginStatus = codexConnection?.login.status;
  const loginPending = loginStatus === 'starting' || loginStatus === 'pending';
  if (loginPending && codexConnection?.login.authUrl) {
    return true;
  }

  const codexNeedsReconnect =
    Boolean(codexConnection?.localActiveChatgptAccountPresent) &&
    codexConnection?.launchAllowed !== true &&
    !loginPending;

  if (!codexNeedsReconnect) {
    return false;
  }

  if (containsReconnectCue(prepareMessage)) {
    return true;
  }

  return prepareChecks.some(
    (check) =>
      check.providerId === 'codex' && check.details.some((detail) => containsReconnectCue(detail))
  );
}

export function CodexReconnectPrompt({
  authUrl,
  reconnectBusy,
  onReconnect,
}: {
  authUrl: string | null;
  reconnectBusy: boolean;
  onReconnect: () => void;
}): React.JSX.Element {
  return (
    <div
      className="mt-2 rounded-md border px-2.5 py-2"
      style={{
        borderColor: 'rgba(245, 158, 11, 0.28)',
        backgroundColor: 'rgba(245, 158, 11, 0.08)',
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-[11px] text-amber-100/90">
          Codex found the local ChatGPT account, but this session is stale. Reconnect ChatGPT, then
          finish login in the browser and retry this dialog.
        </p>
        <CodexLoginLinkCopyButton authUrl={authUrl} disabled={reconnectBusy} size="xs" />
        <button
          type="button"
          onClick={onReconnect}
          disabled={reconnectBusy}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium text-amber-300 transition-colors hover:bg-white/5 disabled:opacity-50"
          style={{
            borderColor: 'rgba(245, 158, 11, 0.34)',
            backgroundColor: 'rgba(245, 158, 11, 0.08)',
          }}
        >
          <LogIn className="size-3" />
          {reconnectBusy ? 'Opening...' : 'Reconnect ChatGPT'}
        </button>
      </div>
    </div>
  );
}
