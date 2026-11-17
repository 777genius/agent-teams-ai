import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NativeNextPromptProviderSetting } from '../../../src/features/native-prompt-suggestions/renderer/NativeNextPromptProviderSetting';

const state = vi.hoisted(() => ({
  appConfig: undefined as unknown,
  updateConfig: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock('@renderer/store', () => ({
  useStore: (select: (value: typeof state) => unknown) => select(state),
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

type Provider = 'anthropic' | 'codex' | 'opencode';
const roots: { unmount(): void; container: HTMLElement; rerender(providerId: Provider, disabled?: boolean): Promise<void> }[] = [];
async function render(providerId: Provider, disabled = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const rerender = async (next: Provider, blocked = false) => {
    await act(async () => root.render(<NativeNextPromptProviderSetting providerId={next} disabled={blocked} />));
  };
  await rerender(providerId, disabled);
  roots.push({ unmount: () => root.unmount(), container, rerender });
  return container;
}
const toggle = (container: HTMLElement) =>
  container.querySelector('button[role="switch"]') as HTMLButtonElement;

afterEach(() => {
  for (const { unmount, container } of roots.splice(0)) {
    act(() => unmount());
    container.remove();
  }
  state.updateConfig.mockReset();
  state.updateConfig.mockResolvedValue(undefined);
  state.appConfig = undefined;
  vi.unstubAllGlobals();
});

describe('provider next-message suggestion setting', () => {
  it('does not expose the switch for a provider without native suggestions', async () => {
    const container = await render('opencode');
    expect(container.querySelector('button[role="switch"]')).toBeNull();
    expect(state.updateConfig).not.toHaveBeenCalled();
  });

  it('is on by default and turns off only the provider whose page it is on', async () => {
    const container = await render('codex');
    expect(toggle(container).getAttribute('aria-checked')).toBe('true');
    await act(async () => toggle(container).click());
    expect(state.updateConfig).toHaveBeenCalledWith('providerConnections', {
      codex: { nativeNextPromptSuggestionsEnabled: false },
    });
  });

  it('reflects a saved false and turns back on for Claude (anthropic)', async () => {
    state.appConfig = {
      providerConnections: { anthropic: { nativeNextPromptSuggestionsEnabled: false } },
    };
    const container = await render('anthropic');
    expect(toggle(container).getAttribute('aria-checked')).toBe('false');
    await act(async () => toggle(container).click());
    expect(state.updateConfig).toHaveBeenCalledWith('providerConnections', {
      anthropic: { nativeNextPromptSuggestionsEnabled: true },
    });
  });

  it('shows an error and stays usable when saving fails', async () => {
    state.updateConfig.mockRejectedValueOnce(new Error('disk full'));
    const container = await render('anthropic');
    await act(async () => toggle(container).click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('disk full');
    expect(toggle(container).disabled).toBe(false);
  });

  it('does not mutate provider settings while its parent disables the dialog', async () => {
    const container = await render('codex', true);
    expect(toggle(container).disabled).toBe(true);
    await act(async () => toggle(container).click());
    expect(state.updateConfig).not.toHaveBeenCalled();
    await roots[0]!.rerender('codex', false);
    await act(async () => toggle(container).click());
    expect(state.updateConfig).toHaveBeenCalledExactlyOnceWith('providerConnections', {
      codex: { nativeNextPromptSuggestionsEnabled: false },
    });
  });

  it('keeps an old pending save and its failure out of the newly selected provider', async () => {
    let reject!: (error: Error) => void;
    state.updateConfig.mockImplementationOnce(() => new Promise<void>((_resolve, no) => { reject = no; }));
    const container = await render('codex');
    await act(async () => toggle(container).click());
    expect(toggle(container).disabled).toBe(true);
    await roots[0]!.rerender('anthropic');
    expect(container.querySelector('[data-testid="native-next-prompt-setting-anthropic"]')).not.toBeNull();
    expect(toggle(container).disabled).toBe(false);
    await act(async () => { reject(new Error('TEST-old-Codex-save-failure')); });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(toggle(container).disabled).toBe(false);
    await act(async () => toggle(container).click());
    expect(state.updateConfig.mock.calls).toEqual([
      ['providerConnections', { codex: { nativeNextPromptSuggestionsEnabled: false } }],
      ['providerConnections', { anthropic: { nativeNextPromptSuggestionsEnabled: false } }],
    ]);
  });
});
