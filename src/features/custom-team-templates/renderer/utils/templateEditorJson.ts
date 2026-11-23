import type { CustomTeamTemplateMemberV1 } from '@features/custom-team-templates/contracts';

export interface TemplateEditorJson {
  name: string;
  description: string;
  teamPrompt: string;
  members: readonly CustomTeamTemplateMemberV1[];
}

/** Reject unknown or incorrectly typed fields rather than silently losing data. */
export function parseTemplateEditorJson(text: string): TemplateEditorJson {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
  const obj = parsed as Record<string, unknown>;
  if (
    Object.keys(obj).some(
      (key) => !['name', 'description', 'teamPrompt', 'members'].includes(key)
    ) ||
    typeof obj.name !== 'string' ||
    typeof obj.teamPrompt !== 'string' ||
    (obj.description !== undefined && typeof obj.description !== 'string') ||
    !Array.isArray(obj.members)
  )
    throw new Error('invalid');
  const members = obj.members.map((value: unknown): CustomTeamTemplateMemberV1 => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    const member = value as Record<string, unknown>;
    if (
      Object.keys(member).some((key) => !['name', 'role', 'workflow'].includes(key)) ||
      typeof member.name !== 'string' ||
      (member.role !== undefined && typeof member.role !== 'string') ||
      (member.workflow !== undefined && typeof member.workflow !== 'string')
    )
      throw new Error('invalid');
    return {
      name: member.name,
      ...(typeof member.role === 'string' ? { role: member.role } : {}),
      ...(typeof member.workflow === 'string' ? { workflow: member.workflow } : {}),
    };
  });
  return {
    name: obj.name,
    description: typeof obj.description === 'string' ? obj.description : '',
    teamPrompt: obj.teamPrompt,
    members,
  };
}
