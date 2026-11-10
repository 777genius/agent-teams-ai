import { beforeEach, describe, expect, it } from 'vitest';

import {
  formatModifierShortcut,
  getModifierKeyName,
  getModifierKeySymbol,
  isMacOS,
  physicalKey,
} from '../../../src/renderer/utils/keyboardUtils';

describe('keyboardUtils', () => {
  describe('isMacOS', () => {
    beforeEach(() => {
      // Reset userAgent before each test
      Object.defineProperty(navigator, 'userAgent', {
        writable: true,
        configurable: true,
        value: '',
      });
    });

    it('should return true when userAgent contains "mac"', () => {
      Object.defineProperty(navigator, 'userAgent', {
        writable: true,
        configurable: true,
        value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      });
      expect(isMacOS()).toBe(true);
    });

    it('should return false when userAgent does not contain "mac"', () => {
      Object.defineProperty(navigator, 'userAgent', {
        writable: true,
        configurable: true,
        value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      });
      expect(isMacOS()).toBe(false);
    });

    it('should be case-insensitive', () => {
      Object.defineProperty(navigator, 'userAgent', {
        writable: true,
        configurable: true,
        value: 'Mozilla/5.0 (MAC OS)',
      });
      expect(isMacOS()).toBe(true);
    });
  });

  describe('getModifierKeyName', () => {
    it('should return "Cmd" on macOS', () => {
      Object.defineProperty(navigator, 'userAgent', {
        writable: true,
        configurable: true,
        value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      });
      expect(getModifierKeyName()).toBe('Cmd');
    });

    it('should return "Ctrl" on Windows', () => {
      Object.defineProperty(navigator, 'userAgent', {
        writable: true,
        configurable: true,
        value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      });
      expect(getModifierKeyName()).toBe('Ctrl');
    });

    it('should return "Ctrl" on Linux', () => {
      Object.defineProperty(navigator, 'userAgent', {
        writable: true,
        configurable: true,
        value: 'Mozilla/5.0 (X11; Linux x86_64)',
      });
      expect(getModifierKeyName()).toBe('Ctrl');
    });
  });

  describe('getModifierKeySymbol', () => {
    it('should return "⌘" on macOS', () => {
      Object.defineProperty(navigator, 'userAgent', {
        writable: true,
        configurable: true,
        value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      });
      expect(getModifierKeySymbol()).toBe('⌘');
    });

    it('should return "Ctrl" on Windows', () => {
      Object.defineProperty(navigator, 'userAgent', {
        writable: true,
        configurable: true,
        value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      });
      expect(getModifierKeySymbol()).toBe('Ctrl');
    });

    it('should return "Ctrl" on Linux', () => {
      Object.defineProperty(navigator, 'userAgent', {
        writable: true,
        configurable: true,
        value: 'Mozilla/5.0 (X11; Linux x86_64)',
      });
      expect(getModifierKeySymbol()).toBe('Ctrl');
    });
  });

  describe('formatModifierShortcut', () => {
    describe('macOS', () => {
      beforeEach(() => {
        Object.defineProperty(navigator, 'userAgent', {
          writable: true,
          configurable: true,
          value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        });
      });

      it('should format with symbol by default', () => {
        expect(formatModifierShortcut('K')).toBe('⌘K');
      });

      it('should format with text when useSymbol is false', () => {
        expect(formatModifierShortcut('K', false)).toBe('Cmd+K');
      });

      it('should work with different keys', () => {
        expect(formatModifierShortcut('G')).toBe('⌘G');
        expect(formatModifierShortcut('S')).toBe('⌘S');
        expect(formatModifierShortcut('Enter')).toBe('⌘Enter');
      });
    });

    describe('Windows/Linux', () => {
      beforeEach(() => {
        Object.defineProperty(navigator, 'userAgent', {
          writable: true,
          configurable: true,
          value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        });
      });

      it('should format with symbol by default', () => {
        expect(formatModifierShortcut('K')).toBe('Ctrl+K');
      });

      it('should format with text when useSymbol is false', () => {
        expect(formatModifierShortcut('K', false)).toBe('Ctrl+K');
      });

      it('should work with different keys', () => {
        expect(formatModifierShortcut('G')).toBe('Ctrl+G');
        expect(formatModifierShortcut('S')).toBe('Ctrl+S');
        expect(formatModifierShortcut('Enter')).toBe('Ctrl+Enter');
      });

      it('should always include + separator', () => {
        expect(formatModifierShortcut('K')).toContain('+');
        expect(formatModifierShortcut('K', false)).toContain('+');
      });
    });
  });

  describe('physicalKey', () => {
    function makeEvent(
      key: string,
      code: string,
      mods: Partial<KeyboardEventInit> = {}
    ): KeyboardEvent {
      return new KeyboardEvent('keydown', { key, code, ...mods, bubbles: true, cancelable: true });
    }

    describe('letter keys — English layout', () => {
      it('resolves KeyF to f', () => {
        expect(physicalKey(makeEvent('f', 'KeyF'))).toBe('f');
      });

      it('resolves KeyW to w', () => {
        expect(physicalKey(makeEvent('w', 'KeyW'))).toBe('w');
      });

      it('always returns lowercase even with Shift', () => {
        expect(physicalKey(makeEvent('F', 'KeyF', { shiftKey: true }))).toBe('f');
      });
    });

    describe('letter keys — Russian layout', () => {
      it('resolves Cyrillic а (physical F) to f', () => {
        expect(physicalKey(makeEvent('а', 'KeyF'))).toBe('f');
      });

      it('resolves Cyrillic ц (physical W) to w', () => {
        expect(physicalKey(makeEvent('ц', 'KeyW'))).toBe('w');
      });

      it('resolves Cyrillic з (physical P) to p', () => {
        expect(physicalKey(makeEvent('з', 'KeyP'))).toBe('p');
      });

      it('resolves Cyrillic и (physical B) to b', () => {
        expect(physicalKey(makeEvent('и', 'KeyB'))).toBe('b');
      });

      it('resolves Cyrillic л (physical K) to k', () => {
        expect(physicalKey(makeEvent('л', 'KeyK'))).toBe('k');
      });

      it('resolves Cyrillic ы (physical S) to s', () => {
        expect(physicalKey(makeEvent('ы', 'KeyS'))).toBe('s');
      });
    });

    describe('digit keys', () => {
      it('resolves Digit1 to 1', () => {
        expect(physicalKey(makeEvent('1', 'Digit1'))).toBe('1');
      });

      it('resolves Digit9 to 9', () => {
        expect(physicalKey(makeEvent('9', 'Digit9'))).toBe('9');
      });

      it('resolves shifted digit (e.g. !) back to digit', () => {
        expect(physicalKey(makeEvent('!', 'Digit1', { shiftKey: true }))).toBe('1');
      });
    });

    describe('punctuation keys', () => {
      it('resolves BracketLeft to [', () => {
        expect(physicalKey(makeEvent('[', 'BracketLeft'))).toBe('[');
      });

      it('resolves Russian х (physical [) to [', () => {
        expect(physicalKey(makeEvent('х', 'BracketLeft'))).toBe('[');
      });

      it('resolves BracketRight to ]', () => {
        expect(physicalKey(makeEvent(']', 'BracketRight'))).toBe(']');
      });

      it('resolves Backslash to \\', () => {
        expect(physicalKey(makeEvent('\\', 'Backslash'))).toBe('\\');
      });

      it('resolves Comma to ,', () => {
        expect(physicalKey(makeEvent(',', 'Comma'))).toBe(',');
        // Russian: physical , produces б
        expect(physicalKey(makeEvent('б', 'Comma'))).toBe(',');
      });
    });

    describe('special keys (pass-through)', () => {
      it('returns event.key for Tab', () => {
        expect(physicalKey(makeEvent('Tab', 'Tab'))).toBe('Tab');
      });

      it('returns event.key for Enter', () => {
        expect(physicalKey(makeEvent('Enter', 'Enter'))).toBe('Enter');
      });

      it('returns event.key for Escape', () => {
        expect(physicalKey(makeEvent('Escape', 'Escape'))).toBe('Escape');
      });

      it('returns event.key for Arrow keys', () => {
        expect(physicalKey(makeEvent('ArrowUp', 'ArrowUp'))).toBe('ArrowUp');
        expect(physicalKey(makeEvent('ArrowDown', 'ArrowDown'))).toBe('ArrowDown');
      });
    });
  });
});
