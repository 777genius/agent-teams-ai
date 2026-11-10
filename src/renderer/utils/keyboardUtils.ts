/**
 * Keyboard utility functions for platform-aware shortcuts
 */

/**
 * Detect if running on macOS
 */
export function isMacOS(): boolean {
  return navigator.userAgent.toLowerCase().includes('mac');
}

/**
 * Resolve the physical key from a keyboard event, independent of keyboard layout.
 *
 * Uses `event.code` (physical key position on a QWERTY keyboard) to determine
 * the key, so shortcuts work correctly regardless of active layout (Russian,
 * Hebrew, Arabic, etc.).
 *
 * Returns a lowercase single character for letter keys, digit for number keys,
 * the symbol for punctuation keys, or falls back to `event.key` for special
 * keys (Tab, Enter, Escape, Arrow*, etc.) which are layout-independent.
 */
export function physicalKey(e: KeyboardEvent): string {
  const { code, key } = e;

  // Letter keys: KeyA → 'a', KeyF → 'f', KeyZ → 'z'
  if (code.startsWith('Key') && code.length === 4) {
    return code[3].toLowerCase();
  }

  // Digit keys: Digit0 → '0', Digit9 → '9'
  if (code.startsWith('Digit') && code.length === 6) {
    return code[5];
  }

  // Punctuation / symbol keys
  switch (code) {
    case 'BracketLeft':
      return '[';
    case 'BracketRight':
      return ']';
    case 'Backslash':
      return '\\';
    case 'Comma':
      return ',';
    case 'Period':
      return '.';
    case 'Slash':
      return '/';
    case 'Semicolon':
      return ';';
    case 'Quote':
      return "'";
    case 'Minus':
      return '-';
    case 'Equal':
      return '=';
    case 'Backquote':
      return '`';
    default:
      // Special keys: Tab, Enter, Escape, ArrowUp, ArrowDown, Space, etc.
      return key;
  }
}

/**
 * Get the primary modifier key name for the current platform
 * @returns 'Cmd' on macOS, 'Ctrl' on other platforms
 */
export function getModifierKeyName(): string {
  return isMacOS() ? 'Cmd' : 'Ctrl';
}

/**
 * Get the primary modifier key symbol for the current platform
 * @returns '⌘' on macOS, 'Ctrl' on other platforms
 */
export function getModifierKeySymbol(): string {
  return isMacOS() ? '⌘' : 'Ctrl';
}

/**
 * Format a keyboard shortcut for display
 * @param key - The key to press (e.g., 'K', 'G', 'Enter')
 * @param useSymbol - Whether to use symbols (⌘) or text (Cmd)
 * @returns Formatted shortcut string (e.g., '⌘K' or 'Ctrl+K')
 */
export function formatModifierShortcut(key: string, useSymbol = true): string {
  const modifier = useSymbol ? getModifierKeySymbol() : getModifierKeyName();
  const separator = useSymbol && isMacOS() ? '' : '+';
  return `${modifier}${separator}${key}`;
}
