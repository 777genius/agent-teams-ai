import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { SmartScheduleFields } from '@renderer/components/team/schedule/SmartScheduleFields';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TeamSummary } from '@shared/types';

vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ isLight: false, isDark: true }),
}));

vi.mock('@renderer/components/team/schedule/CronScheduleInput', () => ({
  CronScheduleInput: () => <div data-testid="cron-input" />,
}));

const team: Pick<TeamSummary, 'members' | 'leadName'> = {
  leadName: 'team-lead',
  members: [
    { name: 'alice', role: 'Reviewer', color: 'blue' },
    { name: 'bob', role: 'Developer', color: 'green' },
  ],
};

function scheduleFields(
  onTargetMemberChange: (name: string) => void,
  overrides: {
    mode?: 'legacy' | 'agent' | 'team';
    targetMember?: string;
    team?: Pick<TeamSummary, 'members' | 'leadName'>;
  } = {}
): React.ReactElement {
  return (
    <SmartScheduleFields
      isLight={false}
      expanded
      onToggle={() => undefined}
      mode={overrides.mode ?? 'agent'}
      onModeChange={() => undefined}
      targetMember={overrides.targetMember ?? ''}
      onTargetMemberChange={onTargetMemberChange}
      team={Object.hasOwn(overrides, 'team') ? overrides.team : team}
      label=""
      onLabelChange={() => undefined}
      cronExpression="0 9 * * 1-5"
      onCronExpressionChange={() => undefined}
      timezone="UTC"
      onTimezoneChange={() => undefined}
      warmUpMinutes={15}
      onWarmUpMinutesChange={() => undefined}
    />
  );
}

