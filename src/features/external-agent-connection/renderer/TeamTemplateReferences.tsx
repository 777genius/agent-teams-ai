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
import { ChevronDown, Code2, Megaphone, PenLine, Search } from 'lucide-react';

import type { TeamTemplateV1 } from '@features/team-templates';
import type { LucideIcon } from 'lucide-react';

const TEMPLATE_ICONS = {
  'software-product': Code2,
  marketing: Megaphone,
  content: PenLine,
  research: Search,
} satisfies Record<TeamTemplateV1['id'], LucideIcon>;

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
        const Icon = TEMPLATE_ICONS[template.id];
        return (
          <Collapsible
            key={template.id}
            className="min-w-0 rounded-md border border-[var(--color-border)]"
            data-template-reference={template.id}
          >
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="group h-auto w-full justify-start gap-3 whitespace-normal p-3 text-left"
              >
                <Icon className="size-5 shrink-0 text-[var(--color-accent)]" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">
                    {t(`templates.names.${template.id}`)}
                  </span>
                  <span className="mt-1 block break-words text-xs font-normal text-[var(--color-text-muted)]">
                    {t(`templates.descriptions.${template.id}`)}
                  </span>
                </span>
                <ChevronDown
                  className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180"
                  aria-hidden="true"
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
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
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </section>
  );
}
