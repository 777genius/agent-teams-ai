import { memo, useMemo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { useStore } from '@renderer/store';
import { Activity } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { CollapsibleTeamSection } from './CollapsibleTeamSection';
import { LiveRuntimeStatusSection } from './LiveRuntimeStatusSection';
import {
  buildTeamRuntimeDisplayRows,
  type TeamRuntimeDisplayMember,
} from './teamRuntimeDisplayRows';

export const TEAM_RUNTIME_UI_DECOUPLING_STORAGE_KEY = 'teamRuntimeUiDecouplingEnabled';

interface LiveRuntimeStatusBridgeProps {
  teamName: string;
  members: readonly TeamRuntimeDisplayMember[];
}

export const LiveRuntimeStatusBridge = memo(function LiveRuntimeStatusBridge({
  teamName,
  members,
}: LiveRuntimeStatusBridgeProps): React.JSX.Element | null {
  if (!isTeamRuntimeUiDecouplingEnabled()) return null;

  return <LiveRuntimeStatusStoreBridge teamName={teamName} members={members} />;
});

const LiveRuntimeStatusStoreBridge = memo(function LiveRuntimeStatusStoreBridge({
  teamName,
  members,
}: LiveRuntimeStatusBridgeProps): React.JSX.Element | null {
  const { t } = useAppTranslation('team');
  const { runtimeSnapshot, spawnStatuses } = useStore(
    useShallow((s) => ({
      runtimeSnapshot: s.teamAgentRuntimeByTeam[teamName],
      spawnStatuses: s.memberSpawnStatusesByTeam[teamName],
    }))
  );
  const rows = useMemo(
    () =>
      buildTeamRuntimeDisplayRows({
        members,
        runtimeSnapshot,
        spawnStatuses,
      }),
    [members, runtimeSnapshot, spawnStatuses]
  );

  if (rows.length === 0) return null;

  const liveCount = rows.filter((row) => row.state === 'running').length;
  const attentionCount = rows.filter((row) => row.state === 'degraded').length;
  const badge = attentionCount > 0 ? attentionCount : liveCount > 0 ? liveCount : undefined;

  return (
    <CollapsibleTeamSection
      sectionId="live-runtime-status"
      title={t('liveRuntimeStatus.title')}
      icon={<Activity size={14} />}
      badge={badge}
      defaultOpen={false}
    >
      <LiveRuntimeStatusSection rows={rows} />
    </CollapsibleTeamSection>
  );
});

export function isTeamRuntimeUiDecouplingEnabled(): boolean {
  if (typeof window === 'undefined') return false;

  try {
    return window.localStorage.getItem(TEAM_RUNTIME_UI_DECOUPLING_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}
