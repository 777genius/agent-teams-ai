import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { findMentionTrigger, useMentionDetection } from '@renderer/hooks/useMentionDetection';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, SyntheticEvent } from 'react';

describe('findMentionTrigger', () => {
  it('detects @query at start of text', () => {
    const result = findMentionTrigger('@ali', 4);
    expect(result).toEqual({ triggerIndex: 0, triggerChar: '@', query: 'ali' });
  });

  it('detects @query after space', () => {
    const result = findMentionTrigger('hello @bo', 9);
    expect(result).toEqual({ triggerIndex: 6, triggerChar: '@', query: 'bo' });
  });

  it('returns null for email-like @ (no space before)', () => {
    const result = findMentionTrigger('email@test', 10);
    expect(result).toBeNull();
  });

  it('returns null when space follows @ query (mention already complete)', () => {
    const result = findMentionTrigger('@alice ', 7);
    expect(result).toBeNull();
  });

  it('returns empty query for bare @', () => {
    const result = findMentionTrigger('@', 1);
    expect(result).toEqual({ triggerIndex: 0, triggerChar: '@', query: '' });
  });

  it('detects @ after newline', () => {
    const result = findMentionTrigger('text\n@ca', 8);
    expect(result).toEqual({ triggerIndex: 5, triggerChar: '@', query: 'ca' });
  });

  it('returns null for empty text', () => {
    const result = findMentionTrigger('', 0);
    expect(result).toBeNull();
  });

  it('detects @ after tab', () => {
    const result = findMentionTrigger('hello\t@bob', 10);
    expect(result).toEqual({ triggerIndex: 6, triggerChar: '@', query: 'bob' });
  });

  it('returns null when cursor is at position 0', () => {
    const result = findMentionTrigger('@test', 0);
    expect(result).toBeNull();
  });

  it('detects @ with empty query after space', () => {
    const result = findMentionTrigger('hello @', 7);
    expect(result).toEqual({ triggerIndex: 6, triggerChar: '@', query: '' });
  });

  it('handles multiple @ signs - picks nearest valid one', () => {
    const result = findMentionTrigger('@alice hello @bo', 16);
    expect(result).toEqual({ triggerIndex: 13, triggerChar: '@', query: 'bo' });
  });

  it('returns null for @ in middle of word', () => {
    const result = findMentionTrigger('test@domain', 11);
    expect(result).toBeNull();
  });

  it('detects @ after carriage return', () => {
    const result = findMentionTrigger('text\r\n@ca', 9);
    expect(result).toEqual({ triggerIndex: 6, triggerChar: '@', query: 'ca' });
  });
});