describe('SmartScheduleFields teammate picker', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('uses the existing avatar picker and stores an exact teammate name', async () => {
    const onChange = vi.fn();
    await act(async () => root.render(scheduleFields(onChange)));

    const trigger = host.querySelector('button[role="combobox"]') as HTMLButtonElement;
    expect(trigger).toBeTruthy();
    expect(trigger.getAttribute('aria-label')).toBe('Target when team is running');
    expect(trigger.querySelector('img')).toBeTruthy();
    expect(trigger.textContent).toContain('Team lead (default)');

    await act(async () => trigger.click());
    const list = document.body.querySelector('[cmdk-list]') as HTMLElement;
    expect(list.textContent).toContain('alice');
    expect(list.textContent).toContain('Reviewer');
    const option = Array.from(list.querySelectorAll('[cmdk-item]')).find((item) =>
      item.textContent?.includes('alice')
    ) as HTMLElement;
    expect(option).toBeTruthy();

    await act(async () => option.click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith('alice');

    await act(async () => root.render(scheduleFields(onChange, { targetMember: 'alice' })));
    expect((host.querySelector('button[role="combobox"]') as HTMLElement).textContent).toContain(
      'alice'
    );
  });

  it('preserves the persisted empty-string default lead identity', async () => {
    const onChange = vi.fn();
    await act(async () => root.render(scheduleFields(onChange, { targetMember: 'alice' })));
    await act(async () => {
      (host.querySelector('button[role="combobox"]') as HTMLButtonElement).click();
    });
    const list = document.body.querySelector('[cmdk-list]') as HTMLElement;
    const leadOption = Array.from(list.querySelectorAll('[cmdk-item]')).find((item) =>
      item.textContent?.includes('Team lead (default)')
    ) as HTMLElement;
    await act(async () => leadOption.click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith('');
  });

  it('shows an unavailable saved target rather than silently defaulting to the lead', async () => {
    const onChange = vi.fn();
    await act(async () => root.render(scheduleFields(onChange, { targetMember: 'former-member' })));
    const trigger = host.querySelector('button[role="combobox"]') as HTMLButtonElement;
    expect(trigger.textContent).toContain('former-member');
    expect(trigger.textContent).not.toContain('Team lead (default)');
    expect(host.textContent).toContain('This recipient is no longer available.');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('warns about a deleted target even when the loaded summary has no members field', async () => {
    const onChange = vi.fn();
    await act(async () =>
      root.render(
        scheduleFields(onChange, {
          targetMember: 'former-member',
          team: { leadName: 'team-lead' },
        })
      )
    );

    expect(host.textContent).toContain('former-member');
    expect(host.textContent).toContain('This recipient is no longer available.');
    await act(async () => {
      (host.querySelector('button[role="combobox"]') as HTMLButtonElement).click();
    });
    const list = document.body.querySelector('[cmdk-list]') as HTMLElement;
    const leadOption = Array.from(list.querySelectorAll('[cmdk-item]')).find((item) =>
      item.textContent?.includes('Team lead (default)')
    ) as HTMLElement;
    expect(leadOption).toBeTruthy();

    await act(async () => leadOption.click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith('');
  });

  it('keeps lead reset available before team data loads without falsely warning', async () => {
    const onChange = vi.fn();
    await act(async () =>
      root.render(scheduleFields(onChange, { targetMember: 'former-member', team: undefined }))
    );
    const trigger = host.querySelector('button[role="combobox"]') as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
    expect(trigger.textContent).toContain('former-member');
    expect(host.textContent).not.toContain('This recipient is no longer available.');

    await act(async () => trigger.click());
    const list = document.body.querySelector('[cmdk-list]') as HTMLElement;
    const options = Array.from(list.querySelectorAll('[cmdk-item]'));
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toContain('Team lead (default)');

    await act(async () => (options[0] as HTMLElement).click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith('');
  });

  it('recognizes saved lead casing without changing the persisted target', async () => {
    const onChange = vi.fn();
    await act(async () =>
      root.render(
        scheduleFields(onChange, {
          targetMember: 'Team-Lead',
          team: { leadName: 'team-lead', members: [{ name: 'alice' }] },
        })
      )
    );

    const trigger = host.querySelector('button[role="combobox"]') as HTMLButtonElement;
    expect(trigger.querySelector('img')).toBeTruthy();
    expect(trigger.textContent).toContain('Team lead (default)');
    expect(host.textContent).not.toContain('This recipient is no longer available.');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reuses lead metadata when the roster spells its name with different casing', async () => {
    const onChange = vi.fn();
    await act(async () =>
      root.render(
        scheduleFields(onChange, {
          team: {
            leadName: 'team-lead',
            members: [{ name: ' Team-Lead ', role: 'Coordinator' }, { name: 'alice' }],
          },
        })
      )
    );
    await act(async () => {
      (host.querySelector('button[role="combobox"]') as HTMLButtonElement).click();
    });
    const list = document.body.querySelector('[cmdk-list]') as HTMLElement;
    expect(list.textContent).toContain('Coordinator');
    expect(list.querySelectorAll('[cmdk-item]').length).toBe(2);
  });

  it('never offers unsupported runtime member names as a schedule recipient', async () => {
    const onChange = vi.fn();
    await act(async () =>
      root.render(
        scheduleFields(onChange, {
          team: {
            leadName: 'team-lead',
            members: [{ name: '+alice', role: 'Invalid' }, { name: 'bob', role: 'Developer' }],
          },
        })
      )
    );
    expect(host.textContent).toContain('+alice: Start with alphanumeric');
    await act(async () => {
      (host.querySelector('button[role="combobox"]') as HTMLButtonElement).click();
    });
    const list = document.body.querySelector('[cmdk-list]') as HTMLElement;
    expect(list.textContent).toContain('bob');
    expect(list.textContent).not.toContain('+alice');
  });

  it('trims a saved target for display but never mutates the saved value automatically', async () => {
    const onChange = vi.fn();
    await act(async () => root.render(scheduleFields(onChange, { targetMember: ' alice ' })));

    const trigger = host.querySelector('button[role="combobox"]') as HTMLButtonElement;
    expect(trigger.textContent).toContain('alice');
    expect(trigger.textContent).not.toContain('Team lead (default)');
    expect(host.textContent).not.toContain('This recipient is no longer available.');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows the specific invalid name and validation reason, not only a generic warning', async () => {
    const onChange = vi.fn();
    await act(async () =>
      root.render(
        scheduleFields(onChange, {
          team: {
            leadName: 'team-lead',
            members: [{ name: 'con' }, { name: 'bad.' }, { name: 'alice' }],
          },
        })
      )
    );
    expect(host.textContent).toContain('con: Member name is reserved on Windows');
    expect(host.textContent).toContain('bad.: Member name cannot end with a space or period');
    await act(async () => {
      (host.querySelector('button[role="combobox"]') as HTMLButtonElement).click();
    });
    const list = document.body.querySelector('[cmdk-list]') as HTMLElement;
    expect(list.textContent).toContain('alice');
    expect(list.textContent).not.toContain('bad.');
    expect(list.textContent).not.toContain('con');
  });

  it('keeps legacy one-shot schedule editing free of a teammate target', async () => {
    const onChange = vi.fn();
    await act(async () =>
      root.render(scheduleFields(onChange, { mode: 'legacy', targetMember: 'alice' }))
    );
    expect(host.querySelector('button[role="combobox"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
