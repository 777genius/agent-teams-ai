import type { usePublishOpenCodeProviderScopedStatus } from './useOpenCodeProviderScopedModelAuthority';
import type { TeamProviderId } from '@shared/types';
import type React from 'react';

export interface TeamModelSelectorProps {
  providerId: TeamProviderId;
  onProviderChange: (providerId: TeamProviderId) => void;
  value: string;
  onValueChange: (value: string) => void;
  /** Automatic catalog changes never count as manual user edits. */
  onNormalizedValueChange?: (value: string) => void;
  preserveSelectedModel?: boolean;
  limitContext?: boolean;
  projectPath?: string | null;
  id?: string;
  disableGeminiOption?: boolean;
  providerNoticeById?: Partial<Record<TeamProviderId, React.ReactNode>>;
  providerDisabledReasonById?: Partial<Record<TeamProviderId, string | null | undefined>>;
  providerDisabledBadgeLabelById?: Partial<Record<TeamProviderId, string | null | undefined>>;
  providerReadyById?: Partial<Record<TeamProviderId, boolean>>;
  modelAdvisoryReasonByValue?: Partial<Record<string, string | null | undefined>>;
  modelIssueReasonByValue?: Partial<Record<string, string | null | undefined>>;
  modelUnavailableReasonByValue?: Partial<Record<string, string | null | undefined>>;
  onOpenProviderSettings?: (providerId: TeamProviderId) => void;
  onManageProviders?: (providerId: TeamProviderId) => void;
  onOpenCodeProviderScopedStatusChange?: Parameters<
    typeof usePublishOpenCodeProviderScopedStatus
  >[0];
}
