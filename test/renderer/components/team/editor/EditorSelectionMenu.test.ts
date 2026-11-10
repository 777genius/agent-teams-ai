/**
 * Unit tests for EditorSelectionMenu positioning logic
 * and buildSelectionAction helper.
 *
 * Since @testing-library/react is not available in this project,
 * we test the positioning logic and the real buildSelectionAction directly.
 */

import { describe, expect, it } from 'vitest';

import { buildSelectionAction, getCodeFenceLanguage } from '@renderer/utils/buildSelectionAction';

import type { EditorSelectionInfo } from '@shared/types/editor';

// ---------------------------------------------------------------------------
// buildSelectionAction (real import, not a copy)
// ---------------------------------------------------------------------------

describe('buildSelectionAction', () => {
  const baseInfo: EditorSelectionInfo = {
    text: 'const x = 42;',
    filePath: '/project/src/main.ts',
    fromLine: 10,
    toLine: 10,
    screenRect: { top: 100, right: 200, bottom: 120 },
  };

  it('builds sendMessage action with code fence', () => {
    const action = buildSelectionAction('sendMessage', baseInfo);

    expect(action.type).toBe('sendMessage');
    expect(action.filePath).toBe('/project/src/main.ts');
    expect(action.fromLine).toBe(10);
    expect(action.toLine).toBe(10);
    expect(action.selectedText).toBe('const x = 42;');
    expect(action.formattedContext).toBe(
      '**main.ts** (line 10):\n```typescript\nconst x = 42;\n```'
    );
  });

  it('builds createTask action', () => {
    const action = buildSelectionAction('createTask', baseInfo);

    expect(action.type).toBe('createTask');
    expect(action.formattedContext).toContain('```typescript');
  });

  it('formats multi-line selection range', () => {
    const info = { ...baseInfo, fromLine: 5, toLine: 15 };
    const action = buildSelectionAction('sendMessage', info);

    expect(action.formattedContext).toContain('lines 5-15');
  });

  it('detects language from file extension', () => {
    const pyInfo = { ...baseInfo, filePath: '/project/script.py' };
    const action = buildSelectionAction('sendMessage', pyInfo);

    expect(action.formattedContext).toContain('```python');
    expect(action.formattedContext).toContain('**script.py**');
  });

  it('handles unknown file extensions gracefully', () => {
    const unknownInfo = { ...baseInfo, filePath: '/project/data.xyz' };
    const action = buildSelectionAction('sendMessage', unknownInfo);

    // Empty language string → plain code block
    expect(action.formattedContext).toContain('```\n');
  });
});

// ---------------------------------------------------------------------------
// getCodeFenceLanguage
// ---------------------------------------------------------------------------

describe('getCodeFenceLanguage', () => {
  it('maps common extensions to lowercase code fence identifiers', () => {
    expect(getCodeFenceLanguage('app.ts')).toBe('typescript');
    expect(getCodeFenceLanguage('component.tsx')).toBe('tsx');
    expect(getCodeFenceLanguage('index.js')).toBe('javascript');
    expect(getCodeFenceLanguage('main.py')).toBe('python');
    expect(getCodeFenceLanguage('lib.rs')).toBe('rust');
    expect(getCodeFenceLanguage('main.go')).toBe('go');
    expect(getCodeFenceLanguage('style.css')).toBe('css');
    expect(getCodeFenceLanguage('page.html')).toBe('html');
    expect(getCodeFenceLanguage('config.yaml')).toBe('yaml');
    expect(getCodeFenceLanguage('config.yml')).toBe('yaml');
    expect(getCodeFenceLanguage('script.sh')).toBe('bash');
  });

  it('returns empty string for unknown extensions', () => {
    expect(getCodeFenceLanguage('data.xyz')).toBe('');
    expect(getCodeFenceLanguage('file')).toBe('');
  });

  it('is case-insensitive for extensions', () => {
    expect(getCodeFenceLanguage('App.TS')).toBe('typescript');
    expect(getCodeFenceLanguage('Main.PY')).toBe('python');
  });
});

// ---------------------------------------------------------------------------
// EditorSelectionInfo type shape
// ---------------------------------------------------------------------------

