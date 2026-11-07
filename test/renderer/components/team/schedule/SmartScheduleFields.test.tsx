import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { SmartScheduleFields } from '@renderer/components/team/schedule/SmartScheduleFields';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ isLight: false, isDark: true, resolvedTheme: 'dark' }),
}));

vi.mock('@renderer/components/team/schedule/CronScheduleInput', () => ({
  CronScheduleInput: () => React.createElement('div', null, 'Cron settings'),
}));

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('SmartScheduleFields recipient picker', () => {
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
    await act(async () => {
      root.unmount();
      await flush();
    });
    document.body.innerHTML = '';
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('shows real roster avatars and roles, with a canonical lead default', async () => {
    const onTargetMemberChange = vi.fn();
    const team = {
      leadName: 'lead',
      members: [{ name: 'alice', role: 'Developer' }, { name: 'bob', role: 'Reviewer' }],
    };
    const render = (targetMember: string) =>
      root.render(
        <SmartScheduleFields
          isLight={false}
          expanded
          onToggle={vi.fn()}
          mode="agent"
          onModeChange={vi.fn()}
          targetMember={targetMember}
          onTargetMemberChange={onTargetMemberChange}
          team={team}
          label=""
          onLabelChange={vi.fn()}
          cronExpression="0 9 * * *"
          onCronExpressionChange={vi.fn()}
          timezone="UTC"
          onTimezoneChange={vi.fn()}
          warmUpMinutes={0}
          onWarmUpMinutesChange={vi.fn()}
        />
      );

    await act(async () => {
      render('');
      await flush();
    });
    const trigger = host.querySelector('button[role="combobox"]') as HTMLButtonElement;
    expect(trigger).toBeTruthy();
    expect(trigger.querySelector('img')).toBeTruthy();
    expect(trigger.getAttribute('aria-label')).toBeTruthy();

    await act(async () => {
      trigger.click();
      await flush();
    });
    const list = document.body.querySelector('[cmdk-list]') as HTMLElement;
    const options = Array.from(list.querySelectorAll('[cmdk-item]')) as HTMLElement[];
    expect(options.length).toBe(3);
    expect(options.find((option) => option.textContent?.includes('alice'))?.querySelector('img')).toBeTruthy();
    expect(list.textContent).toContain('Developer');

    await act(async () => {
      options.find((option) => option.textContent?.includes('alice'))?.click();
      await flush();
      render('alice');
      await flush();
    });
    expect(onTargetMemberChange).toHaveBeenCalledWith('alice');

    await act(async () => {
      trigger.click();
      await flush();
    });
    const lead = Array.from(document.body.querySelectorAll('[cmdk-item]')).find((option) =>
      option.textContent?.includes('Team lead')
    ) as HTMLElement | undefined;
    expect(lead).toBeTruthy();
    await act(async () => {
      lead?.click();
      await flush();
    });
    expect(onTargetMemberChange).toHaveBeenCalledWith('');
  });
  it('allows returning to the default lead when the summary has no leadName', async () => {
    const onTargetMemberChange = vi.fn();
    const render = (targetMember: string) =>
      root.render(
        <SmartScheduleFields
          isLight={false}
          expanded
          onToggle={vi.fn()}
          mode="agent"
          onModeChange={vi.fn()}
          targetMember={targetMember}
          onTargetMemberChange={onTargetMemberChange}
          team={{ members: [{ name: 'alice', role: 'Developer' }] }}
          label=""
          onLabelChange={vi.fn()}
          cronExpression="0 9 * * *"
          onCronExpressionChange={vi.fn()}
          timezone="UTC"
          onTimezoneChange={vi.fn()}
          warmUpMinutes={0}
          onWarmUpMinutesChange={vi.fn()}
        />
      );

    await act(async () => {
      render('');
      await flush();
    });
    const trigger = host.querySelector('button[role="combobox"]') as HTMLButtonElement;
    expect(trigger.textContent).toContain('Team lead');
    await act(async () => {
      trigger.click();
      await flush();
    });
    const choices = Array.from(document.body.querySelectorAll('[cmdk-item]'));
    expect(choices.length).toBe(2);
    await act(async () => {
      (choices.find((option) => option.textContent?.includes('alice')) as HTMLElement)?.click();
      await flush();
      render('alice');
      await flush();
      trigger.click();
      await flush();
    });
    const defaultChoice = Array.from(document.body.querySelectorAll('[cmdk-item]')).find((option) =>
      option.textContent?.includes('Team lead')
    ) as HTMLElement | undefined;
    expect(defaultChoice).toBeTruthy();
    await act(async () => {
      defaultChoice?.click();
      await flush();
    });
    expect(onTargetMemberChange).toHaveBeenCalledWith('');
  });

});
