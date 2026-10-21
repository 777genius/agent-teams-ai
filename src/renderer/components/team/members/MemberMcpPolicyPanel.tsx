import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Checkbox } from '@renderer/components/ui/checkbox';
import { Input } from '@renderer/components/ui/input';
import { Label } from '@renderer/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { cn } from '@renderer/lib/utils';
import {
  normalizeTeamMemberMcpPolicy,
  resolveTeamMemberMcpScopes,
} from '@shared/utils/teamMemberMcpPolicy';

import { MEMBER_MCP_SCOPE_LABEL_KEYS } from './memberDraftRowText';
import * as modelTone from './memberModelToneClasses';

import type { TeamMemberMcpMode, TeamMemberMcpPolicy } from '@shared/types';

interface MemberMcpPolicyPanelProps {
  memberId: string;
  mcpPolicy?: TeamMemberMcpPolicy;
  agentTeamsMcpLocked: boolean;
  onMcpPolicyChange: (id: string, policy: TeamMemberMcpPolicy | undefined) => void;
}

/** Expanded per-member MCP inheritance panel (mode, scopes, allowlist). */
export const MemberMcpPolicyPanel = ({
  memberId,
  mcpPolicy,
  agentTeamsMcpLocked,
  onMcpPolicyChange,
}: MemberMcpPolicyPanelProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const effectiveMcpPolicy = agentTeamsMcpLocked ? { mode: 'appOnly' as const } : mcpPolicy;
  const mcpMode: TeamMemberMcpMode = effectiveMcpPolicy?.mode ?? 'inheritLead';
  const mcpScopes = resolveTeamMemberMcpScopes(effectiveMcpPolicy);
  const mcpServerNames = effectiveMcpPolicy?.serverNames ?? [];
  const mcpSettingInfoText = agentTeamsMcpLocked
    ? t('memberDraft.mcp.lockedInfo')
    : t('memberDraft.mcp.settingInfo');

  const updateMcpPolicy = (policy: TeamMemberMcpPolicy | undefined): void => {
    if (agentTeamsMcpLocked) {
      return;
    }
    onMcpPolicyChange(memberId, normalizeTeamMemberMcpPolicy(policy));
  };

  const handleMcpModeChange = (mode: string): void => {
    if (mode === 'inheritLead') {
      updateMcpPolicy(undefined);
      return;
    }
    if (mode === 'appOnly') {
      updateMcpPolicy({ mode: 'appOnly' });
      return;
    }
    if (mode === 'inheritScopes' || mode === 'strictAllowlist') {
      updateMcpPolicy({
        mode,
        scopes: mcpScopes,
        ...(mode === 'strictAllowlist' && mcpServerNames.length > 0
          ? { serverNames: mcpServerNames }
          : {}),
      });
    }
  };

  const updateMcpScope = (scope: 'user' | 'project' | 'local', enabled: boolean): void => {
    if (mcpMode !== 'inheritScopes' && mcpMode !== 'strictAllowlist') {
      return;
    }
    updateMcpPolicy({
      mode: mcpMode,
      scopes: { ...mcpScopes, [scope]: enabled },
      ...(mcpMode === 'strictAllowlist' && mcpServerNames.length > 0
        ? { serverNames: mcpServerNames }
        : {}),
    });
  };

  const updateMcpServerNames = (value: string): void => {
    const serverNames = value
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    updateMcpPolicy({
      mode: 'strictAllowlist',
      scopes: mcpScopes,
      serverNames,
    });
  };

  return (
    <div className="space-y-3 pl-3 md:col-span-3">
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
        <div className="grid gap-3 sm:grid-cols-[minmax(160px,220px)_1fr]">
          <div className="space-y-1">
            <Label
              htmlFor={`member-${memberId}-mcp-mode`}
              className="text-[10px] text-[var(--color-text-muted)]"
            >
              {t('memberDraft.mcp.mode')}
            </Label>
            <Select
              value={mcpMode}
              onValueChange={handleMcpModeChange}
              disabled={agentTeamsMcpLocked}
            >
              <SelectTrigger
                id={`member-${memberId}-mcp-mode`}
                className="h-8 text-xs"
                disabled={agentTeamsMcpLocked}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inheritLead">{t('memberDraft.mcp.inheritLead')}</SelectItem>
                <SelectItem value="inheritScopes">{t('memberDraft.mcp.chooseScopes')}</SelectItem>
                <SelectItem value="strictAllowlist">
                  {t('memberDraft.mcp.strictAllowlist')}
                </SelectItem>
                <SelectItem value="appOnly">{t('memberDraft.mcp.agentTeamsMcp')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <div className="grid gap-2 sm:grid-cols-3">
              {(['user', 'project', 'local'] as const).map((scope) => (
                <label
                  key={scope}
                  className={cn(
                    'flex h-8 items-center gap-2 rounded-md border border-[var(--color-border)] px-2 text-xs text-[var(--color-text-secondary)]',
                    (agentTeamsMcpLocked || mcpMode === 'inheritLead' || mcpMode === 'appOnly') &&
                      'opacity-50'
                  )}
                >
                  <Checkbox
                    checked={mcpMode === 'appOnly' ? false : mcpScopes[scope]}
                    disabled={
                      agentTeamsMcpLocked || mcpMode === 'inheritLead' || mcpMode === 'appOnly'
                    }
                    onCheckedChange={(checked) => updateMcpScope(scope, checked === true)}
                  />
                  <span className="capitalize">{t(MEMBER_MCP_SCOPE_LABEL_KEYS[scope])}</span>
                </label>
              ))}
            </div>
            {mcpMode === 'strictAllowlist' ? (
              <div className="space-y-1">
                <Label
                  htmlFor={`member-${memberId}-mcp-servers`}
                  className="text-[10px] text-[var(--color-text-muted)]"
                >
                  {t('memberDraft.mcp.serverNames')}
                </Label>
                <Input
                  id={`member-${memberId}-mcp-servers`}
                  className="h-8 text-xs"
                  value={mcpServerNames.join(', ')}
                  disabled={agentTeamsMcpLocked}
                  onChange={(event) => updateMcpServerNames(event.target.value)}
                  placeholder={t('memberDraft.placeholders.mcpServers')}
                />
              </div>
            ) : null}
            {mcpMode !== 'inheritLead' ? (
              <p className={modelTone.MCP_SETTING_NOTE_CLASS}>{mcpSettingInfoText}</p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};
