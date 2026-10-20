import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';

import {
  bindGatewayMember,
  listGatewayBindings,
  listGatewayProfiles,
  probeGatewayModels,
  unbindGatewayMember,
} from '../adapters/gatewayProviderApi';

import type {
  GatewayMemberBindingDto,
  GatewayProfileDto,
} from '@features/gateway-provider/contracts';

interface MemberGatewaySelectorProps {
  teamName: string;
  memberName: string;
  originalName?: string;
  selectedModel?: string;
  onModelChange: (model: string) => void;
}

type GatewayErrorKind = 'authRejected' | 'unavailable' | 'message';

function classifyGatewayError(error: unknown): { kind: GatewayErrorKind; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP (401|403)/.test(message)) return { kind: 'authRejected', message };
  if (/timed out|unreachable|HTTP 5\d\d/i.test(message)) return { kind: 'unavailable', message };
  return { kind: 'message', message };
}

/**
 * Lets one teammate run models through a gateway profile: pick the profile,
 * probe its API key via GET /v1/models (= the key test), then bind the key.
 * The key itself is forwarded to the API and never kept in rendered state.
 */
export const MemberGatewaySelector = ({
  teamName,
  memberName,
  originalName,
  selectedModel,
  onModelChange,
}: MemberGatewaySelectorProps): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const [profiles, setProfiles] = useState<GatewayProfileDto[]>([]);
  const [bindings, setBindings] = useState<GatewayMemberBindingDto[]>([]);
  const [profileId, setProfileId] = useState('');
  const [models, setModels] = useState<string[] | null>(null);
  const [modelChoice, setModelChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [keyReady, setKeyReady] = useState(false);
  const [errorKind, setErrorKind] = useState<GatewayErrorKind | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const keyInputRef = useRef<HTMLInputElement | null>(null);
  const keyRef = useRef('');

  const trimmedMemberName = memberName.trim();
  const renamed =
    Boolean(originalName?.trim()) && (originalName?.trim() ?? '') !== trimmedMemberName;

  const refresh = useCallback(async () => {
    try {
      const [nextProfiles, nextBindings] = await Promise.all([
        listGatewayProfiles(),
        listGatewayBindings(teamName),
      ]);
      setProfiles(nextProfiles);
      setBindings(nextBindings);
    } catch (error) {
      const classified = classifyGatewayError(error);
      setErrorKind(classified.kind);
      setErrorMessage(classified.message);
    }
  }, [teamName]);

  useEffect(() => {
    void refresh();
    return () => {
      keyRef.current = '';
    };
  }, [refresh]);

  const binding = bindings.find(
    (candidate) =>
      candidate.memberName === trimmedMemberName ||
      Boolean(originalName?.trim()) && candidate.memberName === originalName?.trim()
  );

  const clearKeyInput = (): void => {
    keyRef.current = '';
    setKeyReady(false);
    if (keyInputRef.current) keyInputRef.current.value = '';
  };

  const showError = (error: unknown): void => {
    const classified = classifyGatewayError(error);
    setErrorKind(classified.kind);
    setErrorMessage(classified.message);
  };

  const resolveErrorText = (kind: GatewayErrorKind, message: string): string => {
    if (kind === 'authRejected') return t('memberDraft.gateway.authRejected');
    if (kind === 'unavailable') return t('memberDraft.gateway.unavailable');
    return message;
  };

  const handleProfileChange = (value: string): void => {
    setProfileId(value);
    setModels(null);
    setModelChoice('');
    setErrorKind(null);
    setErrorMessage('');
    clearKeyInput();
  };

  const handleProbe = async (): Promise<void> => {
    const key = keyInputRef.current?.value.trim() ?? '';
    if (!key) {
      setErrorKind('message');
      setErrorMessage(t('memberDraft.gateway.keyRequired'));
      return;
    }
    if (!profileId) {
      setErrorKind('message');
      setErrorMessage(t('memberDraft.gateway.profileRequired'));
      return;
    }
    setBusy(true);
    setErrorKind(null);
    setErrorMessage('');
    try {
      const result = await probeGatewayModels({ profileId, apiKey: key });
      keyRef.current = key;
      setKeyReady(true);
      if (keyInputRef.current) keyInputRef.current.value = '';
      setModels(result.models);
      setModelChoice(result.models.includes(selectedModel ?? '') ? (selectedModel ?? '') : '');
      if (result.models.length === 0) {
        setErrorKind('message');
        setErrorMessage(t('memberDraft.gateway.emptyCatalog'));
      }
    } catch (error) {
      clearKeyInput();
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const handleBind = async (): Promise<void> => {
    if (!keyReady || !modelChoice) return;
    setBusy(true);
    setErrorKind(null);
    setErrorMessage('');
    try {
      await bindGatewayMember({
        teamName,
        memberName: trimmedMemberName,
        profileId,
        apiKey: keyRef.current,
      });
      keyRef.current = '';
      setKeyReady(false);
      setModels(null);
      setModelChoice('');
      onModelChange(modelChoice);
      await refresh();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const handleUnbind = async (): Promise<void> => {
    if (!binding) return;
    setBusy(true);
    setErrorKind(null);
    setErrorMessage('');
    try {
      await unbindGatewayMember({
        teamName,
        memberName: binding.memberName,
      });
      clearKeyInput();
      await refresh();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const credentialStatusText = binding
    ? {
        ready: t('memberDraft.gateway.credentialReady'),
        credential_changed: t('memberDraft.gateway.credentialChanged'),
        credential_missing: t('memberDraft.gateway.credentialMissing'),
      }[binding.credentialStatus]
    : null;

  return (
    <div className="space-y-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="text-[11px] font-medium text-[var(--color-text)]">
          {t('memberDraft.gateway.title')}
        </Label>
        <span className="text-[10px] text-[var(--color-text-muted)]">
          {t('memberDraft.gateway.nextLaunchHint')}
        </span>
      </div>
      {renamed ? (
        <p className="text-[10px] leading-snug text-amber-700 dark:text-amber-300">
          {t('memberDraft.gateway.renamedHint')}
        </p>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-[minmax(160px,220px)_1fr]">
        <div className="space-y-1">
          <Label
            htmlFor={`member-${trimmedMemberName}-gateway-profile`}
            className="text-[10px] text-[var(--color-text-muted)]"
          >
            {t('memberDraft.gateway.profileLabel')}
          </Label>
          <Select value={profileId} onValueChange={handleProfileChange} disabled={busy}>
            <SelectTrigger
              id={`member-${trimmedMemberName}-gateway-profile`}
              className="h-8 text-xs"
            >
              <SelectValue placeholder={t('memberDraft.gateway.profilePlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {profiles.map((profile) => (
                <SelectItem key={profile.id} value={profile.id}>
                  {profile.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label
            htmlFor={`member-${trimmedMemberName}-gateway-key`}
            className="text-[10px] text-[var(--color-text-muted)]"
          >
            {t('memberDraft.gateway.apiKeyLabel')}
          </Label>
          <div className="flex gap-2">
            <Input
              id={`member-${trimmedMemberName}-gateway-key`}
              ref={keyInputRef}
              type="password"
              autoComplete="off"
              className="h-8 text-xs"
              placeholder={t('memberDraft.gateway.apiKeyPlaceholder')}
              disabled={busy || !profileId}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0"
              disabled={busy || !profileId}
              onClick={() => void handleProbe()}
            >
              {busy ? t('memberDraft.gateway.probing') : t('memberDraft.gateway.probeButton')}
            </Button>
          </div>
        </div>
      </div>
      {errorKind ? (
        <p role="alert" className="text-[10px] leading-snug text-[var(--field-error-text)]">
          {resolveErrorText(errorKind, errorMessage)}
        </p>
      ) : null}
      {models && models.length > 0 ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[160px] flex-1 space-y-1">
            <Label
              htmlFor={`member-${trimmedMemberName}-gateway-model`}
              className="text-[10px] text-[var(--color-text-muted)]"
            >
              {t('memberDraft.gateway.modelLabel')}
            </Label>
            <Select value={modelChoice} onValueChange={setModelChoice} disabled={busy}>
              <SelectTrigger
                id={`member-${trimmedMemberName}-gateway-model`}
                className="h-8 text-xs"
              >
                <SelectValue placeholder={t('memberDraft.gateway.modelPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {models.map((model) => (
                  <SelectItem key={model} value={model}>
                    {model}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            size="sm"
            className="h-8 shrink-0"
            disabled={busy || !modelChoice || !keyReady}
            onClick={() => void handleBind()}
          >
            {t('memberDraft.gateway.bindButton')}
          </Button>
        </div>
      ) : null}
      {binding ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-[var(--color-text-secondary)]">
          <span>
            {t('memberDraft.gateway.bindingStatus', { profile: binding.profileDisplayName })}
            {credentialStatusText ? ` · ${credentialStatusText}` : ''}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 text-[10px] text-red-700 hover:text-red-700 dark:text-red-300"
            disabled={busy}
            onClick={() => void handleUnbind()}
          >
            {t('memberDraft.gateway.unbindButton')}
          </Button>
        </div>
      ) : null}
    </div>
  );
};
