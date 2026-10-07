import { useAppTranslation } from '@features/localization/renderer';
import { TEAM_TEMPLATES } from '@features/team-templates';
import {
  RosterParticipantFrame,
  RosterParticipantIdentity,
} from '@renderer/components/team/members/RosterParticipantFrame';
import { Button } from '@renderer/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { agentAvatarUrl, buildMemberAvatarMap } from '@renderer/utils/memberHelpers';
import { buildTeamMemberColorMap } from '@shared/utils/teamMemberColors';
import { ChevronDown } from 'lucide-react';

export function TeamTemplateReferences({
  isLight,
}: Readonly<{ isLight: boolean }>): React.JSX.Element {
  const { t } = useAppTranslation('team');
  return (
    <section className="min-w-0 space-y-3" aria-label={t('externalPrompt.templatesTitle')}>
      <h3 className="text-sm font-semibold">{t('externalPrompt.templatesTitle')}</h3>
      {TEAM_TEMPLATES.map((template) => {
        const participants = [
          {
            name: 'team-lead',
            role: t('externalPrompt.coordinator'),
            workflow: template.teamPrompt,
          },
          ...template.members,
        ];
        const colors = buildTeamMemberColorMap(participants, { preferProvidedColors: false });
        const avatars = buildMemberAvatarMap(participants);
        return (
          <div
            key={template.id}
            className="min-w-0 rounded-md border border-[var(--color-border)]"
            data-template-reference={template.id}
          >
            <div className="flex flex-wrap items-start justify-between gap-2 p-3">
              <div className="min-w-0 flex-1">
                <h4 className="text-sm font-medium">{template.name}</h4>
                <p className="mt-1 break-words text-xs text-[var(--color-text-muted)]">
                  {template.description}
                </p>
              </div>
            </div>
            {participants.map((member) => (
              <Collapsible key={member.name}>
                <RosterParticipantFrame
                  accentColor={getTeamColorSet(colors.get(member.name) ?? '').border}
                  isLight={isLight}
                  layout="flat"
                  dataRole="template-participant"
                >
                  <RosterParticipantIdentity
                    avatarSrc={avatars.get(member.name) ?? agentAvatarUrl(member.name, 32)}
                  >
                    <span className="min-w-0 break-words text-xs font-medium">{member.name}</span>
                  </RosterParticipantIdentity>
                  <p className="flex min-h-8 min-w-0 items-center break-words text-xs text-[var(--color-text-secondary)]">
                    {member.role}
                  </p>
                  <CollapsibleTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-auto min-h-8 max-w-full justify-start whitespace-normal text-left"
                      aria-label={t('externalPrompt.responsibilitiesFor', { name: member.name })}
                    >
                      {t('externalPrompt.responsibilities')}
                      <ChevronDown className="size-3.5 shrink-0" />
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="min-w-0 whitespace-pre-wrap break-words text-xs text-[var(--color-text-muted)] md:col-span-3">
                    {member.workflow}
                  </CollapsibleContent>
                </RosterParticipantFrame>
              </Collapsible>
            ))}
          </div>
        );
      })}
    </section>
  );
}
