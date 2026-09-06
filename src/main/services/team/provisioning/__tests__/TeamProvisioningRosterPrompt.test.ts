import { describe, expect, it, vi } from 'vitest';

import {
  buildDeterministicLaunchHydrationPrompt,
  buildPersistentLeadContext,
} from '../TeamProvisioningPromptBuilders';
import {
  buildCreateBootstrapUserPrompt,
  buildLeadRosterIntegrityRules,
  getTeammateRosterMembers,
} from '../TeamProvisioningRosterPrompt';

import type { TeamCreateRequest, TeamLaunchRequest } from '@shared/types';

vi.mock('../TeamProvisioningAgentLanguage', () => ({
  getAgentLanguageInstruction: () => 'IMPORTANT: Communicate in English.',
  getConfiguredAgentLanguageName: () => 'English',
}));

const teammates: TeamCreateRequest['members'] = [
  { name: 'local-worker', role: 'implementer' },
  { name: 'cursor-worker', role: 'reviewer', providerId: 'opencode' },
];

const rosterWithLead: TeamCreateRequest['members'] = [
  { name: 'team-lead', role: 'lead' },
  ...teammates,
];

describe('getTeammateRosterMembers', () => {
  it('filters lead-role entries out of the delegable roster', () => {
    expect(getTeammateRosterMembers(rosterWithLead).map((member) => member.name)).toEqual([
      'local-worker',
      'cursor-worker',
    ]);
  });

  it('keeps teammates whose free-form role merely contains "lead"', () => {
    const roster: TeamCreateRequest['members'] = [
      { name: 'team-lead', role: 'lead' },
      { name: 'ana', role: 'Frontend lead' },
      { name: 'ben', role: 'Tech Lead' },
      { name: 'cleo', role: 'team leader' },
      { name: 'dan', role: 'leadership coach' },
    ];

    expect(getTeammateRosterMembers(roster).map((member) => member.name)).toEqual([
      'ana',
      'ben',
      'cleo',
      'dan',
    ]);
  });

  it('still excludes the lead by reserved role or canonical name', () => {
    const roster: TeamCreateRequest['members'] = [
      { name: 'ana', role: 'Frontend lead' },
      { name: 'team-lead', role: 'Frontend lead' },
      { name: 'orchestra', role: 'orchestrator' },
      { name: 'boss', role: 'Team Lead' },
    ];

    expect(getTeammateRosterMembers(roster).map((member) => member.name)).toEqual(['ana']);
  });
});

describe('buildLeadRosterIntegrityRules', () => {
  it('names the exact roster and forbids invented names and premature lead execution', () => {
    const rules = buildLeadRosterIntegrityRules(['local-worker', 'cursor-worker']);

    expect(rules).toContain('Teammate roster rules (CRITICAL — exact names only):');
    expect(rules).toContain(
      'Your teammates are EXACTLY: local-worker, cursor-worker. No other teammate exists.'
    );
    expect(rules).toContain('NEVER invent, guess, rename, or paraphrase teammate names');
    expect(rules).toContain('WAIT for the owner');
  });
});

describe('buildCreateBootstrapUserPrompt', () => {
  it('wraps the deferred create prompt with the roster and integrity rules', () => {
    const wrapped = buildCreateBootstrapUserPrompt(
      'create one task per teammate: each writes hello-<their-name>.md',
      teammates
    );

    expect(wrapped).toContain('Team roster (authoritative — from the team configuration):');
    expect(wrapped).toContain('- local-worker (role: implementer)');
    expect(wrapped).toContain('- cursor-worker (role: reviewer) [provider: opencode]');
    expect(wrapped).toContain(
      'Your teammates are EXACTLY: local-worker, cursor-worker. No other teammate exists.'
    );
    expect(wrapped).toContain('NEVER invent, guess, rename, or paraphrase teammate names');
    expect(
      wrapped.endsWith(
        'User instructions:\ncreate one task per teammate: each writes hello-<their-name>.md'
      )
    ).toBe(true);
  });

  it('excludes the lead entry from the roster and the EXACTLY list', () => {
    const wrapped = buildCreateBootstrapUserPrompt('do the thing', rosterWithLead);

    expect(wrapped).toContain('Your teammates are EXACTLY: local-worker, cursor-worker.');
    expect(wrapped).not.toContain('EXACTLY: team-lead');
    expect(wrapped).not.toContain('- team-lead (role: lead)');
  });

  it('keeps a teammate whose role contains "lead" in the authoritative roster', () => {
    const wrapped = buildCreateBootstrapUserPrompt('do the thing', [
      { name: 'team-lead', role: 'lead' },
      { name: 'ana', role: 'Frontend lead' },
      ...teammates,
    ]);

    expect(wrapped).toContain('- ana (role: Frontend lead)');
    expect(wrapped).toContain(
      'Your teammates are EXACTLY: ana, local-worker, cursor-worker. No other teammate exists.'
    );
    expect(wrapped).not.toContain('- team-lead (role: lead)');
  });

  it('passes the prompt through untouched when there are no teammates', () => {
    expect(buildCreateBootstrapUserPrompt('  solo work  ', [])).toBe('solo work');
    expect(buildCreateBootstrapUserPrompt('lead only', [{ name: 'team-lead', role: 'lead' }])).toBe(
      'lead only'
    );
  });

  it('stays empty for an empty prompt so create mode skips the deferred prompt file', () => {
    expect(buildCreateBootstrapUserPrompt('', teammates)).toBe('');
    expect(buildCreateBootstrapUserPrompt('   ', teammates)).toBe('');
  });
});

