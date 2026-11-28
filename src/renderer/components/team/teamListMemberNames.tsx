import { getTeamColorSet } from '@renderer/constants/teamColors';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';

import type { TeamSummaryMember } from '@shared/types';

export function renderMemberNames(members: TeamSummaryMember[]): React.JSX.Element {
  const teamColorMap = buildMemberColorMap(members);
  return (
    <>
      {members.map((m) => {
        const resolvedColor = teamColorMap.get(m.name);
        const memberColor = resolvedColor ? getTeamColorSet(resolvedColor) : null;
        return (
          <span key={m.name} className="inline-flex items-center gap-1">
            <span
              className="text-[10px] font-medium tracking-wide"
              style={memberColor ? { color: memberColor.text } : undefined}
            >
              {m.name}
            </span>
            {m.role ? (
              <span className="text-[9px] text-[var(--color-text-muted)]">{m.role}</span>
            ) : null}
          </span>
        );
      })}
    </>
  );
}
