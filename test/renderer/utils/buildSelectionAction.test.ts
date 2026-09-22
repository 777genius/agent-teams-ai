import { describe, expect, it } from 'vitest';

import {
  buildFileAction,
  buildSelectionAction,
  getCodeFenceLanguage,
} from '@renderer/utils/buildSelectionAction';

import type { EditorSelectionInfo } from '@shared/types/editor';

describe('getCodeFenceLanguage', () => {
  it('maps known extensions', () => {
    expect(getCodeFenceLanguage('app.ts')).toBe('typescript');
    expect(getCodeFenceLanguage('index.tsx')).toBe('tsx');
    expect(getCodeFenceLanguage('main.py')).toBe('python');
    expect(getCodeFenceLanguage('styles.css')).toBe('css');
  });

  it('returns empty string for unknown extension', () => {
    expect(getCodeFenceLanguage('data.xyz')).toBe('');
    expect(getCodeFenceLanguage('file')).toBe('');
  });
});

describe('buildSelectionAction', () => {
  const info: EditorSelectionInfo = {
    text: 'const x = 1;',
    filePath: '/project/src/auth.ts',
    fromLine: 10,
    toLine: 15,
    screenRect: { top: 0, right: 0, bottom: 0 },
  };

  it('builds action with correct type and file info', () => {
    const action = buildSelectionAction('createTask', info);
    expect(action.type).toBe('createTask');
    expect(action.filePath).toBe('/project/src/auth.ts');
    expect(action.fromLine).toBe(10);
    expect(action.toLine).toBe(15);
    expect(action.selectedText).toBe('const x = 1;');
  });

  it('formats context with line range', () => {
    const action = buildSelectionAction('sendMessage', info);
    expect(action.formattedContext).toContain('**auth.ts**');
    expect(action.formattedContext).toContain('lines 10-15');
    expect(action.formattedContext).toContain('```typescript');
    expect(action.formattedContext).toContain('const x = 1;');
  });

  it('uses singular "line" for single-line selection', () => {
    const singleLine: EditorSelectionInfo = { ...info, fromLine: 42, toLine: 42 };
    const action = buildSelectionAction('createTask', singleLine);
    expect(action.formattedContext).toContain('line 42');
    expect(action.formattedContext).not.toContain('lines');
  });
});

describe('buildFileAction', () => {
  it('builds action with null lines, empty selectedText, and displayPath', () => {
    const action = buildFileAction('createTask', '/project/src/auth.ts', '/project');
    expect(action.type).toBe('createTask');
    expect(action.filePath).toBe('/project/src/auth.ts');
    expect(action.fromLine).toBeNull();
    expect(action.toLine).toBeNull();
    expect(action.selectedText).toBe('');
    expect(action.displayPath).toBe('src/auth.ts');
  });

  it('uses relative path when inside projectPath', () => {
    const action = buildFileAction('sendMessage', '/project/src/utils/auth.ts', '/project');
    expect(action.formattedContext).toBe('**auth.ts** (`src/utils/auth.ts`)');
  });

  it('uses absolute path when projectPath is null', () => {
    const action = buildFileAction('sendMessage', '/project/src/auth.ts', null);
    expect(action.formattedContext).toBe('**auth.ts** (`/project/src/auth.ts`)');
  });

  it('uses absolute path when projectPath is undefined', () => {
    const action = buildFileAction('createTask', '/project/src/auth.ts');
    expect(action.formattedContext).toBe('**auth.ts** (`/project/src/auth.ts`)');
  });

  it('uses absolute path when file is outside project', () => {
    const action = buildFileAction('sendMessage', '/other/config.json', '/project');
    expect(action.formattedContext).toBe('**config.json** (`/other/config.json`)');
  });

  it('handles file at project root', () => {
    const action = buildFileAction('createTask', '/project/package.json', '/project');
    expect(action.formattedContext).toBe('**package.json** (`package.json`)');
  });
});