describe('lead launch prompts include the teammate roster rules', () => {
  it.each([false, true])(
    'executes an explicit launch request in the deferred operating turn (resume=%s)',
    (isResume) => {
      const instruction = 'Create two NEW tasks for HAIKU_RELAUNCH_OK and OPENCODE_RELAUNCH_OK.';
      const prompt = buildDeterministicLaunchHydrationPrompt(
        { teamName: 'sandbox-relaunch', cwd: '/sandbox', prompt: instruction },
        teammates,
        [],
        isResume
      );
      expect(prompt.split(instruction)).toHaveLength(2);
      expect(prompt).toContain(
        'Apply the original user instructions now; do not wait for another user message.'
      );
      expect(prompt).toContain(
        'Create or assign tasks only when the request calls for teammate work, using the exact roster below.'
      );
      expect(prompt).toContain('leave its assignment pending and wait for that owner');
      expect(prompt).not.toContain('Do NOT create or assign any new task in this turn');
      expect(prompt).not.toContain('Do not start work, create tasks, or delegate in this turn.');
    }
  );

  it('allows an explicit solo relaunch request without inventing teammates', () => {
    const prompt = buildDeterministicLaunchHydrationPrompt(
      { teamName: 'sandbox-solo', cwd: '/sandbox', prompt: 'Write SOLO_RELAUNCH_OK.txt' },
      [],
      [],
      false
    );
    expect(prompt).toContain(
      'answer read-only questions or carry out requested work and update the task board as appropriate.'
    );
    expect(prompt).not.toContain('Do NOT start implementation in this turn.');
    expect(prompt).not.toContain('Create and assign the requested work');
  });

  it('preserves read-only instructions instead of requiring tasks for every nonempty prompt', () => {
    const prompt = buildDeterministicLaunchHydrationPrompt(
      {
        teamName: 'sandbox-question',
        cwd: '/sandbox',
        prompt: 'Only explain the current board. Do not create tasks.',
      },
      teammates,
      [],
      false
    );
    expect(prompt).toContain(
      "Follow the user's requested action mode, including read-only answers."
    );
    expect(prompt).toContain(
      'Create or assign tasks only when the request calls for teammate work'
    );
    expect(prompt).toContain('Only explain the current board. Do not create tasks.');
  });

  it('keeps blank-prompt launches limited to readiness hydration', () => {
    const prompt = buildDeterministicLaunchHydrationPrompt(
      { teamName: 'sandbox-hydration', cwd: '/sandbox', prompt: '   ' },
      teammates,
      [],
      false
    );
    expect(prompt).toContain('Do NOT create, assign, or delegate any new task in this turn.');
    expect(prompt).toContain('Do not start work, create tasks, or delegate in this turn.');
    expect(prompt).not.toContain('first normal operating turn');
  });

  it('puts exact teammate names and the integrity rules into the launch hydration prompt', () => {
    const request = {
      teamName: 'matrix-team',
      cwd: '/repo',
      prompt: 'resume the campaign',
    } as TeamLaunchRequest;

    const prompt = buildDeterministicLaunchHydrationPrompt(request, rosterWithLead, [], false);

    expect(prompt).toContain('- local-worker (role: implementer)');
    expect(prompt).toContain('- cursor-worker (role: reviewer) [provider: opencode]');
    expect(prompt).toContain(
      'Your teammates are EXACTLY: local-worker, cursor-worker. No other teammate exists.'
    );
    expect(prompt).toContain('NEVER invent, guess, rename, or paraphrase teammate names');
    expect(prompt).not.toContain('EXACTLY: team-lead');
  });

  it('keeps the integrity rules in the compact post-compact persistent context', () => {
    const context = buildPersistentLeadContext({
      teamName: 'matrix-team',
      leadName: 'team-lead',
      isSolo: false,
      members: teammates,
      compact: true,
    });

    expect(context).toContain('- local-worker (implementer)');
    expect(context).toContain(
      'Your teammates are EXACTLY: local-worker, cursor-worker. No other teammate exists.'
    );
  });

  it('omits the roster rules for a solo lead with no teammates', () => {
    const context = buildPersistentLeadContext({
      teamName: 'matrix-team',
      leadName: 'team-lead',
      isSolo: true,
      members: [],
    });

    expect(context).not.toContain('Teammate roster rules');
  });
});
