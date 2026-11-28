import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ReviewFlowSettings,
  TeamReviewFlowOverrides,
} from '../../../../src/features/review-flow/contracts/types';

const hoisted = vi.hoisted(() => ({
  overview: null as unknown,
  teams: [] as { teamName: string; displayName: string }[],
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}${JSON.stringify(options)}` : key,
  }),
}));
vi.mock('../../../../src/features/review-flow/renderer/state/useReviewFlow', () => ({
  useReviewFlowOverview: () => hoisted.overview,
  useKnownTeams: () => hoisted.teams,
}));
// The searchable list itself is Radix/cmdk; the section only depends on its value contract.
vi.mock('@renderer/components/ui/combobox', () => ({
  Combobox: ({
    id,
    options,
    value,
    onValueChange,
  }: {
    id: string;
    options: { value: string; label: string; badge: string | null }[];
    value: string;
    onValueChange: (value: string) => void;
  }) => (
    <select
      id={id}
      data-testid="scope-picker"
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} data-badge={option.badge ?? ''}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock('@renderer/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
    ...rest
  }: { checked: boolean; onCheckedChange: (checked: boolean) => void } & Record<
    string,
    unknown
  >) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      {...rest}
    />
  ),
}));

import { ReviewFlowSection } from '../../../../src/features/review-flow/renderer/ui/ReviewFlowSection';

const agent: ReviewFlowSettings = { reviewFlow: 'agent_approval', reviewFlowPrompt: '' };
const human: ReviewFlowSettings = { reviewFlow: 'human_approval', reviewFlowPrompt: '' };

function setOverview(
  overrides: TeamReviewFlowOverrides,
  extra: Record<string, unknown> = {}
): {
  saveDefaults: ReturnType<typeof vi.fn>;
  saveTeamOverride: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
} {
  const fns = {
    saveDefaults: vi.fn(() => Promise.resolve()),
    saveTeamOverride: vi.fn(() => Promise.resolve()),
    load: vi.fn(() => Promise.resolve()),
  };
  hoisted.overview = {
    status: 'ready',
    error: null,
    defaults: agent,
    defaultsError: null,
    overrides,
    unreadableTeams: [],
    projectTeams: {},
    ...fns,
    ...extra,
  };
  return fns;
}

const q = <T extends HTMLElement>(testId: string): T | null =>
  document.querySelector<T>(`[data-testid="${testId}"]`);

describe('ReviewFlowSection', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    hoisted.teams = [
      { teamName: 'alpha', displayName: 'Alpha' },
      { teamName: 'beta', displayName: 'Beta' },
    ];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  const render = (): void => act(() => root.render(<ReviewFlowSection />));

  it('starts on "all teams" and lists the teams that deviate from the default', () => {
    setOverview({ beta: human });
    render();
    expect(q<HTMLSelectElement>('scope-picker')!.value).toBe('*');
    expect(q('review-flow-settings-use-default')).toBeNull();
    expect(host.textContent).toContain('reviewFlow.editor.followingTeams{"count":1}');
    expect(host.textContent).toContain('reviewFlow.overrides.heading{"count":1}');
    expect(q('review-flow-overrides-open-beta')).not.toBeNull();
    expect(q('review-flow-override-alpha')).toBeNull();
  });

  it('saves the default for everyone', async () => {
    const { saveDefaults } = setOverview({});
    render();
    act(() => q<HTMLInputElement>('review-flow-settings-human_approval')!.click());
    await act(async () => q<HTMLButtonElement>('review-flow-settings-save')!.click());
    expect(saveDefaults).toHaveBeenCalledWith({
      reviewFlow: 'human_approval',
      reviewFlowPrompt: '',
    });
  });

  it('resets a deviating team to the default straight from the list', async () => {
    const { saveTeamOverride } = setOverview({ beta: human });
    render();
    await act(async () => q<HTMLButtonElement>('review-flow-overrides-reset-beta')!.click());
    expect(saveTeamOverride).toHaveBeenCalledWith('beta', null);
  });

  it('opens a team from the list and lets it follow the default again', async () => {
    const { saveTeamOverride } = setOverview({ beta: human });
    render();
    act(() => q<HTMLButtonElement>('review-flow-overrides-open-beta')!.click());
    expect(q<HTMLSelectElement>('scope-picker')!.value).toBe('beta');
    expect(q('review-flow-settings-source')!.textContent).toBe('reviewFlow.badges.custom');
    expect(q('review-flow-settings-use-default')!.getAttribute('aria-checked')).toBe('false');
    expect(q('review-flow-overrides-open-beta')).toBeNull();

    act(() => q<HTMLButtonElement>('review-flow-settings-use-default')!.click());
    await act(async () => q<HTMLButtonElement>('review-flow-settings-save')!.click());
    expect(saveTeamOverride).toHaveBeenCalledWith('beta', null);
  });

  it('gives a team that follows the default its own settings when switched in the picker', async () => {
    const { saveTeamOverride } = setOverview({});
    render();
    act(() => {
      const picker = q<HTMLSelectElement>('scope-picker')!;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(picker, 'alpha');
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(q('review-flow-settings-source')!.textContent).toBe('reviewFlow.badges.default');
    act(() => q<HTMLButtonElement>('review-flow-settings-use-default')!.click());
    act(() => q<HTMLInputElement>('review-flow-settings-human_approval')!.click());
    await act(async () => q<HTMLButtonElement>('review-flow-settings-save')!.click());
    expect(saveTeamOverride).toHaveBeenCalledWith('alpha', human);
  });

  it('shows a loading skeleton, then a retryable error', () => {
    setOverview({}, { status: 'loading' });
    render();
    expect(q('review-flow-loading')).not.toBeNull();

    const { load } = setOverview({}, { status: 'error', error: 'disk unreadable' });
    render();
    expect(q('review-flow-load-error')!.textContent).toContain('disk unreadable');
    act(() => q('review-flow-load-error')!.querySelector('button')!.click());
    expect(load).toHaveBeenCalledWith({ force: true });
  });

  it('excludes unavailable teams from default counts and blocks editing their unobserved policies', () => {
    const { load, saveTeamOverride } = setOverview({}, { unavailable: [
      { kind: 'team', teamName: 'beta', displayName: 'Beta', code: 'unavailable', outcome: 'unknown' },
    ] });
    render();
    expect(host.textContent).toContain('reviewFlow.editor.followingTeams{"count":1}');
    const notice = q('review-flow-unavailable')!;
    expect(notice.getAttribute('role')).toBe('alert');
    act(() => {
      const picker = q<HTMLSelectElement>('scope-picker')!;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(picker, 'beta');
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(q('review-flow-settings-editor')).toBeNull();
    expect(host.textContent).not.toContain('reviewFlow.useDefault.following');
    act(() => notice.querySelector('button')!.click());
    expect(load).toHaveBeenCalledWith({ force: true });
    expect(saveTeamOverride).not.toHaveBeenCalled();
  });

  it('warns that review is paused when the saved default is unreadable and lets the user confirm a new one', async () => {
    const { saveDefaults } = setOverview({}, { defaultsError: 'defaults file is corrupt' });
    render();
    const banner = q('review-flow-defaults-error')!;
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.textContent).toContain('reviewFlow.broken.defaults');
    expect(banner.textContent).toContain('defaults file is corrupt');
    expect(banner.textContent).toContain('reviewFlow.broken.defaultsHint');

    // Nothing was changed, yet Save is available so the built-in values can be confirmed.
    const save = q<HTMLButtonElement>('review-flow-settings-save')!;
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    expect(saveDefaults).toHaveBeenCalledWith(agent);
  });

  it('shows the unreadable-default banner in a team scope with a way back to the default', () => {
    setOverview({}, { defaultsError: 'defaults file is corrupt' });
    render();
    act(() => {
      const picker = q<HTMLSelectElement>('scope-picker')!;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(picker, 'alpha');
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const banner = q('review-flow-defaults-error')!;
    expect(banner.textContent).not.toContain('reviewFlow.broken.defaultsHint');
    act(() => banner.querySelector('button')!.click());
    expect(q<HTMLSelectElement>('scope-picker')!.value).toBe('*');
  });

  it('lists teams with unreadable settings and repairs them by resetting to the default', async () => {
    const { saveTeamOverride } = setOverview({}, { unreadableTeams: ['beta'] });
    render();
    expect(host.textContent).toContain('reviewFlow.unreadable.heading{"count":1}');
    const options = [...q<HTMLSelectElement>('scope-picker')!.options];
    expect(options.find((option) => option.value === 'beta')!.dataset.badge).toBe('repair');

    await act(async () => q<HTMLButtonElement>('review-flow-unreadable-reset-beta')!.click());
    expect(saveTeamOverride).toHaveBeenCalledWith('beta', null);
  });

  it('hides the unreadable list when every team is readable', () => {
    setOverview({});
    render();
    expect(q('review-flow-unreadable-list')).toBeNull();
  });

  it('presents a selected unreadable team as needing repair, not as following the default', async () => {
    const { saveTeamOverride } = setOverview({}, { unreadableTeams: ['beta'] });
    render();
    act(() => q<HTMLButtonElement>('review-flow-unreadable-open-beta')!.click());
    expect(q('review-flow-settings-source')!.textContent).toBe('reviewFlow.badges.repair');
    expect(host.textContent).not.toContain('reviewFlow.useDefault.following');
    await act(async () => q<HTMLButtonElement>('review-flow-settings-save')!.click());
    expect(saveTeamOverride).toHaveBeenCalledWith('beta', null);
  });
});