describe('useMentionDetection current input and availability', () => {
  type Rules = Pick<
    Parameters<typeof useMentionDetection>[0],
    'value' | 'triggerChars' | 'isTriggerEnabled' | 'isTriggerMatchValid'
  >;
  let container: HTMLDivElement;
  let root: Root;
  let textarea: HTMLTextAreaElement;
  let textareaRef: { current: HTMLTextAreaElement | null };
  let current: ReturnType<typeof useMentionDetection>;
  let rules: Rules;
  let onValueChange: ReturnType<typeof vi.fn>;

  // Keep the real input independent of prop commits to exercise select before parent render.
  function Probe(props: Rules): null {
    current = useMentionDetection({ ...props, textareaRef, onValueChange });
    return null;
  }
  const render = async (next: Partial<Rules> = {}) => {
    rules = { ...rules, ...next };
    await act(async () => root.render(createElement(Probe, rules)));
  };
  const selectEvent = () =>
    ({ currentTarget: textarea, target: textarea }) as SyntheticEvent<HTMLTextAreaElement>;
  const change = async (text: string) => {
    textarea.value = text;
    textarea.setSelectionRange(text.length, text.length);
    await act(async () => {
      current.handleChange(selectEvent() as ChangeEvent<HTMLTextAreaElement>);
    });
  };
  const keyboard = (key: string, composing = false, keyCode = 0) =>
    ({
      key,
      keyCode,
      shiftKey: false,
      nativeEvent: { isComposing: composing },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    }) as unknown as ReactKeyboardEvent<HTMLTextAreaElement>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    textarea = document.createElement('textarea');
    const mount = document.createElement('div');
    container.append(textarea, mount);
    document.body.append(container);
    root = createRoot(mount);
    textareaRef = { current: textarea };
    textarea.focus();
    onValueChange = vi.fn();
    rules = {
      value: '',
      triggerChars: ['@'],
      isTriggerEnabled: () => true,
      isTriggerMatchValid: (trigger, text) =>
        trigger.triggerChar !== '/' || text.slice(0, trigger.triggerIndex).trim().length === 0,
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(['supported character', 'enable predicate'])(
    'opens the unchanged input after late %s availability',
    async (kind) => {
      await render(kind === 'enable predicate'
        ? { triggerChars: ['@', '/'], isTriggerEnabled: (char) => char !== '/' }
        : {});
      await change('/');
      expect(current.isOpen).toBe(false);
      await render({ value: '/', triggerChars: ['@', '/'], isTriggerEnabled: () => true });
      expect(current.isOpen).toBe(true);
      expect(current.activeTriggerChar).toBe('/');
      expect(current.query).toBe('');
      expect(current.selectedIndex).toBe(0);
      expect(current.dropdownPosition).not.toBeNull();
      expect(onValueChange).toHaveBeenCalledExactlyOnceWith('/');
      expect(textarea.value).toBe('/');
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([1, 1]);
      expect(document.activeElement).toBe(textarea);
    }
  );

  it('uses current selection text before its parent commits the changed value', async () => {
    await render({ triggerChars: ['@', '/'] });
    const beforeValueCommit = current.handleSelect;
    await change('/');
    expect(rules.value).toBe('');
    expect(current.isOpen).toBe(true);
    await act(async () => beforeValueCommit(selectEvent()));
    expect(current.isOpen).toBe(true);
    expect(current.activeTriggerChar).toBe('/');
    expect(current.query).toBe('');
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith('/');
  });

  it('keeps explicit dismissal closed across identity rerenders and later availability', async () => {
    await render();
    await change('/');
    await act(async () => current.dismiss());
    await render({ triggerChars: ['@'], isTriggerEnabled: () => true });
    expect(current.isOpen).toBe(false);
    await render({ triggerChars: ['@', '/'], isTriggerEnabled: () => true });
    expect(current.isOpen).toBe(false);
    await change('/c');
    expect(current.isOpen).toBe(true);
    await act(async () => current.dismiss());
    await render({ triggerChars: ['/', '@', '/'], isTriggerEnabled: () => true });
    expect(current.isOpen).toBe(false);
    expect(current.dropdownPosition).toBeNull();
    expect(onValueChange.mock.calls).toEqual([['/'], ['/c']]);
  });

  it('cancels pending input on closed-menu Escape without consuming the key', async () => {
    await render();
    await change('/');
    const event = keyboard('Escape');
    const select = vi.fn();
    await act(async () => current.handleKeyDown(event, 0, select));
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    await render({ triggerChars: ['@', '/'] });
    expect(current.isOpen).toBe(false);
    await change('/c');
    expect(current.isOpen).toBe(true);
  });

  it.each(['text', 'caret', 'range', 'element', 'disconnected', 'blur', 'readonly', 'disabled'])(
    'refuses deferred activation after a %s mismatch',
    async (kind) => {
      await render();
      await change('/');
      if (kind === 'text') textarea.value = '/changed';
      if (kind === 'caret') textarea.setSelectionRange(0, 0);
      if (kind === 'range') textarea.setSelectionRange(0, 1);
      if (kind === 'element') {
        const replacement = document.createElement('textarea');
        replacement.value = '/';
        container.append(replacement);
        replacement.focus();
        replacement.setSelectionRange(1, 1);
        textareaRef.current = replacement;
      }
      if (kind === 'disconnected') textarea.remove();
      if (kind === 'blur') textarea.blur();
      if (kind === 'readonly') textarea.readOnly = true;
      if (kind === 'disabled') textarea.disabled = true;
      const text = textarea.value;
      const selection = [textarea.selectionStart, textarea.selectionEnd];
      const focused = document.activeElement;
      await render({ triggerChars: ['@', '/'] });
      expect(current.isOpen).toBe(false);
      expect(current.dropdownPosition).toBeNull();
      expect(onValueChange).toHaveBeenCalledExactlyOnceWith('/');
      expect(textarea.value).toBe(text);
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual(selection);
      expect(document.activeElement).toBe(focused);
    }
  );

  it('preserves @ file paths when slash commands are not supported', async () => {
    await render({ triggerChars: ['@'] });
    await change('@src/file');
    expect(current.isOpen).toBe(true);
    expect(current.activeTriggerChar).toBe('@');
    expect(current.query).toBe('src/file');
  });

  it.each(['plain text', 'hello /', '/complete '])(
    'keeps original trigger validation for %s',
    async (text) => {
      await render();
      await change(text);
      await render({ triggerChars: ['@', '/'] });
      expect(current.isOpen).toBe(false);
      expect(current.activeTriggerChar).toBeNull();
      expect(onValueChange).toHaveBeenCalledExactlyOnceWith(text);
    }
  );

  it('preserves navigation index on repeated select and resets it on changed text', async () => {
    await render();
    await change('@a');
    const select = vi.fn();
    await act(async () => current.handleKeyDown(keyboard('ArrowDown'), 3, select));
    expect(current.selectedIndex).toBe(1);
    await act(async () => current.handleSelect(selectEvent()));
    expect(current.selectedIndex).toBe(1);
    for (const expected of [2, 0]) {
      await act(async () => current.handleKeyDown(keyboard('ArrowDown'), 3, select));
      expect(current.selectedIndex).toBe(expected);
    }
    await act(async () => current.handleKeyDown(keyboard('ArrowUp'), 3, select));
    expect(current.selectedIndex).toBe(2);
    const enter = keyboard('Enter');
    await act(async () => current.handleKeyDown(enter, 3, select));
    expect(select).toHaveBeenCalledExactlyOnceWith(2);
    expect(enter.preventDefault).toHaveBeenCalledOnce();
    expect(enter.stopPropagation).toHaveBeenCalledOnce();
    await change('@b');
    expect(current.selectedIndex).toBe(0);
  });

  it.each(['isComposing', 'keyCode229'])(
    'preserves pending and active input for IME %s keys',
    async (mode) => {
      await render();
      await change('/');
      const select = vi.fn();
      const pressIme = async (count: number) => {
        for (const key of ['ArrowDown', 'Enter', 'Escape']) {
          const event = keyboard(key, mode === 'isComposing', mode === 'keyCode229' ? 229 : 0);
          await act(async () => current.handleKeyDown(event, count, select));
          expect(event.preventDefault).not.toHaveBeenCalled();
          expect(event.stopPropagation).not.toHaveBeenCalled();
        }
        expect(select).not.toHaveBeenCalled();
        expect(current.selectedIndex).toBe(0);
      };
      await pressIme(0);
      await render({ triggerChars: ['@', '/'] });
      expect(current.isOpen).toBe(true);
      await pressIme(3);
      expect(current.isOpen).toBe(true);
      expect(textarea.value).toBe('/');
      expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([1, 1]);
      expect(onValueChange).toHaveBeenCalledExactlyOnceWith('/');
    }
  );
});
