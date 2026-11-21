import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}${JSON.stringify(options)}` : key,
  }),
}));

// Radix Switch measures itself asynchronously, which is noise here; the editor only needs its contract.
vi.mock('@renderer/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
    disabled,
    ...rest
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    disabled?: boolean;
  } & Record<string, unknown>) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      {...rest}
    />
  ),
}));

import { ReviewFlowPolicyEditor } from '../../../../src/features/review-flow/renderer/ui/ReviewFlowPolicyEditor';

import type {
  ReviewFlowPolicy,
  ReviewFlowSettings,
} from '../../../../src/features/review-flow/contracts/types';
import type { ReviewFlowScope } from '../../../../src/features/review-flow/renderer/view-model/reviewFlowViewModel';

const P = 'test-flow';
const agent: ReviewFlowSettings = { reviewFlow: 'agent_approval', reviewFlowPrompt: '' };
const human: ReviewFlowSettings = { reviewFlow: 'human_approval', reviewFlowPrompt: 'Run e2e.' };
const team: ReviewFlowScope = { kind: 'team', teamName: 'alpha' };

const following = (defaults: ReviewFlowSettings): ReviewFlowPolicy => ({
  ...defaults,
  source: 'default',
});
const own = (settings: ReviewFlowSettings): ReviewFlowPolicy => ({ ...settings, source: 'team' });

const q = <T extends HTMLElement>(id: string): T | null =>
  document.querySelector<T>(`[data-testid="${P}-${id}"]`);

describe('ReviewFlowPolicyEditor', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  const render = (props: Partial<React.ComponentProps<typeof ReviewFlowPolicyEditor>> = {}) =>
    act(() =>
      root.render(
        <ReviewFlowPolicyEditor
          scope={team}
          policy={following(agent)}
          defaults={agent}
          onSave={() => Promise.resolve()}
          testIdPrefix={P}
          {...props}
        />
      )
    );

  const fieldsetOf = (flow: string): HTMLFieldSetElement =>
    q<HTMLInputElement>(flow)!.closest('fieldset')!;

  it('shows the default read-only while a team follows it, and saves nothing until changed', () => {
    render({ policy: following(human), defaults: human });
    expect(q('use-default')!.getAttribute('aria-checked')).toBe('true');
    expect(q<HTMLInputElement>('human_approval')!.checked).toBe(true);
    expect(fieldsetOf('human_approval').disabled).toBe(true);
    expect(q<HTMLButtonElement>('save')!.disabled).toBe(true);
    expect(q('source')!.textContent).toBe('reviewFlow.badges.default');
  });

  it('lets a team leave the default without losing the default values, then saves its own settings', async () => {
    const onSave = vi.fn(() => Promise.resolve());
    render({ policy: following(human), defaults: human, onSave });

    act(() => q<HTMLButtonElement>('use-default')!.click());
    expect(fieldsetOf('human_approval').disabled).toBe(false);
    expect(q<HTMLInputElement>('human_approval')!.checked).toBe(true);

    act(() => q<HTMLInputElement>('agent_approval')!.click());
    await act(async () => q<HTMLButtonElement>('save')!.click());
    expect(onSave).toHaveBeenCalledWith({
      reviewFlow: 'agent_approval',
      reviewFlowPrompt: 'Run e2e.',
    });
  });

  it('offers the lead sign-off flow and saves it like any other flow', async () => {
    const onSave = vi.fn(() => Promise.resolve());
    render({ policy: own(agent), defaults: agent, onSave });

    act(() => q<HTMLInputElement>('lead_then_human')!.click());
    await act(async () => q<HTMLButtonElement>('save')!.click());
    expect(onSave).toHaveBeenCalledWith({ reviewFlow: 'lead_then_human', reviewFlowPrompt: '' });
  });

  it('removes the override (saves null) when a custom team returns to the default', async () => {
    const onSave = vi.fn(() => Promise.resolve());
    render({ policy: own(human), defaults: agent, onSave });
    expect(q('source')!.textContent).toBe('reviewFlow.badges.custom');
    expect(q('use-default')!.getAttribute('aria-checked')).toBe('false');

    act(() => q<HTMLButtonElement>('use-default')!.click());
    // The form now previews the default, not the team's custom values.
    expect(q<HTMLInputElement>('agent_approval')!.checked).toBe(true);
    await act(async () => q<HTMLButtonElement>('save')!.click());
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it('edits the default for all teams as a plain value and reports how many teams follow it', async () => {
    const onSave = vi.fn(() => Promise.resolve());
    render({
      scope: { kind: 'default' },
      policy: following(agent),
      followingTeamCount: 7,
      onSave,
    });
    expect(q('use-default')).toBeNull();
    expect(host.textContent).toContain('reviewFlow.editor.followingTeams{"count":7}');

    act(() => q<HTMLInputElement>('human_approval')!.click());
    await act(async () => q<HTMLButtonElement>('save')!.click());
    expect(onSave).toHaveBeenCalledWith({ reviewFlow: 'human_approval', reviewFlowPrompt: '' });
    expect(q('feedback')!.textContent).toBe('reviewFlow.feedback.saved');
  });

  it('keeps the draft and shows the reason when saving fails', async () => {
    const onSave = vi.fn(() => Promise.reject(new Error('write failed')));
    render({ scope: { kind: 'default' }, policy: following(agent), onSave });
    act(() => q<HTMLInputElement>('human_approval')!.click());
    await act(async () => q<HTMLButtonElement>('save')!.click());

    expect(q('feedback')!.getAttribute('role')).toBe('alert');
    expect(q('feedback')!.textContent).toContain('write failed');
    expect(q<HTMLInputElement>('human_approval')!.checked).toBe(true);
    expect(q<HTMLButtonElement>('save')!.disabled).toBe(false);
  });

  it('restarts from the persisted settings when another scope is shown', () => {
    render({ scope: { kind: 'default' }, policy: following(agent) });
    act(() => q<HTMLInputElement>('human_approval')!.click());
    expect(q<HTMLButtonElement>('save')!.disabled).toBe(false);

    render({ scope: team, policy: following(agent) });
    expect(q('use-default')).not.toBeNull();
    expect(q<HTMLButtonElement>('save')!.disabled).toBe(true);
    expect(q<HTMLInputElement>('human_approval')!.checked).toBe(false);
  });

  it('Cancel discards the draft and notifies the host', () => {
    const onCancel = vi.fn();
    render({ scope: { kind: 'default' }, policy: following(agent), onCancel });
    act(() => q<HTMLInputElement>('human_approval')!.click());
    const cancel = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'reviewFlow.cancel'
    )!;
    act(() => cancel.click());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(q<HTMLInputElement>('agent_approval')!.checked).toBe(true);
  });

  it('offers a repair when saved settings are unreadable: Save works unchanged and the state is not shown as following', async () => {
    const onSave = vi.fn(() => Promise.resolve());
    render({ policy: following(agent), repair: true, onSave });
    expect(q('source')!.textContent).toBe('reviewFlow.badges.repair');
    expect(host.textContent).toContain('reviewFlow.broken.teamHint');
    expect(host.textContent).not.toContain('reviewFlow.useDefault.following');

    expect(q<HTMLButtonElement>('save')!.disabled).toBe(false);
    await act(async () => q<HTMLButtonElement>('save')!.click());
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it('lets the default for all teams be saved unchanged while it needs repair', async () => {
    const onSave = vi.fn(() => Promise.resolve());
    render({ scope: { kind: 'default' }, policy: following(agent), repair: true, onSave });
    expect(q<HTMLButtonElement>('save')!.disabled).toBe(false);
    await act(async () => q<HTMLButtonElement>('save')!.click());
    expect(onSave).toHaveBeenCalledWith(agent);
  });
});
