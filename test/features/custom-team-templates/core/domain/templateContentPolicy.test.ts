import { CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION } from '@features/custom-team-templates/contracts';
import {
  projectTemplateContent,
  validateTemplateContent,
} from '@features/custom-team-templates/core/domain/templateContentPolicy';
import {
  TEMPLATE_MAX_MEMBERS,
  TEMPLATE_MEMBER_ROLE_MAX_LENGTH,
  TEMPLATE_MEMBER_WORKFLOW_MAX_LENGTH,
  TEMPLATE_TEAM_PROMPT_MAX_LENGTH,
} from '@features/custom-team-templates/core/domain/templateLimits';
import { describe, expect, it } from 'vitest';

import type { CustomTeamTemplateContentV1 } from '@features/custom-team-templates/contracts';

const prompt = 'Coordinate the team around the goal.';

describe('projectTemplateContent', () => {
  it('projects only the allowlisted fields and drops unlisted source configuration', () => {
    // These source fields must never reach the projected template.
    const unlistedSourceFields = {
      providerId: 'anthropic',
      providerBackendId: 'cli-sdk',
      model: 'claude-opus-4',
      effort: 'high',
      mcpPolicy: { mode: 'appOnly' },
      isolation: 'worktree',
      agentId: 'agent-1',
      cwd: '/home/user/secret-project',
      color: '#fff',
      joinedAt: 1,
    };

    const result = projectTemplateContent({
      sourceTeamName: 'demo-team',
      teamPrompt: `  ${prompt}  `,
      roster: {
        status: 'readable',
        members: [
          {
            name: 'engineer',
            role: 'Software Engineer',
            workflow: 'Build the agreed product.',
            agentType: 'general-purpose',
            ...unlistedSourceFields,
          },
        ],
      },
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.content).toEqual({
      schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
      teamPrompt: prompt,
      members: [
        { name: 'engineer', role: 'Software Engineer', workflow: 'Build the agreed product.' },
      ],
    });
    const serialized = JSON.stringify(result.content);
    expect(serialized).not.toContain('anthropic');
    expect(serialized).not.toContain('secret-project');
    expect(serialized).not.toContain('mcpPolicy');
    expect(result.warnings).toEqual([]);
  });

  it('allows a prompt-only template when roster metadata is absent', () => {
    const result = projectTemplateContent({
      sourceTeamName: 'demo-team',
      teamPrompt: prompt,
      roster: { status: 'absent' },
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.content.members).toEqual([]);
    expect(result.warnings).toEqual([{ code: 'noRecordedRoster' }]);
  });

  it('allows a readable empty roster with a distinct prompt-only note', () => {
    const result = projectTemplateContent({
      sourceTeamName: 'demo-team',
      teamPrompt: prompt,
      roster: { status: 'readable', members: [] },
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.content.members).toEqual([]);
    expect(result.warnings).toEqual([{ code: 'emptyRoster' }]);
  });

  it('blocks projection when roster metadata is unreadable', () => {
    const result = projectTemplateContent({
      sourceTeamName: 'demo-team',
      teamPrompt: prompt,
      roster: { status: 'unreadable' },
    });

    expect(result).toEqual({ status: 'rosterUnreadable', sourceTeamName: 'demo-team' });
  });

  it('warns about a missing team prompt', () => {
    const result = projectTemplateContent({
      sourceTeamName: 'demo-team',
      roster: { status: 'absent' },
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.content.teamPrompt).toBe('');
    expect(result.warnings).toEqual([{ code: 'missingTeamPrompt' }, { code: 'noRecordedRoster' }]);
  });

  it('warns about missing role and workflow without fabricating values', () => {
    const result = projectTemplateContent({
      sourceTeamName: 'demo-team',
      teamPrompt: prompt,
      roster: { status: 'readable', members: [{ name: 'qa' }] },
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(Object.keys(result.content.members[0])).toEqual(['name']);
    expect(result.warnings).toEqual([
      { code: 'missingMemberRole', memberName: 'qa' },
      { code: 'missingMemberWorkflow', memberName: 'qa' },
    ]);
  });

  it('warns about removed teammates only with a verified authoritative count', () => {
    const withoutRemoved = projectTemplateContent({
      sourceTeamName: 'demo-team',
      teamPrompt: prompt,
      roster: {
        status: 'readable',
        members: [{ name: 'qa', role: 'QA', workflow: 'Verify.' }],
      },
    });
    expect(withoutRemoved.status).toBe('ready');
    if (withoutRemoved.status !== 'ready') return;
    expect(withoutRemoved.warnings).toEqual([]);

    const withRemoved = projectTemplateContent({
      sourceTeamName: 'demo-team',
      teamPrompt: prompt,
      roster: {
        status: 'readable',
        members: [
          { name: 'qa', role: 'QA', workflow: 'Verify.' },
          { name: 'legacy', role: 'Developer', workflow: 'Old work.', removed: true },
        ],
      },
    });
    expect(withRemoved.status).toBe('ready');
    if (withRemoved.status !== 'ready') return;
    expect(withRemoved.content.members.map((member) => member.name)).toEqual(['qa']);
    expect(withRemoved.warnings).toEqual([{ code: 'removedMembersExcluded', count: 1 }]);
  });

  it('excludes canonical lead identities from the projection and the removed count', () => {
    const result = projectTemplateContent({
      sourceTeamName: 'demo-team',
      teamPrompt: prompt,
      roster: {
        status: 'readable',
        members: [
          { name: 'team-lead', agentType: 'team-lead', role: 'Lead', removed: true },
          { name: 'legacy-lead', role: 'Orchestrator' },
          { name: 'engineer', role: 'Engineer', workflow: 'Build.' },
        ],
      },
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.content.members.map((member) => member.name)).toEqual(['engineer']);
    expect(result.warnings).toEqual([]);
  });

  it('projects a lone dev-2 member when the base dev name is absent', () => {
    const result = projectTemplateContent({
      sourceTeamName: 'demo-team',
      teamPrompt: prompt,
      roster: {
        status: 'readable',
        members: [{ name: 'dev-2', role: 'Developer', workflow: 'Ship.' }],
      },
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.content.members.map((member) => member.name)).toEqual(['dev-2']);
    expect(result.warnings).toEqual([]);
    expect(validateTemplateContent(result.content)).toEqual([]);
  });

  it('drops only the auto-suffixed duplicate when both dev and dev-2 are present', () => {
    const result = projectTemplateContent({
      sourceTeamName: 'demo-team',
      teamPrompt: prompt,
      roster: {
        status: 'readable',
        members: [
          { name: 'dev', role: 'Developer', workflow: 'Design.' },
          { name: 'dev-2', role: 'Developer', workflow: 'Ship.' },
        ],
      },
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.content.members.map((member) => member.name)).toEqual(['dev']);
    expect(result.warnings).toEqual([]);
  });

  it('projects a higher suffixed name only when its base name is absent', () => {
    const lone = projectTemplateContent({
      sourceTeamName: 'demo-team',
      teamPrompt: prompt,
      roster: {
        status: 'readable',
        members: [{ name: 'dev-3', role: 'Developer', workflow: 'Ship.' }],
      },
    });
    expect(lone.status).toBe('ready');
    if (lone.status !== 'ready') return;
    expect(lone.content.members.map((member) => member.name)).toEqual(['dev-3']);

    const colliding = projectTemplateContent({
      sourceTeamName: 'demo-team',
      teamPrompt: prompt,
      roster: {
        status: 'readable',
        members: [
          { name: 'dev', role: 'Developer', workflow: 'Design.' },
          { name: 'dev-3', role: 'Developer', workflow: 'Ship.' },
        ],
      },
    });
    expect(colliding.status).toBe('ready');
    if (colliding.status !== 'ready') return;
    expect(colliding.content.members.map((member) => member.name)).toEqual(['dev']);
  });

  it('keeps an intentional -1 suffix alongside its base name', () => {
    const result = projectTemplateContent({
      sourceTeamName: 'demo-team',
      teamPrompt: prompt,
      roster: {
        status: 'readable',
        members: [
          { name: 'dev', role: 'Developer', workflow: 'Design.' },
          { name: 'dev-1', role: 'Developer', workflow: 'Support.' },
        ],
      },
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.content.members.map((member) => member.name)).toEqual(['dev', 'dev-1']);
  });
});

describe('validateTemplateContent', () => {
  const content = (
    members: readonly { name: string; role?: string; workflow?: string }[]
  ): CustomTeamTemplateContentV1 => ({
    schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
    teamPrompt: 'Prompt.',
    members,
  });

  it('accepts content without any issues', () => {
    expect(
      validateTemplateContent(content([{ name: 'engineer', role: 'R', workflow: 'W' }]))
    ).toEqual([]);
  });

  it('rejects blank, malformed and reserved member names', () => {
    const issues = validateTemplateContent(
      content([{ name: 'user' }, { name: 'bad name' }, { name: '' }])
    );
    expect(issues).toContainEqual({ code: 'memberNameInvalid', field: 'members[0].name' });
    expect(issues).toContainEqual({ code: 'memberNameInvalid', field: 'members[1].name' });
    expect(issues).toContainEqual({ code: 'memberNameRequired', field: 'members[2].name' });
  });

  it('rejects duplicate member names case-insensitively', () => {
    const issues = validateTemplateContent(content([{ name: 'Engineer' }, { name: 'engineer' }]));
    expect(issues).toContainEqual({ code: 'duplicateMemberName', field: 'members[1].name' });
  });

  it('recognizes Unicode-equivalent names as duplicates without rewriting display values', () => {
    const composed = 'caf\u00e9';
    const decomposed = 'cafe\u0301';
    expect(composed).not.toBe(decomposed);
    expect(composed.normalize('NFC')).toBe(decomposed.normalize('NFC'));
    const issues = validateTemplateContent(content([{ name: composed }, { name: decomposed }]));
    expect(issues).toContainEqual({ code: 'duplicateMemberName', field: 'members[1].name' });

    const result = projectTemplateContent({
      sourceTeamName: 'demo-team',
      teamPrompt: prompt,
      roster: {
        status: 'readable',
        members: [{ name: composed, role: 'Developer', workflow: 'Ship.' }],
      },
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.content.members.map((member) => member.name)).toEqual([composed]);
  });

  it('recognizes names differing only by surrounding or repeated whitespace as duplicates', () => {
    const issues = validateTemplateContent(
      content([{ name: 'Data  Engineer' }, { name: '  data engineer ' }])
    );
    expect(issues).toContainEqual({ code: 'duplicateMemberName', field: 'members[1].name' });
  });

  it('still rejects reserved names while allowing a legitimate lone dev-2', () => {
    expect(validateTemplateContent(content([{ name: 'dev-2' }]))).toEqual([]);
    expect(validateTemplateContent(content([{ name: 'dev' }, { name: 'dev-2' }]))).toContainEqual({
      code: 'memberNameInvalid',
      field: 'members[1].name',
    });
    expect(validateTemplateContent(content([{ name: 'user' }]))).toContainEqual({
      code: 'memberNameInvalid',
      field: 'members[0].name',
    });
  });

  it('rejects oversized content without truncating it', () => {
    const oversizedPrompt = 'x'.repeat(TEMPLATE_TEAM_PROMPT_MAX_LENGTH + 1);
    expect(
      validateTemplateContent({
        schemaVersion: CUSTOM_TEAM_TEMPLATE_SCHEMA_VERSION,
        teamPrompt: oversizedPrompt,
        members: [],
      })
    ).toContainEqual({ code: 'teamPromptTooLong', field: 'teamPrompt' });

    const tooMany = Array.from({ length: TEMPLATE_MAX_MEMBERS + 1 }, (_, index) => ({
      name: `member-${index}`,
    }));
    expect(validateTemplateContent(content(tooMany))).toContainEqual({
      code: 'tooManyMembers',
      field: 'members',
    });

    expect(
      validateTemplateContent(
        content([
          {
            name: 'engineer',
            role: 'r'.repeat(TEMPLATE_MEMBER_ROLE_MAX_LENGTH + 1),
            workflow: 'w'.repeat(TEMPLATE_MEMBER_WORKFLOW_MAX_LENGTH + 1),
          },
        ])
      )
    ).toEqual(
      expect.arrayContaining([
        { code: 'memberRoleTooLong', field: 'members[0].role' },
        { code: 'memberWorkflowTooLong', field: 'members[0].workflow' },
      ])
    );
  });
});
