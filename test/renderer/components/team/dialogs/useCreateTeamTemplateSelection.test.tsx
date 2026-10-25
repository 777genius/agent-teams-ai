import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useCreateTeamTemplateSelection,
  type UseCreateTeamTemplateSelectionResult,
} from '@renderer/components/team/dialogs/useCreateTeamTemplateSelection';

const draftStore = vi.hoisted(() => {
  const state = {
    value: '',
    isSaved: false,
    setValueCalls: [] as string[],
    clearCalls: 0,
  };
  return {
    state,
    setValue: (value: string): void => {
      state.setValueCalls.push(value);
      state.value = value;
    },
    clearDraft: (): void => {
      state.clearCalls += 1;
      state.value = '';
    },
  };
});

vi.mock('@renderer/hooks/useDraftPersistence', () => ({
  useDraftPersistence: () => ({
    value: draftStore.state.value,
    setValue: draftStore.setValue,
    isSaved: draftStore.state.isSaved,
    clearDraft: draftStore.clearDraft,
  }),
}));

function mountHook(initialData: boolean) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const ref: { current: UseCreateTeamTemplateSelectionResult | null } = { current: null };

  function Harness({ initial }: { initial: boolean }): null {
    ref.current = useCreateTeamTemplateSelection({ initialData: initial });
    return null;
  }

  return {
    ref,
    async render(initial: boolean = initialData): Promise<void> {
      await act(async () => {
        root.render(React.createElement(Harness, { initial }));
        await Promise.resolve();
      });
    },
    unmount(): void {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe('useCreateTeamTemplateSelection', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    draftStore.state.value = '';
    draftStore.state.isSaved = false;
    draftStore.state.setValueCalls.length = 0;
    draftStore.state.clearCalls = 0;
  });

  it('restores the applied source from the persisted draft without rewriting it', async () => {
    draftStore.state.value = JSON.stringify({ source: 'custom', value: 'custom:tmpl-1' });
    const hook = mountHook(false);
    try {
      await hook.render();

      expect(hook.ref.current?.storedTemplateSelection).toEqual({
        source: 'custom',
        value: 'custom:tmpl-1',
      });
      expect(hook.ref.current?.appliedTemplateSource).toBe('custom');
      // Restoration only feeds the picker; it must not re-apply template content.
      expect(draftStore.state.setValueCalls).toEqual([]);
    } finally {
      hook.unmount();
    }
  });

  it('records an applied source without writing template content back to the draft', async () => {
    const hook = mountHook(false);
    try {
      await hook.render();
      expect(hook.ref.current?.appliedTemplateSource).toBe('none');

      await act(async () => {
        hook.ref.current?.setAppliedTemplateSource('builtin');
        await Promise.resolve();
      });

      expect(hook.ref.current?.appliedTemplateSource).toBe('builtin');
      // onApply owns content application and draft persistence; the setter only
      // tracks the source so edited prompts and members survive.
      expect(draftStore.state.setValueCalls).toEqual([]);
    } finally {
      hook.unmount();
    }
  });

  it('clears the applied source and the persisted draft through clearTemplateSelection', async () => {
    draftStore.state.value = JSON.stringify({ source: 'custom', value: 'custom:tmpl-2' });
    const hook = mountHook(false);
    try {
      await hook.render();
      expect(hook.ref.current?.appliedTemplateSource).toBe('custom');

      await act(async () => {
        hook.ref.current?.clearTemplateSelection();
        await Promise.resolve();
      });

      expect(hook.ref.current?.appliedTemplateSource).toBe('none');
      expect(hook.ref.current?.storedTemplateSelection).toEqual({ source: null, value: '' });
      expect(draftStore.state.clearCalls).toBeGreaterThan(0);
      expect(draftStore.state.value).toBe('');
    } finally {
      hook.unmount();
    }
  });

  it('clears a persisted selection when the dialog opens with initial data', async () => {
    draftStore.state.value = JSON.stringify({ source: 'builtin', value: 'builtin:marketing' });
    const hook = mountHook(true);
    try {
      await hook.render();

      expect(hook.ref.current?.appliedTemplateSource).toBe('none');
      expect(draftStore.state.clearCalls).toBeGreaterThan(0);
      expect(draftStore.state.value).toBe('');
    } finally {
      hook.unmount();
    }
  });
});