describe('EditorSelectionInfo type', () => {
  it('has expected shape', () => {
    const info: EditorSelectionInfo = {
      text: 'hello',
      filePath: '/a/b.ts',
      fromLine: 1,
      toLine: 1,
      screenRect: { top: 0, right: 0, bottom: 0 },
    };

    expect(info.text).toBe('hello');
    expect(info.screenRect).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Menu positioning logic (mirrors EditorSelectionMenu.tsx)
// ---------------------------------------------------------------------------

describe('Menu positioning logic', () => {
  const MENU_GAP = 8;
  const MENU_WIDTH = 68;
  const MENU_HEIGHT = 32;

  function computeMenuPosition(
    info: EditorSelectionInfo,
    containerRect: { top: number; left: number; width: number; height: number }
  ): { top: number; left: number } | null {
    // Check visibility
    const selBottomInContainer = info.screenRect.bottom - containerRect.top;
    const selTopInContainer = info.screenRect.top - containerRect.top;
    if (selBottomInContainer < 0 || selTopInContainer > containerRect.height) {
      return null; // hidden
    }

    const rawTop = info.screenRect.top - containerRect.top;
    const rawLeft = info.screenRect.right - containerRect.left + MENU_GAP;

    const top = Math.max(0, Math.min(rawTop, containerRect.height - MENU_HEIGHT));
    const left =
      rawLeft + MENU_WIDTH > containerRect.width
        ? info.screenRect.right - containerRect.left - MENU_WIDTH - MENU_GAP
        : rawLeft;

    return { top, left: Math.max(0, left) };
  }

  it('positions menu to the right of selection', () => {
    const info: EditorSelectionInfo = {
      text: 'x',
      filePath: '/a.ts',
      fromLine: 1,
      toLine: 1,
      screenRect: { top: 100, right: 200, bottom: 120 },
    };
    const container = { top: 50, left: 50, width: 600, height: 400 };

    const pos = computeMenuPosition(info, container);
    expect(pos).not.toBeNull();
    // top = 100 - 50 = 50
    expect(pos!.top).toBe(50);
    // left = 200 - 50 + 8 = 158
    expect(pos!.left).toBe(158);
  });

  it('returns null when selection is above container', () => {
    const info: EditorSelectionInfo = {
      text: 'x',
      filePath: '/a.ts',
      fromLine: 1,
      toLine: 1,
      screenRect: { top: 10, right: 200, bottom: 30 },
    };
    const container = { top: 50, left: 50, width: 600, height: 400 };

    expect(computeMenuPosition(info, container)).toBeNull();
  });

  it('returns null when selection is below container', () => {
    const info: EditorSelectionInfo = {
      text: 'x',
      filePath: '/a.ts',
      fromLine: 1,
      toLine: 1,
      screenRect: { top: 500, right: 200, bottom: 520 },
    };
    const container = { top: 50, left: 50, width: 600, height: 400 };

    expect(computeMenuPosition(info, container)).toBeNull();
  });

  it('clamps top to prevent overflow below container', () => {
    const info: EditorSelectionInfo = {
      text: 'x',
      filePath: '/a.ts',
      fromLine: 1,
      toLine: 1,
      screenRect: { top: 430, right: 200, bottom: 445 },
    };
    const container = { top: 50, left: 50, width: 600, height: 400 };

    const pos = computeMenuPosition(info, container);
    expect(pos).not.toBeNull();
    // rawTop = 430-50 = 380, max = 400-32 = 368 → clamped to 368
    expect(pos!.top).toBe(368);
  });

  it('flips menu to left when it would overflow right', () => {
    const info: EditorSelectionInfo = {
      text: 'x',
      filePath: '/a.ts',
      fromLine: 1,
      toLine: 1,
      screenRect: { top: 100, right: 620, bottom: 120 },
    };
    const container = { top: 50, left: 50, width: 600, height: 400 };

    const pos = computeMenuPosition(info, container);
    expect(pos).not.toBeNull();
    // rawLeft = 620-50+8 = 578, 578+68=646 > 600 → flip
    // flipped = 620-50-68-8 = 494
    expect(pos!.left).toBe(494);
  });
});
