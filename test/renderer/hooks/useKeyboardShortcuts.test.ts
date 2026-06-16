import { describe, expect, it } from 'vitest';

import {
  isEditableShortcutEventTarget,
  isEditableShortcutTarget,
} from '@renderer/hooks/useKeyboardShortcuts';

describe('isEditableShortcutTarget', () => {
  it('treats native form fields as editable shortcut targets', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const select = document.createElement('select');

    expect(isEditableShortcutTarget(input)).toBe(true);
    expect(isEditableShortcutTarget(textarea)).toBe(true);
    expect(isEditableShortcutTarget(select)).toBe(true);
  });

  it('treats nested contenteditable textboxes as editable shortcut targets', () => {
    const textbox = document.createElement('div');
    textbox.setAttribute('role', 'textbox');
    const child = document.createElement('span');
    textbox.appendChild(child);

    expect(isEditableShortcutTarget(child)).toBe(true);
  });

  it('does not mark regular buttons as editable targets', () => {
    expect(isEditableShortcutTarget(document.createElement('button'))).toBe(false);
  });

  it('treats shadow DOM textareas as editable shortcut event targets', () => {
    const host = document.createElement('div');
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const textarea = document.createElement('textarea');
    shadowRoot.appendChild(textarea);
    document.body.appendChild(host);

    const event = new KeyboardEvent('keydown', {
      key: 'w',
      code: 'KeyW',
      metaKey: true,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    Object.defineProperty(event, 'composedPath', {
      value: () => [textarea, shadowRoot, host, document, window],
    });

    expect(isEditableShortcutEventTarget(event)).toBe(true);

    host.remove();
  });
});
