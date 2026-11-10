import { describe, expect, it } from 'vitest';

import { formatSessionLabel, parseSessionTitle } from '@renderer/utils/sessionTitleParser';

describe('parseSessionTitle', () => {
  it('returns regular/Untitled for undefined', () => {
    expect(parseSessionTitle(undefined)).toEqual({
      kind: 'regular',
      displayText: 'Untitled',
    });
  });

  it('returns regular/Untitled for empty string', () => {
    expect(parseSessionTitle('')).toEqual({
      kind: 'regular',
      displayText: 'Untitled',
    });
  });

  it('parses new team provisioning with straight quotes', () => {
    const msg =
      'agent_teams_ui [Agent Team: "summit-ops" | Project: "sol_team_proj" | Lead: "team-lead"] — team does NOT exist yet.';
    const result = parseSessionTitle(msg);
    expect(result).toEqual({
      kind: 'team-new',
      displayText: 'summit-ops',
      teamName: 'summit-ops',
      projectName: 'sol_team_proj',
    });
  });

  it('parses new team provisioning with smart quotes', () => {
    const msg =
      'agent_teams_ui [Agent Team: \u201Csummit-ops\u201D | Project: \u201Csol_team_proj\u201D | Lead: \u201Cteam-lead\u201D] \u2014 team does NOT exist yet.';
    const result = parseSessionTitle(msg);
    expect(result).toEqual({
      kind: 'team-new',
      displayText: 'summit-ops',
      teamName: 'summit-ops',
      projectName: 'sol_team_proj',
    });
  });

  it('parses Team Start as resume', () => {
    const msg =
      'Team Start [Agent Team: "atlas-hq-2" | Project: "sol_team_proj" | Lead: "team-lead"] You are running in a non-interactive CLI session.';
    const result = parseSessionTitle(msg);
    expect(result).toEqual({
      kind: 'team-resume',
      displayText: 'atlas-hq-2',
      teamName: 'atlas-hq-2',
      projectName: 'sol_team_proj',
    });
  });

  it('parses Team Start (resume) as resume', () => {
    const msg =
      'Team Start (resume) [Agent Team: "atlas-hq-2" | Project: "sol_team_proj" | Lead: "team-lead"] You are running...';
    const result = parseSessionTitle(msg);
    expect(result).toEqual({
      kind: 'team-resume',
      displayText: 'atlas-hq-2',
      teamName: 'atlas-hq-2',
      projectName: 'sol_team_proj',
    });
  });

  it('passes through regular text as-is', () => {
    const msg = 'Fix the login bug in auth module';
    const result = parseSessionTitle(msg);
    expect(result).toEqual({
      kind: 'regular',
      displayText: 'Fix the login bug in auth module',
    });
  });

  it('strips single [Image #N] prefix', () => {
    const msg = '[Image #1] Сделай чтобы было без иконки';
    const result = parseSessionTitle(msg);
    expect(result).toEqual({
      kind: 'regular',
      displayText: 'Сделай чтобы было без иконки',
    });
  });

  it('strips multiple [Image #N] prefixes', () => {
    const msg = '[Image #1] [Image #2] Something with two images';
    const result = parseSessionTitle(msg);
    expect(result).toEqual({
      kind: 'regular',
      displayText: 'Something with two images',
    });
  });

  it('returns Untitled when only image prefixes remain', () => {
    const msg = '[Image #1] ';
    const result = parseSessionTitle(msg);
    expect(result).toEqual({
      kind: 'regular',
      displayText: 'Untitled',
    });
  });
});

describe('formatSessionLabel', () => {
  it('returns team name for new team session', () => {
    const msg =
      'agent_teams_ui [Agent Team: "my-team" | Project: "my-proj" | Lead: "lead"] — team does NOT exist yet.';
    expect(formatSessionLabel(msg)).toBe('my-team');
  });

  it('returns team name for resume session', () => {
    const msg = 'Team Start [Agent Team: "my-team" | Project: "proj" | Lead: "lead"] ...';
    expect(formatSessionLabel(msg)).toBe('my-team');
  });

  it('returns cleaned text for regular session', () => {
    expect(formatSessionLabel('Hello world')).toBe('Hello world');
  });

  it('returns Untitled for undefined', () => {
    expect(formatSessionLabel(undefined)).toBe('Untitled');
  });
});
