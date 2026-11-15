import { useEffect, useState } from 'react';

import { isHostTeamSelectionKey } from '@features/agent-backend/contracts';
import { useAppTranslation } from '@features/localization/renderer';
import {
  isMemberLogStreamUiEnabled,
  MemberLogStreamSection,
} from '@features/member-log-stream/renderer';

import { MemberLogsTab } from './MemberLogsTab';

import type { HostLogViewOptions } from './HostMemberActivityLog';
import type { ResolvedTeamMember } from '@shared/types';

interface MemberLogStreamWithLegacyFallbackProps {
  teamName: string;
  member: ResolvedTeamMember;
  enabled?: boolean;
  hostView?: HostLogViewOptions;
}

export const MemberLogStreamWithLegacyFallback = ({
  teamName,
  member,
  enabled = true,
  hostView,
}: Readonly<MemberLogStreamWithLegacyFallbackProps>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const streamUiEnabled = isMemberLogStreamUiEnabled();
  const [showLegacyLogsFallback, setShowLegacyLogsFallback] = useState(false);

  useEffect(() => {
    setShowLegacyLogsFallback(false);
  }, [member.name, streamUiEnabled, teamName]);

  if (isHostTeamSelectionKey(teamName) || !streamUiEnabled) {
    return (
      <MemberLogsTab
        teamName={teamName}
        memberName={member.name}
        enabled={enabled}
        hostView={hostView}
      />
    );
  }

  return (
    <div className="space-y-4">
      <MemberLogStreamSection
        teamName={teamName}
        member={member}
        enabled={enabled}
        onInitialLoadErrorChange={setShowLegacyLogsFallback}
      />
      {showLegacyLogsFallback ? (
        <div className="rounded-md border border-[var(--color-border)] p-3">
          <div className="mb-3 text-xs font-semibold uppercase text-[var(--color-text-muted)]">
            {t('members.detail.legacyLogsFallback')}
          </div>
          <MemberLogsTab teamName={teamName} memberName={member.name} enabled={enabled} />
        </div>
      ) : null}
    </div>
  );
};
